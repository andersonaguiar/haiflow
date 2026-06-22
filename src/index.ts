import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync, renameSync, rmSync } from "fs";
import type { ServerWebSocket, Subprocess } from "bun";
import dashboard from "./dashboard/index.html";
import {
  sanitizeSession, sanitizeId, generateId, prefixedId, tmuxName,
  validateStructural,
  isAllowedTranscriptPath, renderTemplate, recoverSessionPatch,
} from "./utils";
import { EventBus, nextRetrySchedule } from "./events";
import {
  initLedger, recordTaskStart, recordTaskFinish, queryTasks, getTask,
  extractFromTranscript, usageSince,
} from "./ledger";
import { estimateSavings } from "./pricing";
import { verifySignature, buildFramedPrompt, type IngestRecipe } from "./ingest";
import { redact } from "./redact";

const BASE_DIR = process.env.HAIFLOW_DATA_DIR ?? "/tmp/haiflow";
const PORT = Number(process.env.PORT ?? 3333);
const API_KEY = process.env.HAIFLOW_API_KEY?.trim();
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const FORCED_CWD = process.env.HAIFLOW_CWD?.trim() || null;
const ALLOW_REQUEST_CWD = (process.env.HAIFLOW_ALLOW_REQUEST_CWD ?? "true").toLowerCase() !== "false";
const ENABLE_GUARDRAILS = (process.env.HAIFLOW_GUARDRAILS ?? "true").toLowerCase() !== "false";
const GUARDRAIL_SKILL_NAME = "haiflow-guardrails";

// Watchdog: a session can otherwise sit busy forever if Claude wedges on a
// permission prompt the model can't auto-answer — the Stop hook never fires,
// so the queue never drains. TASK_TIMEOUT_SEC is an optional hard ceiling
// (0 = disabled). WAITING_GRACE_MS is how long a session flagged "waiting" by
// the Notification hook may stay blocked before the watchdog acts. Recovery
// (sending Escape + draining) defaults OFF — alert-only — because the safe
// default is to never auto-kill a task that might just be slow.
const TASK_TIMEOUT_SEC = Number(process.env.HAIFLOW_TASK_TIMEOUT_SEC ?? 0) || 0;
const WAITING_GRACE_MS = (Number(process.env.HAIFLOW_WAITING_GRACE_SEC ?? 120) || 120) * 1000;
const WATCHDOG_RECOVER = (process.env.HAIFLOW_WATCHDOG_RECOVER ?? "false").toLowerCase() === "true";
// How often the watchdog scans for wedged sessions and reaps timed-out map runs.
// Configurable mainly so tests can speed it up; 15s is plenty in production.
const WATCHDOG_INTERVAL_MS = Number(process.env.HAIFLOW_WATCHDOG_INTERVAL_MS ?? 15_000) || 15_000;

// Map-reduce: how many items one /map call may fan out, and how long a run may
// wait for stragglers before the reducer fires with whatever has come back.
const MAP_MAX_ITEMS = Number(process.env.HAIFLOW_MAP_MAX_ITEMS ?? 200) || 200;
const MAP_TIMEOUT_MS = (Number(process.env.HAIFLOW_MAP_TIMEOUT_SEC ?? 1800) || 1800) * 1000;

// Take-the-wheel: a writable browser terminal bypasses validateStructural and
// the guardrail skill, so it is gated by the API key (the operator's root trust
// boundary) and this kill-switch. Default on, since the key is already required.
const ALLOW_TAKEOVER = (process.env.HAIFLOW_ALLOW_TAKEOVER ?? "true").toLowerCase() !== "false";

// Best-effort secret redaction on every outbound text (response capture,
// pipeline messages, webhooks, chat replies). On by default for high-confidence
// credential shapes; emails are opt-in (noisier). See src/redact.ts.
const REDACT_ENABLED = (process.env.HAIFLOW_REDACT ?? "true").toLowerCase() !== "false";
const REDACT_EMAILS = (process.env.HAIFLOW_REDACT_EMAILS ?? "false").toLowerCase() === "true";
const REDACT_EXTRA: RegExp[] = (() => {
  try {
    const raw = process.env.HAIFLOW_REDACT_EXTRA;
    if (!raw) return [];
    return (JSON.parse(raw) as string[]).map((s) => new RegExp(s, "g"));
  } catch { return []; }
})();

function redactOut(text: string): { text: string; count: number } {
  if (!REDACT_ENABLED) return { text, count: 0 };
  const r = redact(text, { emails: REDACT_EMAILS, extraPatterns: REDACT_EXTRA });
  return { text: r.text, count: r.count };
}

function taskDeadline(): string | undefined {
  return TASK_TIMEOUT_SEC > 0 ? new Date(Date.now() + TASK_TIMEOUT_SEC * 1000).toISOString() : undefined;
}

// Max prompt/message size: 512KB — safely under Claude Code's ~150K usable token budget
// and under tmux/OS transport limits. The file-based fallback in sendToTmux handles delivery.
const MAX_PROMPT_SIZE = 512_000;

// Inbound webhook replay protection (markNonce) needs Redis. When Redis is
// unavailable we fail CLOSED — reject signed ingest with 503 — so a captured
// signed webhook can't be replayed without limit. Set this to true only if you
// knowingly run ingest without Redis and accept that replay risk.
const INGEST_ALLOW_WITHOUT_REDIS = (process.env.HAIFLOW_INGEST_ALLOW_WITHOUT_REDIS ?? "false").toLowerCase() === "true";

// Replay-nonce lifetime, DECOUPLED from a recipe's freshness window (maxAgeSec).
// Schemes without a signed timestamp (github, untimestamped hmac) have no
// freshness check, so this nonce is their ONLY replay defense — it must outlive
// the freshness window. A long TTL bounds how often a captured signed payload
// can be replayed (default 7 days; raise/lower with care vs Redis memory).
const INGEST_NONCE_TTL_SEC = Number(process.env.HAIFLOW_INGEST_NONCE_TTL_SEC ?? 604800) || 604800;

// Default age (hours) above which POST /sessions/prune reaps an offline session's
// state directory. Overridable per-request via the `olderThanHours` body field.
const SESSION_TTL_HOURS = Number(process.env.HAIFLOW_SESSION_TTL_HOURS ?? 24) || 24;

// Build version + boot time, surfaced at GET /version so operators can confirm
// which build a remote haiflow is running across the npm/install.sh/n8n paths.
const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(`${import.meta.dir}/../package.json`, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const STARTED_AT = new Date().toISOString();

if (!API_KEY) {
  console.error("HAIFLOW_API_KEY is required. Set it in your .env or environment.");
  process.exit(1);
}

mkdirSync(BASE_DIR, { recursive: true });
initLedger(BASE_DIR);
const eventBus = await EventBus.create(REDIS_URL);

// --- Structured logging ---

function log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

// Last-resort safety net. A single rejected promise (e.g. an un-awaited Redis
// call when the connection drops) or an async throw must not take down the
// whole orchestrator and starve every session's queue. Log and keep serving;
// the watchdog and queue drain recover session state on the next tick.
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
});
process.on("uncaughtException", (err) => {
  log("error", "uncaught_exception", {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
});

// Parse a JSON request body, returning null on malformed/empty input so handlers
// can answer a clean 400 instead of throwing an opaque 500.
async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return null; }
}

// --- Auth ---

const API_KEY_BUFFER = Buffer.from(`Bearer ${API_KEY}`);

function requireAuth(req: Request): Response | null {
  const header = req.headers.get("authorization") ?? "";
  const headerBuf = Buffer.from(header);
  // Constant-time comparison: prevent timing attacks on API key
  const match = headerBuf.length === API_KEY_BUFFER.length &&
    crypto.timingSafeEqual(headerBuf, API_KEY_BUFFER);
  if (match) return null;
  log("warn", "auth_rejected", { path: new URL(req.url).pathname });
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Headers injected by reverse proxies — presence means the request was proxied,
// not a direct local connection. Cloudflare Tunnel always adds CF-Connecting-IP.
const PROXY_HEADERS = ["cf-connecting-ip", "x-forwarded-for"];

function requireLocalhost(req: Request): Response | null {
  // Reject requests that arrived through a reverse proxy (e.g. Cloudflare Tunnel).
  // Even though cloudflared connects from localhost, these are external requests.
  for (const header of PROXY_HEADERS) {
    if (req.headers.has(header)) {
      log("warn", "hook_rejected_proxied", { path: new URL(req.url).pathname, header });
      return Response.json({ error: "Hooks are restricted to localhost" }, { status: 403 });
    }
  }

  const ip = server?.requestIP(req);
  const address = ip?.address ?? "";
  if (LOCALHOST_IPS.has(address)) return null;
  log("warn", "hook_rejected_non_local", { path: new URL(req.url).pathname, address });
  return Response.json({ error: "Hooks are restricted to localhost" }, { status: 403 });
}

function authed(handler: (req: any) => Response | Promise<Response>) {
  return (req: any): Response | Promise<Response> => {
    const err = requireAuth(req);
    if (err) return err;
    return handler(req);
  };
}

// --- Session helpers ---

type Status = "idle" | "busy" | "offline";

interface State {
  status: Status;
  since: string;
  session?: string;
  cwd?: string;
  currentPrompt?: string;
  currentTaskId?: string;
  currentChain?: string[];
  queueLength: number;
  // Watchdog fields. `waiting` is set by the Notification hook when Claude is
  // blocked needing input mid-task; `deadlineAt` is the optional hard timeout.
  waiting?: boolean;
  waitingMessage?: string;
  waitingSince?: string;
  deadlineAt?: string;
  transcriptPath?: string;
  currentDedupKey?: string;
  // Set while a human holds the wheel via the writable terminal, so auto-drain
  // doesn't fire a queued prompt on top of their typing.
  intervened?: boolean;
}

interface QueueItem {
  id: string;
  prompt: string;
  addedAt: string;
  source?: string;
  chain?: string[];
  // Smart-queue fields.
  priority?: number;     // higher drains first; default 0
  dedupKey?: string;     // a second enqueue with the same key is dropped
  notBefore?: string;    // ISO time before which the item is not eligible
}

// --- Pipeline types ---

interface PipelineSubscriber {
  session: string;
  promptTemplate: string;
  enabled?: boolean;
  priority?: number;
}

interface WebhookSubscriber {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface TopicConfig {
  description?: string;
  subscribers: PipelineSubscriber[];
  webhooks?: WebhookSubscriber[];
}

interface PoolConfig {
  // Member session names. The pool's max concurrency is its member count;
  // each member is its own tmux session (pin per-member cwds in /session/start).
  members: string[];
  description?: string;
}

interface PipelineConfig {
  topics: Record<string, TopicConfig>;
  emitters: Record<string, string[]>;
  pools: Record<string, PoolConfig>;
}

const EMPTY_PIPELINE: PipelineConfig = { topics: {}, emitters: {}, pools: {} };

let cachedPipeline: PipelineConfig | null = null;
let cachedPipelineMtime = 0;
let cachedPipelineSize = 0;

function readPipeline(): PipelineConfig {
  const file = `${BASE_DIR}/pipeline.json`;
  if (!existsSync(file)) {
    cachedPipeline = null;
    cachedPipelineMtime = 0;
    cachedPipelineSize = 0;
    return EMPTY_PIPELINE;
  }
  const stat = statSync(file);
  if (cachedPipeline && stat.mtimeMs === cachedPipelineMtime && stat.size === cachedPipelineSize) return cachedPipeline;
  try {
    const raw = readFileSync(file, "utf-8");
    const config = JSON.parse(raw);
    cachedPipeline = { topics: config.topics ?? {}, emitters: config.emitters ?? {}, pools: config.pools ?? {} };
    cachedPipelineMtime = stat.mtimeMs;
    cachedPipelineSize = stat.size;
    return cachedPipeline;
  } catch {
    log("warn", "pipeline_config_invalid", { file });
    return EMPTY_PIPELINE;
  }
}

// Inbound webhook recipes (ingest.json in HAIFLOW_DATA_DIR), re-read on change.
let cachedIngest: Record<string, IngestRecipe> | null = null;
let cachedIngestMtime = 0;
let cachedIngestSize = 0;

function readIngestConfig(): Record<string, IngestRecipe> {
  const file = `${BASE_DIR}/ingest.json`;
  if (!existsSync(file)) { cachedIngest = null; return {}; }
  const stat = statSync(file);
  if (cachedIngest && stat.mtimeMs === cachedIngestMtime && stat.size === cachedIngestSize) return cachedIngest;
  try {
    cachedIngest = JSON.parse(readFileSync(file, "utf-8")) as Record<string, IngestRecipe>;
    cachedIngestMtime = stat.mtimeMs;
    cachedIngestSize = stat.size;
    return cachedIngest;
  } catch {
    log("warn", "ingest_config_invalid", { file });
    return {};
  }
}

async function deliverToSubscribers(
  topic: string,
  topicConfig: TopicConfig,
  event: { session: string; taskId: string; message: string },
  chain: string[],
  eventId?: string
) {
  for (const sub of topicConfig.subscribers ?? []) {
    if (sub.enabled === false) {
      if (eventId) await eventBus.recordDelivery(eventId, sub.session, "session", "skipped");
      continue;
    }

    const subscriberSession = sanitizeSession(sub.session);

    // Circular protection: skip if this session is already in the chain
    if (chain.includes(subscriberSession)) {
      log("warn", "pipeline_circular_skipped", { topic, subscriber: subscriberSession, chain });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "skipped");
      continue;
    }

    const prompt = renderTemplate(sub.promptTemplate, {
      message: event.message,
      topic,
      sourceSession: event.session,
      taskId: event.taskId,
    });

    if (prompt.length > MAX_PROMPT_SIZE) {
      log("warn", "pipeline_prompt_too_large", { topic, subscriber: subscriberSession, size: prompt.length });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "skipped");
      continue;
    }

    // Hard structural block check on rendered prompt
    const validation = validateStructural(prompt);
    if (!validation.ok) {
      log("warn", "pipeline_prompt_rejected", { topic, subscriber: subscriberSession, reason: validation.reason });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "skipped");
      continue;
    }

    const taskId = generateId();

    // Reuse the single dispatch sequence (idle -> busy + send, else queue) so
    // the pipeline path can't drift from /trigger, /pool, /map and /ingest. Map
    // its outcome to the pipeline log event and the delivery status.
    const where = dispatchOrQueue(subscriberSession, prompt, {
      id: taskId, source: `pipeline:${topic}`, chain, priority: sub.priority,
    });
    if (where === "sent") {
      log("info", "pipeline_dispatched", { topic, subscriber: subscriberSession, taskId });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "delivered");
    } else {
      log(where === "queued_offline" ? "warn" : "info",
        where === "queued_offline" ? "pipeline_subscriber_offline" : "pipeline_queued",
        { topic, subscriber: subscriberSession, taskId });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "queued");
    }
  }
}

// The outbound webhook body, shared by first-delivery and the retry loop so the
// shape can't drift between them.
function buildWebhookPayload(topic: string, e: { session: string; taskId: string; message: string }) {
  return {
    topic,
    sourceSession: e.session,
    taskId: e.taskId,
    message: e.message,
    publishedAt: new Date().toISOString(),
  };
}

function postWebhook(wh: WebhookSubscriber, payload: object): Promise<Response> {
  return fetch(wh.url, {
    method: wh.method ?? "POST",
    headers: { "Content-Type": "application/json", ...wh.headers },
    body: JSON.stringify(payload),
  });
}

async function deliverToWebhooks(
  topic: string,
  topicConfig: TopicConfig,
  event: { session: string; taskId: string; message: string },
  eventId?: string
) {
  for (const wh of topicConfig.webhooks ?? []) {
    const whSubscriber = `webhook:${wh.url}`;
    if (wh.enabled === false) {
      if (eventId) await eventBus.recordDelivery(eventId, whSubscriber, "webhook", "skipped");
      continue;
    }

    const payload = buildWebhookPayload(topic, event);

    // Record the pending delivery BEFORE the fetch can resolve, so the
    // success/failure handler's updateDelivery always finds a row to update
    // (otherwise the HSET could land after the update and the transition is lost).
    if (eventId) await eventBus.recordDelivery(eventId, whSubscriber, "webhook", "pending");

    // Fire the POST without blocking the caller on slow webhooks, but
    // re-finalize the event once it resolves. handlePipelineEvent finalizes
    // while this delivery is still "pending" (event status -> "published"); if
    // we never re-finalize, the event stays stuck "published" in the unprocessed
    // set and gets replayed (re-delivered) on the next server restart.
    postWebhook(wh, payload).then(async () => {
      if (eventId) {
        await eventBus.updateDelivery(eventId, whSubscriber, { status: "delivered" });
        await eventBus.finalizeEvent(eventId);
      }
      log("info", "pipeline_webhook_sent", { topic, url: wh.url });
    }).catch(async (err) => {
      if (eventId) {
        const nextRetry = new Date(Date.now() + 60_000).toISOString();
        await eventBus.updateDelivery(eventId, whSubscriber, {
          status: "failed",
          lastError: String(err),
          nextRetryAt: nextRetry,
        });
        await eventBus.finalizeEvent(eventId);
      }
      log("error", "pipeline_webhook_failed", { topic, url: wh.url, error: String(err) });
    });
  }
}

async function handlePipelineEvent(
  topic: string,
  event: { session: string; taskId: string; message: string; chain?: string[] },
  opts?: { skipRecording?: boolean; existingEventId?: string }
) {
  const pipeline = readPipeline();
  const topicConfig = pipeline.topics[topic];
  if (!topicConfig) return;

  // Record event in Redis (skip during replay to avoid duplicates)
  const eventId = opts?.existingEventId ?? (
    opts?.skipRecording ? undefined : await eventBus.recordEvent({
      topic,
      message: event.message,
      sourceSession: event.session,
      taskId: event.taskId,
      chain: event.chain,
    })
  );

  const chain = [...(event.chain ?? []), event.session];

  await deliverToSubscribers(topic, topicConfig, event, chain, eventId);
  await deliverToWebhooks(topic, topicConfig, event, eventId);

  if (eventId) await eventBus.finalizeEvent(eventId);
}

async function publishEvent(
  topic: string,
  payload: { session: string; taskId: string; message: string; chain?: string[]; external?: boolean }
) {
  const pipeline = readPipeline();
  const topicConfig = pipeline.topics[topic];
  if (!topicConfig) {
    log("warn", "publish_unknown_topic", { topic, session: payload.session });
    return;
  }

  // Validate that this session is allowed to emit to this topic
  // "external" is always allowed (used by POST /publish)
  const allowedTopics = pipeline.emitters[payload.session] ?? [];
  if (!allowedTopics.includes(topic) && !payload.external) {
    log("warn", "publish_unauthorized", { topic, session: payload.session });
    return;
  }

  await handlePipelineEvent(topic, payload);
  log("info", "event_published", { topic, session: payload.session, taskId: payload.taskId });
}

function sessionPaths(session: string) {
  const dir = `${BASE_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  return {
    state: `${dir}/state.json`,
    queue: `${dir}/queue.json`,
    responses: `${dir}/responses`,
    sessionId: `${dir}/session-id`,
  };
}

function responseFile(session: string, id: string): string {
  const p = sessionPaths(session);
  // Route params are URL-decoded before they reach us, so encoded values like
  // "%2E%2E%2Fstate" become "../state". Reusing sanitizeId here keeps response
  // reads and writes inside the responses directory and matches trigger IDs.
  return `${p.responses}/${sanitizeId(id)}.json`;
}

// Write atomically: write a temp file in the same dir, then rename over the
// target. rename(2) is atomic on POSIX, so a reader never sees a half-written
// file and a crash mid-write can't corrupt the existing one. This is what keeps
// concurrent queue/state updates (trigger, drain, delay tick, pipeline) from
// tearing each other's writes.
function atomicWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, data); } catch {}
    try { unlinkSync(tmp); } catch {}
  }
}

function readState(session: string): State {
  const p = sessionPaths(session);
  if (!existsSync(p.state)) {
    return { status: "offline", since: new Date().toISOString(), session, queueLength: 0 };
  }
  try {
    const raw = readFileSync(p.state, "utf-8");
    const state = JSON.parse(raw);
    const queue = readQueue(session);
    return { ...state, session, queueLength: queue.length };
  } catch {
    return { status: "offline", since: new Date().toISOString(), session, queueLength: 0 };
  }
}

function writeState(session: string, updates: Partial<Omit<State, "queueLength" | "session">>) {
  const p = sessionPaths(session);
  // Merge with existing state to preserve persistent fields like cwd
  let existing: Record<string, unknown> = {};
  if (existsSync(p.state)) {
    try { existing = JSON.parse(readFileSync(p.state, "utf-8")); } catch {}
  }
  const merged = { ...existing, ...updates };
  atomicWrite(p.state, JSON.stringify(merged, null, 2));
}

function readQueue(session: string): QueueItem[] {
  const p = sessionPaths(session);
  if (!existsSync(p.queue)) return [];
  try {
    return JSON.parse(readFileSync(p.queue, "utf-8"));
  } catch {
    return [];
  }
}

function writeQueue(session: string, queue: QueueItem[]) {
  const p = sessionPaths(session);
  atomicWrite(p.queue, JSON.stringify(queue, null, 2));
}

// Pick the highest-priority eligible item from a queue. Ties break FIFO (the
// earliest-added wins). Items with a future `notBefore` are skipped until ready.
function pickNext(queue: QueueItem[]): { item: QueueItem; index: number } | null {
  const now = Date.now();
  let best = -1;
  for (let i = 0; i < queue.length; i++) {
    const it = queue[i]!;
    if (it.notBefore && Date.parse(it.notBefore) > now) continue;
    if (best === -1) { best = i; continue; }
    if ((it.priority ?? 0) > (queue[best]!.priority ?? 0)) best = i;
  }
  return best === -1 ? null : { item: queue[best]!, index: best };
}

// A dedupKey already in flight (running or queued) means this enqueue is a
// duplicate (e.g. a webhook that fired twice) and should be dropped.
function isDuplicate(session: string, dedupKey: string | undefined): boolean {
  if (!dedupKey) return false;
  const state = readState(session);
  if (state.status !== "offline" && state.currentDedupKey === dedupKey) return true;
  return readQueue(session).some((q) => q.dedupKey === dedupKey);
}

// Normalise the smart-queue fields from a request/subscriber into a partial
// QueueItem. Accepts notBefore (ISO) or delaySeconds (relative).
function queueOptions(opts: { priority?: unknown; dedupKey?: unknown; notBefore?: unknown; delaySeconds?: unknown }): {
  priority?: number; dedupKey?: string; notBefore?: string;
} {
  const priority = Number(opts.priority);
  const delay = Number(opts.delaySeconds);
  let notBefore: string | undefined;
  if (typeof opts.notBefore === "string") notBefore = opts.notBefore;
  else if (Number.isFinite(delay) && delay > 0) notBefore = new Date(Date.now() + delay * 1000).toISOString();
  return {
    priority: Number.isFinite(priority) && priority !== 0 ? priority : undefined,
    dedupKey: typeof opts.dedupKey === "string" && opts.dedupKey ? opts.dedupKey : undefined,
    notBefore,
  };
}

function getSessionId(session: string): string | null {
  const p = sessionPaths(session);
  try { return readFileSync(p.sessionId, "utf-8").trim() || null; } catch { return null; }
}

function setSessionId(session: string, id: string | null) {
  const p = sessionPaths(session);
  if (id) { writeFileSync(p.sessionId, id); }
  else { try { unlinkSync(p.sessionId); } catch {} }
}

function findSessionByClaudeId(claudeSessionId: string): string | null {
  if (!existsSync(BASE_DIR)) return null;
  for (const dir of readdirSync(BASE_DIR)) {
    const idFile = `${BASE_DIR}/${dir}/session-id`;
    try {
      const stored = readFileSync(idFile, "utf-8").trim();
      if (stored === claudeSessionId) return dir;
    } catch {}
  }
  return null;
}

function sendToTmux(session: string, prompt: string): boolean {
  // Hard structural blocks — these break out of the orchestrator itself
  const check = validateStructural(prompt);
  if (!check.ok) {
    log("warn", "prompt_blocked", { session, reason: check.reason });
    return false;
  }

  const fullPrompt = prompt;

  const target = tmuxName(session);

  // For large prompts, write to a temp file and tell Claude to read it
  // to avoid tmux send-keys buffer limits
  if (fullPrompt.length > 2000) {
    const tmpFile = `/tmp/haiflow-prompt-${crypto.randomUUID()}.txt`;
    writeFileSync(tmpFile, fullPrompt, { mode: 0o600 });
    const shortPrompt = `Read the file ${tmpFile} and follow the instructions in it exactly.`;
    const ok = typeThenSubmit(target, shortPrompt);
    // Clean up temp file after a delay (give Claude time to read it)
    setTimeout(() => { try { unlinkSync(tmpFile); } catch {} }, 60_000);
    return ok;
  }

  return typeThenSubmit(target, fullPrompt);
}

// Large-prompt temp files (above) are normally removed by a 60s timer, but that
// timer is lost on crash/restart, leaking plaintext prompts in /tmp. Sweep any
// leftovers on boot. Returns the number removed.
// A prompt temp file is kept alive for 60s so Claude can read it. Only sweep
// files comfortably past that window (2x), so this boot sweep never deletes a
// concurrently-running or just-restarted instance's in-flight prompt.
const PROMPT_FILE_STALE_MS = 120_000;

function sweepStalePromptFiles(): number {
  let removed = 0;
  try {
    const now = Date.now();
    for (const f of readdirSync("/tmp")) {
      if (!f.startsWith("haiflow-prompt-") || !f.endsWith(".txt")) continue;
      const path = `/tmp/${f}`;
      try {
        if (now - statSync(path).mtimeMs < PROMPT_FILE_STALE_MS) continue;
        unlinkSync(path);
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

// tmux treats `send-keys "<text>" Enter` as one paste block — Enter becomes
// a newline inside the input instead of a submit. Splitting into two calls
// makes Enter arrive as a keystroke after the paste is committed.
function typeThenSubmit(target: string, text: string): boolean {
  const typed = Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", text]);
  if (typed.exitCode !== 0) return false;
  const submitted = Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
  return submitted.exitCode === 0;
}

function isTmuxRunning(session: string): boolean {
  const result = Bun.spawnSync(["tmux", "has-session", "-t", tmuxName(session)]);
  return result.exitCode === 0;
}

// Send a control key into the session's TUI. Escape cancels Claude's current
// generation/tool use and returns control without exiting; Ctrl-C is harsher
// and can quit the CLI, so Escape is the default. Shared by POST /interrupt,
// the watchdog, and task cancellation.
function sendInterrupt(session: string, mode: "escape" | "ctrl-c" = "escape"): boolean {
  if (!isTmuxRunning(session)) return false;
  const target = tmuxName(session);
  const key = mode === "ctrl-c" ? "C-c" : "Escape";
  return Bun.spawnSync(["tmux", "send-keys", "-t", target, key]).exitCode === 0;
}

// Persist the response for a finished task. `messages` are the assistant text
// blocks already mined from the transcript by extractFromTranscript (the same
// parse the ledger uses), so there is no second jq/transcript pass here.
// Note: extractFromTranscript windows from the genuine prompt (skipping
// tool_result-only user turns), so `messages` holds every assistant text block
// of the task — including intermediate prose, not only the final answer. This
// is intentionally more complete than the old jq (which started at the last
// tool_result); consumers like the GitHub bridge join all blocks.
function saveResponse(session: string, taskId: string, prompt?: string, messages?: string[], lastMessage?: string) {
  if (!taskId) return;
  const file = responseFile(session, taskId);

  if (messages && messages.length > 0) {
    let redactions = 0;
    const safe = messages.map((m) => { const r = redactOut(String(m)); redactions += r.count; return r.text; });
    writeFileSync(file, JSON.stringify({
      id: taskId, completed_at: new Date().toISOString(), prompt, messages: safe,
      ...(redactions > 0 ? { redactions } : {}),
    }, null, 2));
    log("info", "response_saved", { session, taskId, source: "transcript", redactions });
    return;
  }

  if (lastMessage) {
    const r = redactOut(lastMessage);
    writeFileSync(file, JSON.stringify({
      id: taskId, completed_at: new Date().toISOString(), prompt, messages: [r.text],
      ...(r.count > 0 ? { redactions: r.count } : {}),
    }, null, 2));
    log("info", "response_saved", { session, taskId, source: "fallback", redactions: r.count });
    return;
  }

  // Neither the transcript nor a last_assistant_message yielded text (e.g. the
  // task ended on tool calls with no trailing prose). Still write a definitive
  // completion so pollers on /responses/:id and SSE streams see the task finish
  // instead of hanging until their timeout (which surfaces to the GitHub bridge
  // as a false "still working" reply).
  writeFileSync(file, JSON.stringify({
    id: taskId, completed_at: new Date().toISOString(), prompt, messages: ["(no text output)"],
  }, null, 2));
  log("info", "response_saved", { session, taskId, source: "empty" });
}

function drainQueue(session: string) {
  const state = readState(session);
  if (state.status !== "idle") return;
  // A human is at the wheel via the writable terminal — don't type over them.
  if (state.intervened) return;

  const queue = readQueue(session);
  const picked = pickNext(queue);
  if (!picked) return;

  const next = picked.item;
  queue.splice(picked.index, 1);
  writeQueue(session, queue);

  writeState(session, {
    status: "busy",
    since: new Date().toISOString(),
    currentPrompt: next.prompt,
    currentTaskId: next.id,
    currentChain: next.chain,
    currentDedupKey: next.dedupKey,
    deadlineAt: taskDeadline(),
  });
  recordTaskStart({ id: next.id, session, prompt: next.prompt, source: next.source ?? "queue", chain: next.chain });

  sendToTmux(session, next.prompt);
  log("info", "queue_drained", { session, taskId: next.id, remaining: queue.length });
}

function installGuardrailSkill(): void {
  if (!ENABLE_GUARDRAILS) return;
  const home = process.env.HOME;
  if (!home) {
    log("warn", "guardrail_install_skipped", { reason: "HOME not set" });
    return;
  }
  const sourcePath = `${import.meta.dir}/skills/${GUARDRAIL_SKILL_NAME}.md`;
  let content: string;
  try {
    content = readFileSync(sourcePath, "utf8");
  } catch (err) {
    log("warn", "guardrail_template_missing", { path: sourcePath, error: String(err) });
    return;
  }
  const targetDir = `${home}/.claude/skills/${GUARDRAIL_SKILL_NAME}`;
  const targetPath = `${targetDir}/SKILL.md`;
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetPath, content);
    log("info", "guardrail_skill_installed", { path: targetPath });
  } catch (err) {
    log("warn", "guardrail_install_failed", { path: targetPath, error: String(err) });
  }
}

function injectGuardrailCommand(session: string): void {
  if (!ENABLE_GUARDRAILS) return;
  const target = tmuxName(session);
  // Mark the session busy ourselves so a /trigger arriving before the
  // prompt hook fires won't be sent on top of the slash command.
  writeState(session, { status: "busy", since: new Date().toISOString() });
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", `/${GUARDRAIL_SKILL_NAME}`]);
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
  log("info", "guardrail_command_sent", { session });
}

async function waitForGuardrailComplete(session: string, maxWait = 30_000): Promise<void> {
  if (!ENABLE_GUARDRAILS) return;
  // Give the prompt hook time to transition state to busy (if our manual
  // mark above was already overwritten) before we start polling for idle.
  await Bun.sleep(300);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const state = readState(session);
    if (state.status === "idle") return;
    await Bun.sleep(200);
  }
  log("warn", "guardrail_idle_timeout", { session });
}

async function startClaudeSession(session: string, cwd: string): Promise<{ success: boolean; error?: string }> {
  if (isTmuxRunning(session)) {
    log("info", "session_reused", { session });
    writeState(session, { status: "idle", since: new Date().toISOString(), cwd });
    return { success: true };
  }

  const result = Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", tmuxName(session), "-c", cwd,
    "-e", `HAIFLOW=1`,
    "-e", `HAIFLOW_PORT=${PORT}`,
    "claude", "--permission-mode", "auto",
  ]);

  if (result.exitCode !== 0) {
    log("error", "session_start_failed", { session, error: result.stderr.toString() });
    return { success: false, error: result.stderr.toString() };
  }

  setSessionId(session, null);
  writeState(session, { status: "idle", since: new Date().toISOString(), cwd });

  // Block until Claude's TUI is actually interactive. The session-start hook
  // fires early in boot before the input box is mounted — hook-only checks
  // aren't enough, so we also require the prompt line to appear in the pane.
  const target = tmuxName(session);
  const maxWait = 15_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (getSessionId(session) && isTuiInteractive(target)) {
      log("info", "session_started", { session, cwd, readyMs: Date.now() - start });
      injectGuardrailCommand(session);
      await waitForGuardrailComplete(session);
      return { success: true };
    }
    await Bun.sleep(100);
  }

  log("info", "session_started", { session, cwd, note: "ready timeout — session may still be initializing" });
  injectGuardrailCommand(session);
  await waitForGuardrailComplete(session);
  return { success: true };
}

function isTuiInteractive(target: string): boolean {
  const pane = Bun.spawnSync(["tmux", "capture-pane", "-t", target, "-p"]);
  if (pane.exitCode !== 0) return false;
  // Claude's input box renders a `❯ ` prompt marker once the TUI is mounted.
  return pane.stdout.toString().includes("❯");
}

function stopClaudeSession(session: string): { success: boolean; error?: string } {
  if (!isTmuxRunning(session)) {
    return { success: false, error: `tmux session '${tmuxName(session)}' not found` };
  }

  // Get the exact PIDs running inside the tmux panes before killing
  const paneProcs = Bun.spawnSync([
    "tmux", "list-panes", "-t", tmuxName(session), "-F", "#{pane_pid}",
  ]);
  const panePids = paneProcs.stdout.toString().trim().split("\n").filter(Boolean);

  // Kill the tmux session (sends SIGHUP to processes inside)
  Bun.spawnSync(["tmux", "kill-session", "-t", tmuxName(session)]);

  // Kill the specific pane processes if they survived the SIGHUP
  for (const pid of panePids) {
    Bun.spawnSync(["kill", "-9", pid]);
  }

  setSessionId(session, null);
  writeState(session, { status: "offline", since: new Date().toISOString() });
  log("info", "session_stopped", { session });
  return { success: true };
}

function getSessionParam(req: Request): string {
  const url = new URL(req.url);
  return sanitizeSession(url.searchParams.get("session") ?? "default");
}

function listSessions(): { session: string; status: Status; tmux: string }[] {
  if (!existsSync(BASE_DIR)) return [];
  return readdirSync(BASE_DIR)
    .filter((d) => existsSync(`${BASE_DIR}/${d}/state.json`))
    .map((d) => {
      const state = readState(d);
      return { session: d, status: state.status, tmux: tmuxName(d) };
    });
}

// --- Worker pools & map-reduce ---
//
// A pool is a set of member sessions that share work. POST /pool/:name/trigger
// load-balances one prompt across idle members; POST /map fans a list of items
// across the pool in parallel and fires a reducer once every item comes back —
// the fan-in / JOIN. Run state is kept in-process (runs are short-lived); it
// does not survive a server restart, which is fine for a batch job.

interface MapRun {
  runId: string;
  pool: string;
  total: number;
  collected: Record<number, string>;
  reduce?: { session: string; promptTemplate: string };
  reduceTaskId?: string;
  source?: string;
  createdAt: number;
  reduced: boolean;
  // taskIds of dispatched shards, so finishMapRun can clear their taskToMap
  // entries even if some shards never reported (offline/wedged/cancelled).
  shardTaskIds: string[];
}

const mapRuns = new Map<string, MapRun>();
const taskToMap = new Map<string, { runId: string; index: number }>();

// Send to a session if idle, else queue it. Used by pool dispatch and the
// reducer. Returns where the work landed.
function dispatchOrQueue(
  session: string,
  prompt: string,
  opts: { id: string; source?: string; chain?: string[]; priority?: number }
): "sent" | "queued" | "queued_offline" {
  const state = readState(session);

  if (state.status === "idle") {
    writeState(session, {
      status: "busy", since: new Date().toISOString(),
      currentPrompt: prompt, currentTaskId: opts.id, currentChain: opts.chain,
      deadlineAt: taskDeadline(),
    });
    recordTaskStart({ id: opts.id, session, prompt, source: opts.source, chain: opts.chain });
    sendToTmux(session, prompt);
    return "sent";
  }

  const queue = readQueue(session);
  queue.push({ id: opts.id, prompt, addedAt: new Date().toISOString(), source: opts.source, chain: opts.chain, priority: opts.priority });
  writeQueue(session, queue);
  return state.status === "offline" ? "queued_offline" : "queued";
}

// Pick the member to hand the next item to: an idle one if any, otherwise the
// one with the shortest queue (least loaded). Synchronous, so within one event
// loop turn two dispatches can't claim the same idle member.
function pickPoolMember(members: string[]): { session: string; idle: boolean } | null {
  let leastLoaded: { session: string; load: number } | null = null;
  for (const m of members) {
    const state = readState(m);
    if (state.status === "idle") return { session: m, idle: true };
    if (state.status === "offline") continue;
    const load = state.queueLength;
    if (!leastLoaded || load < leastLoaded.load) leastLoaded = { session: m, load };
  }
  if (leastLoaded) return { session: leastLoaded.session, idle: false };
  // Everyone offline — fall back to the first member so the work queues somewhere.
  return members.length > 0 ? { session: members[0]!, idle: false } : null;
}

function formatMapResults(run: MapRun): string {
  const parts: string[] = [];
  for (let i = 0; i < run.total; i++) {
    parts.push(`### Result ${i + 1} of ${run.total}\n${run.collected[i] ?? "(no output)"}`);
  }
  return parts.join("\n\n");
}

// Called from the Stop hook: if the finished task belongs to a map run, record
// its output and fire the reducer once every item is in (or on timeout).
function collectMapResult(taskId: string, output: string) {
  const slot = taskToMap.get(taskId);
  if (!slot) return;
  taskToMap.delete(taskId);
  const run = mapRuns.get(slot.runId);
  if (!run || run.reduced) return;

  run.collected[slot.index] = output;
  const done = Object.keys(run.collected).length;
  log("info", "map_progress", { runId: run.runId, done, total: run.total });
  if (done >= run.total) finishMapRun(run, false);
}

function finishMapRun(run: MapRun, partial: boolean) {
  if (run.reduced) return;
  run.reduced = true;
  // Reap any shard->run mappings that never resolved, so a partially-completed
  // run doesn't leak taskToMap entries forever.
  for (const taskId of run.shardTaskIds) taskToMap.delete(taskId);
  log(partial ? "warn" : "info", partial ? "map_reduced_partial" : "map_reduced", {
    runId: run.runId, collected: Object.keys(run.collected).length, total: run.total,
  });

  if (!run.reduce) return;
  const results = formatMapResults(run);
  const prompt = renderTemplate(run.reduce.promptTemplate, {
    results, total: String(run.total), pool: run.pool, runId: run.runId,
  });
  if (prompt.length > MAX_PROMPT_SIZE) {
    log("warn", "map_reduce_prompt_too_large", { runId: run.runId, size: prompt.length });
    return;
  }
  const check = validateStructural(prompt);
  if (!check.ok) {
    log("warn", "map_reduce_rejected", { runId: run.runId, reason: check.reason });
    return;
  }
  const reduceTaskId = generateId();
  run.reduceTaskId = reduceTaskId;
  dispatchOrQueue(run.reduce.session, prompt, { id: reduceTaskId, source: `map:${run.runId}` });
}

// Data carried on each take-the-wheel terminal WebSocket. Typing this lets Bun
// infer the upgrade data type and keeps ws.data.* fully checked.
interface TerminalWSData {
  session: string;
  control: boolean;
  proc?: Subprocess<"pipe" | "ignore", "pipe", "ignore">;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

const server = Bun.serve({
  port: PORT,
  routes: {
    "/sessions": {
      GET: authed(() => Response.json(listSessions())),
    },

    "/status": {
      GET: authed((req) => Response.json(readState(getSessionParam(req)))),
    },

    // Hook doctor: the #1 silent failure is a session that is busy forever
    // because the Stop hook never fires. The tell is a running tmux with no
    // linked Claude session-id — the SessionStart hook never reached us, so the
    // hooks aren't wired. Reports per-session (or all sessions) health.
    "/doctor": {
      GET: authed((req) => {
        const url = new URL(req.url);
        const param = url.searchParams.get("session");
        const check = (session: string) => {
          const state = readState(session);
          const tmuxRunning = isTmuxRunning(session);
          const hooksLinked = !!getSessionId(session);
          return {
            session,
            status: state.status,
            since: state.since,
            cwd: state.cwd,
            tmuxRunning,
            hooksLinked,
            healthy: !tmuxRunning || hooksLinked,
            note: tmuxRunning && !hooksLinked
              ? "tmux is running but no Claude session-id is linked — the SessionStart hook never fired. Run `haiflow setup` and restart the session."
              : undefined,
            queueLength: state.queueLength,
          };
        };
        if (param) return Response.json(check(sanitizeSession(param)));
        return Response.json({ sessions: listSessions().map((s) => check(s.session)) });
      }),
    },

    "/trigger": {
      POST: authed(async (req) => {
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const prompt = body.prompt as string;
        const source = body.source as string | undefined;
        const id = body.id ? sanitizeId(body.id as string) : generateId();
        const session = sanitizeSession((body.session as string) || "default");

        if (!prompt) {
          return Response.json({ error: "prompt is required" }, { status: 400 });
        }

        if (prompt.length > MAX_PROMPT_SIZE) {
          return Response.json({ error: `prompt exceeds ${MAX_PROMPT_SIZE} character limit (512KB)` }, { status: 413 });
        }

        const validation = validateStructural(prompt);
        if (!validation.ok) {
          log("warn", "trigger_rejected", { session, taskId: id, reason: validation.reason });
          return Response.json({ error: `Prompt rejected: ${validation.reason}` }, { status: 400 });
        }

        const { priority, dedupKey, notBefore } = queueOptions(body);

        // Drop duplicates (e.g. a webhook that fired twice) before doing anything.
        if (isDuplicate(session, dedupKey)) {
          log("info", "trigger_deduped", { session, taskId: id, dedupKey });
          return Response.json({ id, session, deduped: true, message: "A task with this dedupKey is already running or queued." });
        }

        const state = readState(session);

        if (state.status === "offline") {
          return Response.json(
            { error: `Session '${session}' is offline. Start it with POST /session/start` },
            { status: 503 }
          );
        }

        const delayed = notBefore ? Date.parse(notBefore) > Date.now() : false;

        // Queue if busy, or if the item is scheduled for later (the delay tick
        // and the next drain pick it up when notBefore passes).
        if (state.status === "busy" || delayed) {
          const queue = readQueue(session);
          queue.push({ id, prompt, addedAt: new Date().toISOString(), source, priority, dedupKey, notBefore });
          writeQueue(session, queue);
          log("info", "trigger_queued", { session, taskId: id, position: queue.length, priority, delayed });
          return Response.json({
            id, session, queued: true, position: queue.length,
            ...(delayed ? { notBefore } : {}),
            message: delayed ? "Scheduled for later." : "Claude is busy. Prompt added to queue.",
          });
        }

        writeState(session, {
          status: "busy",
          since: new Date().toISOString(),
          currentPrompt: prompt,
          currentTaskId: id,
          currentDedupKey: dedupKey,
          deadlineAt: taskDeadline(),
        });
        recordTaskStart({ id, session, prompt, source: source ?? "trigger" });

        const sent = sendToTmux(session, prompt);
        if (!sent) {
          recordTaskFinish({ id, session, status: "failed", error: "send to tmux failed" });
          log("error", "trigger_failed", { session, taskId: id });
          return Response.json({ error: "Failed to send to tmux session" }, { status: 500 });
        }

        log("info", "trigger_sent", { session, taskId: id });
        return Response.json({ id, session, sent: true, prompt });
      }),
    },

    "/queue": {
      GET: authed((req) => {
        const session = getSessionParam(req);
        const queue = readQueue(session);
        return Response.json({ session, items: queue, length: queue.length });
      }),
      DELETE: authed((req) => {
        const session = getSessionParam(req);
        writeQueue(session, []);
        log("info", "queue_cleared", { session });
        return Response.json({ session, cleared: true });
      }),
    },

    // Remove a single queued item by id (vs DELETE /queue which clears all),
    // or re-prioritise it with POST { priority }.
    "/queue/:id": {
      DELETE: authed((req) => {
        const session = getSessionParam(req);
        const id = sanitizeId(req.params.id);
        const queue = readQueue(session);
        const idx = queue.findIndex((q) => q.id === id);
        if (idx === -1) return Response.json({ error: "Queued item not found" }, { status: 404 });
        queue.splice(idx, 1);
        writeQueue(session, queue);
        log("info", "queue_item_removed", { session, taskId: id });
        return Response.json({ session, id, removed: true });
      }),
      POST: authed(async (req) => {
        const session = getSessionParam(req);
        const id = sanitizeId(req.params.id);
        const body = await req.json().catch(() => ({}));
        const priority = Number(body.priority);
        if (!Number.isFinite(priority)) return Response.json({ error: "priority (number) is required" }, { status: 400 });
        const queue = readQueue(session);
        const item = queue.find((q) => q.id === id);
        if (!item) return Response.json({ error: "Queued item not found" }, { status: 404 });
        item.priority = priority;
        writeQueue(session, queue);
        log("info", "queue_item_reprioritized", { session, taskId: id, priority });
        return Response.json({ session, id, priority });
      }),
    },

    // --- Worker pools & map-reduce ---

    // Load-balance one prompt across a pool's members (idle first, else the
    // least-loaded member's queue).
    "/pool/:name/trigger": {
      POST: authed(async (req) => {
        const name = sanitizeSession(req.params.name);
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const prompt = body.prompt as string;
        if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });
        if (prompt.length > MAX_PROMPT_SIZE) return Response.json({ error: `prompt exceeds ${MAX_PROMPT_SIZE} character limit` }, { status: 413 });
        const check = validateStructural(prompt);
        if (!check.ok) return Response.json({ error: `Prompt rejected: ${check.reason}` }, { status: 400 });

        const pool = readPipeline().pools[name];
        if (!pool || !pool.members?.length) return Response.json({ error: `Unknown pool '${name}'` }, { status: 404 });

        const member = pickPoolMember(pool.members);
        if (!member) return Response.json({ error: "Pool has no members" }, { status: 503 });

        const id = body.id ? sanitizeId(body.id as string) : generateId();
        const where = dispatchOrQueue(member.session, prompt, {
          id, source: (body.source as string) ?? `pool:${name}`,
          priority: Number(body.priority) || undefined,
        });
        log("info", "pool_dispatched", { pool: name, member: member.session, taskId: id, where });
        return Response.json({ pool: name, member: member.session, id, where });
      }),
    },

    // Fan a list of items across a pool in parallel, then fire a reducer once
    // every item has come back (the fan-in / JOIN).
    "/map": {
      POST: authed(async (req) => {
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const items = body.items;
        const poolName = sanitizeSession((body.pool as string) ?? "");
        const mapTemplate = body.mapTemplate as string;

        if (!Array.isArray(items) || items.length === 0) return Response.json({ error: "items (non-empty array) is required" }, { status: 400 });
        if (items.length > MAP_MAX_ITEMS) return Response.json({ error: `items exceeds ${MAP_MAX_ITEMS} limit` }, { status: 413 });
        if (!mapTemplate) return Response.json({ error: "mapTemplate is required" }, { status: 400 });

        const pool = readPipeline().pools[poolName];
        if (!pool || !pool.members?.length) return Response.json({ error: `Unknown pool '${poolName}'` }, { status: 404 });

        const reduce = body.reduce?.session && body.reduce?.promptTemplate
          ? { session: sanitizeSession(body.reduce.session as string), promptTemplate: String(body.reduce.promptTemplate) }
          : undefined;

        const runId = prefixedId("map");
        const run: MapRun = { runId, pool: poolName, total: items.length, collected: {}, reduce, source: body.source, createdAt: Date.now(), reduced: false, shardTaskIds: [] };
        mapRuns.set(runId, run);

        const dispatched: unknown[] = [];
        for (let i = 0; i < items.length; i++) {
          const itemStr = typeof items[i] === "string" ? items[i] : JSON.stringify(items[i]);
          const prompt = renderTemplate(mapTemplate, { item: itemStr, index: String(i), total: String(items.length), runId });
          if (prompt.length > MAX_PROMPT_SIZE) { run.collected[i] = "(skipped: prompt too large)"; continue; }
          const v = validateStructural(prompt);
          if (!v.ok) { run.collected[i] = `(skipped: ${v.reason})`; continue; }

          const taskId = generateId();
          taskToMap.set(taskId, { runId, index: i });
          run.shardTaskIds.push(taskId);
          const member = pickPoolMember(pool.members)!;
          const where = dispatchOrQueue(member.session, prompt, { id: taskId, source: `map:${runId}` });
          dispatched.push({ index: i, taskId, member: member.session, where });
        }

        // Any items skipped synchronously may already complete the run.
        if (Object.keys(run.collected).length >= run.total) finishMapRun(run, false);

        log("info", "map_started", { runId, pool: poolName, total: items.length, reduce: !!reduce });
        return Response.json({ runId, pool: poolName, total: items.length, reduce: !!reduce, dispatched });
      }),
    },

    "/map/:runId": {
      GET: authed((req) => {
        const run = mapRuns.get(req.params.runId);
        if (!run) return Response.json({ error: "Map run not found" }, { status: 404 });
        return Response.json({
          runId: run.runId, pool: run.pool, total: run.total,
          collected: Object.keys(run.collected).length, reduced: run.reduced,
          reduceTaskId: run.reduceTaskId,
        });
      }),
    },

    // --- Signed inbound webhook gateway ---
    // No bearer auth: authenticity is proven by the per-source HMAC over the
    // raw body. Meant to be reachable by third-party SaaS webhooks.
    "/ingest/:source": {
      POST: async (req) => {
        const source = sanitizeSession(req.params.source);
        const recipe = readIngestConfig()[source];
        if (!recipe) return Response.json({ error: "Unknown ingest source" }, { status: 404 });

        const rawBody = await req.text();
        if (rawBody.length > MAX_PROMPT_SIZE) return Response.json({ error: "payload too large" }, { status: 413 });

        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

        const verify = verifySignature(recipe, rawBody, headers);
        if (!verify.ok) {
          log("warn", "ingest_rejected", { source, reason: verify.reason });
          return Response.json({ error: "Signature verification failed" }, { status: 401 });
        }

        // Replay protection: each signed delivery's nonce may be used once. The
        // nonce is bound to signed material (see verifySignature). The nonce TTL
        // is long (INGEST_NONCE_TTL_SEC), not the freshness window, since schemes
        // without a signed timestamp rely solely on it. We decide purely from
        // markNonce's result (no separate liveness probe) so a Redis drop can't
        // slip through a TOCTOU: "unavailable" fails closed (503) unless opted out.
        if (verify.nonce) {
          const nonceTtl = Math.max(INGEST_NONCE_TTL_SEC, recipe.maxAgeSec ?? 0);
          const seen = await eventBus.markNonce(`ingest:${source}:${verify.nonce}`, nonceTtl);
          if (seen === "unavailable" && !INGEST_ALLOW_WITHOUT_REDIS) {
            log("warn", "ingest_replay_unavailable", { source });
            return Response.json({ error: "Replay protection unavailable (Redis down)" }, { status: 503 });
          }
          if (seen === "duplicate") {
            log("warn", "ingest_replay", { source });
            return Response.json({ error: "Replay detected" }, { status: 409 });
          }
        }

        let body: unknown;
        try { body = JSON.parse(rawBody); } catch { body = { raw: rawBody }; }

        const prompt = buildFramedPrompt(recipe, body, source);
        if (prompt.length > MAX_PROMPT_SIZE) return Response.json({ error: "rendered prompt too large" }, { status: 413 });
        const check = validateStructural(prompt);
        if (!check.ok) {
          log("warn", "ingest_prompt_rejected", { source, reason: check.reason });
          return Response.json({ error: `Rejected: ${check.reason}` }, { status: 400 });
        }

        if (recipe.target === "publish") {
          if (!recipe.topic) return Response.json({ error: "recipe.topic required for publish target" }, { status: 400 });
          await publishEvent(recipe.topic, { session: "external", taskId: generateId(), message: prompt, external: true });
          log("info", "ingest_published", { source, topic: recipe.topic });
          return Response.json({ ingested: true, source, target: "publish", topic: recipe.topic });
        }

        const session = sanitizeSession(recipe.session ?? "default");
        const id = generateId();
        const where = dispatchOrQueue(session, prompt, { id, source: `ingest:${source}` });
        log("info", "ingest_triggered", { source, session, taskId: id, where });
        return Response.json({ ingested: true, source, target: "trigger", session, id, where });
      },
    },

    // --- Pipeline ---

    "/pipeline": {
      GET: authed(async () => {
        const pipeline = readPipeline();
        const events = await eventBus.getRecentEvents(10);
        const recentEvents = [];
        for (const e of events) {
          const deliveries = await eventBus.getDeliveries(e.id);
          recentEvents.push({
            topic: e.topic,
            sourceSession: e.sourceSession,
            taskId: e.taskId,
            subscribers: deliveries.filter((d) => d.status !== "skipped").map((d) => d.subscriber),
            publishedAt: e.publishedAt,
          });
        }
        return Response.json({ ...pipeline, redis: eventBus.connected, recentEvents });
      }),
    },

    "/pipeline/topics": {
      GET: authed(() => {
        const pipeline = readPipeline();
        return Response.json(Object.keys(pipeline.topics));
      }),
    },

    "/events": {
      GET: authed(async (req) => {
        const url = new URL(req.url);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
        const events = await eventBus.getRecentEvents(limit);
        const result = [];
        for (const e of events) {
          const deliveries = await eventBus.getDeliveries(e.id);
          result.push({ ...e, deliveries });
        }
        return Response.json({ events: result });
      }),
    },

    "/publish": {
      POST: authed(async (req) => {
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const topic = body.topic as string;
        const message = body.message as string;
        const session = body.session as string | undefined;

        if (!topic || !message) {
          return Response.json({ error: "topic and message are required" }, { status: 400 });
        }

        if (message.length > MAX_PROMPT_SIZE) {
          return Response.json({ error: `message exceeds ${MAX_PROMPT_SIZE} character limit (512KB)` }, { status: 413 });
        }

        const validation = validateStructural(message);
        if (!validation.ok) {
          log("warn", "publish_rejected", { topic, reason: validation.reason });
          return Response.json({ error: `Message rejected: ${validation.reason}` }, { status: 400 });
        }

        await publishEvent(topic, {
          session: session ?? "external",
          taskId: generateId(),
          message: redactOut(message).text,
          external: true,
        });

        return Response.json({ published: true, topic });
      }),
    },

    "/responses": {
      GET: authed((req) => {
        const session = getSessionParam(req);
        const p = sessionPaths(session);
        const files = readdirSync(p.responses).filter((f) => f.endsWith(".json"));
        const responses = files.map((f) => {
          try {
            const raw = readFileSync(`${p.responses}/${f}`, "utf-8");
            const data = JSON.parse(raw);
            return { id: data.id, completed_at: data.completed_at };
          } catch {
            return null;
          }
        }).filter(Boolean);
        return Response.json({ session, items: responses, length: responses.length });
      }),
      DELETE: authed((req) => {
        const session = getSessionParam(req);
        const p = sessionPaths(session);
        const files = readdirSync(p.responses).filter((f) => f.endsWith(".json"));
        for (const f of files) {
          try { unlinkSync(`${p.responses}/${f}`); } catch {}
        }
        log("info", "responses_cleared", { session, count: files.length });
        return Response.json({ session, cleared: true, count: files.length });
      }),
    },

    "/responses/:id": {
      GET: authed((req) => {
        const session = getSessionParam(req);
        const id = req.params.id;
        const file = responseFile(session, id);
        if (!existsSync(file)) {
          const state = readState(session);
          if (state.currentTaskId === id && state.status === "busy") {
            return Response.json({ id, session, status: "pending" }, { status: 202 });
          }
          const queue = readQueue(session);
          const queued = queue.find((q: QueueItem) => q.id === id);
          if (queued) {
            return Response.json({ id, session, status: "queued" }, { status: 202 });
          }
          return Response.json({ error: "Response not found" }, { status: 404 });
        }
        try {
          const raw = readFileSync(file, "utf-8");
          return Response.json(JSON.parse(raw));
        } catch {
          return Response.json({ error: "Failed to read response" }, { status: 500 });
        }
      }),
    },

    "/responses/:id/stream": {
      GET: authed((req) => {
        const session = getSessionParam(req);
        const id = req.params.id;
        const url = new URL(req.url);
        const timeoutSec = Math.min(Number(url.searchParams.get("timeout") ?? 300), 600);

        // Fast path: already complete
        const file = responseFile(session, id);
        if (existsSync(file)) {
          try {
            const raw = readFileSync(file, "utf-8");
            const data = JSON.parse(raw);
            const body = `event: complete\ndata: ${JSON.stringify(data)}\n\n`;
            return new Response(body, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
              },
            });
          } catch {}
        }

        log("info", "stream_opened", { session, taskId: id, timeoutSec });

        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              const send = (event: string, payload: unknown) => {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
              };

              try {
                const deadline = Date.now() + timeoutSec * 1000;
                const interval = 1500;

                while (Date.now() < deadline) {
                  const f = responseFile(session, id);
                  if (existsSync(f)) {
                    try {
                      const raw = readFileSync(f, "utf-8");
                      send("complete", JSON.parse(raw));
                    } catch {
                      send("error", { id, error: "Failed to read response" });
                    }
                    controller.close();
                    return;
                  }

                  const state = readState(session);
                  if (state.currentTaskId === id && state.status === "busy") {
                    send("status", { id, session, status: "pending" });
                  } else {
                    const queue = readQueue(session);
                    const queued = queue.find((q: QueueItem) => q.id === id);
                    if (queued) {
                      const position = queue.indexOf(queued) + 1;
                      send("status", { id, session, status: "queued", position });
                    } else if (state.status === "offline") {
                      send("error", { id, error: "Session is offline" });
                      controller.close();
                      return;
                    }
                  }

                  await Bun.sleep(interval);
                }

                send("timeout", { id, error: "Timed out waiting for response" });
              } catch {
                // Client disconnected
              }

              try { controller.close(); } catch {}
            },
          }),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          }
        );
      }),
    },

    // --- Task ledger ---

    "/tasks": {
      GET: authed((req) => {
        const url = new URL(req.url);
        const sessionParam = url.searchParams.get("session");
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        const { tasks, total } = queryTasks({
          session: sessionParam ? sanitizeSession(sessionParam) : undefined,
          status: url.searchParams.get("status") ?? undefined,
          source: url.searchParams.get("source") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          until: url.searchParams.get("until") ?? undefined,
          limit: limitParam ? Number(limitParam) : undefined,
          offset: offsetParam ? Number(offsetParam) : undefined,
        });
        return Response.json({ tasks, total });
      }),
    },

    "/tasks/:id": {
      GET: authed((req) => {
        const id = sanitizeId(req.params.id);
        const url = new URL(req.url);
        const sessionParam = url.searchParams.get("session");
        const task = getTask(id, sessionParam ? sanitizeSession(sessionParam) : undefined);
        if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
        let messages: string[] | undefined;
        const file = responseFile(task.session, id);
        if (existsSync(file)) {
          try { messages = JSON.parse(readFileSync(file, "utf-8")).messages; } catch {}
        }
        return Response.json({ ...task, messages });
      }),
    },

    "/responses/:id/timeline": {
      GET: authed((req) => {
        const session = getSessionParam(req);
        const id = sanitizeId(req.params.id);
        const task = getTask(id, session);
        if (!task) return Response.json({ error: "Task not found" }, { status: 404 });
        return Response.json({
          id, session, status: task.status,
          durationMs: task.duration_ms, model: task.model,
          steps: task.steps, usage: task.usage, savedUsd: task.saved_usd,
          filesChanged: task.files_changed, commandsRun: task.commands_run,
        });
      }),
    },

    // Cancel a single task — running or queued — without killing the warm
    // session or clearing the whole queue. Handler is fully synchronous so the
    // read-modify-write of state/queue is atomic against the file state.
    "/tasks/:id/cancel": {
      POST: authed((req) => {
        const session = getSessionParam(req);
        const id = sanitizeId(req.params.id);
        const state = readState(session);

        // Running task: interrupt it, record the cancel, free the session.
        if (state.status === "busy" && state.currentTaskId === id) {
          sendInterrupt(session, "escape");
          saveResponse(session, id, state.currentPrompt, undefined, "[haiflow] task cancelled by operator");
          recordTaskFinish({ id, session, status: "cancelled", error: "cancelled by operator" });
          writeState(session, {
            status: "idle", since: new Date().toISOString(),
            waiting: false, waitingMessage: undefined, waitingSince: undefined, deadlineAt: undefined,
          });
          drainQueue(session);
          log("info", "task_cancelled", { session, taskId: id, where: "running" });
          return Response.json({ cancelled: true, session, id, where: "running" });
        }

        // Queued task: pluck just this item out of the FIFO.
        const queue = readQueue(session);
        const idx = queue.findIndex((q) => q.id === id);
        if (idx !== -1) {
          queue.splice(idx, 1);
          writeQueue(session, queue);
          log("info", "task_cancelled", { session, taskId: id, where: "queue" });
          return Response.json({ cancelled: true, session, id, where: "queue" });
        }

        return Response.json({ error: "Task is not running or queued for this session" }, { status: 404 });
      }),
    },

    // --- Usage & savings (budget meter) ---

    "/usage": {
      GET: authed((req) => {
        const url = new URL(req.url);
        const sessionParam = url.searchParams.get("session");
        const session = sessionParam ? sanitizeSession(sessionParam) : undefined;
        const since = url.searchParams.get("since") ?? new Date(Date.now() - 86_400_000).toISOString();
        const agg = usageSince(since, session);
        return Response.json({ since, session: session ?? "all", ...agg });
      }),
    },

    "/usage/window": {
      GET: authed((req) => {
        const url = new URL(req.url);
        const sessionParam = url.searchParams.get("session");
        const session = sessionParam ? sanitizeSession(sessionParam) : undefined;
        const now = Date.now();
        const fiveHour = usageSince(new Date(now - 5 * 3_600_000).toISOString(), session);
        const week = usageSince(new Date(now - 7 * 86_400_000).toISOString(), session);
        const threshold = Number(process.env.HAIFLOW_USAGE_ALERT_TOKENS ?? 0) || null;
        return Response.json({
          session: session ?? "all",
          windows: { "5h": fiveHour, "7d": week },
          alertThresholdTokens: threshold,
          alert: threshold ? fiveHour.totalTokens >= threshold : false,
        });
      }),
    },

    // --- Hooks (no auth — these come from Claude Code itself) ---

    "/hooks/session-start": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const claudeId = body.session_id;
        let session = findSessionByClaudeId(claudeId);

        if (!session) {
          const sessions = listSessions();
          for (const s of sessions) {
            if (!getSessionId(s.session) && isTmuxRunning(s.session)) {
              session = s.session;
              break;
            }
          }
        }

        if (session) {
          setSessionId(session, claudeId);
          if (isTmuxRunning(session)) {
            writeState(session, { status: "idle", since: new Date().toISOString() });
          }
          log("info", "hook_session_start", { session, claudeId });
        }

        return Response.json({ ok: true, session });
      },
    },

    "/hooks/prompt": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const state = readState(session);
        writeState(session, {
          status: "busy",
          since: new Date().toISOString(),
          currentPrompt: body.prompt,
          currentTaskId: state.currentTaskId,
          // A new prompt is being processed — any prior "waiting" block is over.
          waiting: false,
          waitingMessage: undefined,
          waitingSince: undefined,
          transcriptPath: body.transcript_path,
        });

        return Response.json({ ok: true });
      },
    },

    "/hooks/stop": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const state = readState(session);
        if (state.currentTaskId) {
          // Mine the transcript once for both the response capture and the
          // durable ledger (tool/command/diff timeline + token usage).
          const extract = (body.transcript_path && isAllowedTranscriptPath(body.transcript_path))
            ? extractFromTranscript(body.transcript_path)
            : null;
          saveResponse(session, state.currentTaskId, state.currentPrompt, extract?.messages, body.last_assistant_message);

          recordTaskFinish({
            id: state.currentTaskId,
            session,
            status: "completed",
            steps: extract?.steps,
            usage: extract?.usage ?? null,
            model: extract?.model ?? null,
            filesChanged: extract?.filesChanged,
            commandsRun: extract?.commandsRun,
            savedUsd: extract?.usage ? estimateSavings(extract.usage, extract.model) : null,
          });

          // Pipeline: emit to subscribed topics, propagating chain for circular detection.
          // Redact before anything leaves the session (subscribers, webhooks, map).
          const pipeline = readPipeline();
          const emitterTopics = pipeline.emitters[session] ?? [];
          const responseText = redactOut(body.last_assistant_message ?? "").text;
          for (const topic of emitterTopics) {
            await publishEvent(topic, {
              session,
              taskId: state.currentTaskId,
              message: responseText,
              chain: state.currentChain,
            });
          }

          // Map-reduce: if this task was a map shard, collect its output and
          // fire the reducer once the whole run is in.
          collectMapResult(state.currentTaskId, responseText);
        }

        writeState(session, {
          status: "idle", since: new Date().toISOString(),
          waiting: false, waitingMessage: undefined, waitingSince: undefined, deadlineAt: undefined,
        });
        drainQueue(session);
        log("info", "hook_stop", { session, taskId: state.currentTaskId });

        return Response.json({ ok: true });
      },
    },

    "/hooks/session-end": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const reason = body.reason;
        if (reason === "clear" || reason === "compact") {
          return Response.json({ ok: true });
        }

        writeState(session, { status: "offline", since: new Date().toISOString() });
        log("info", "hook_session_end", { session, reason });
        return Response.json({ ok: true });
      },
    },

    "/hooks/notification": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        // Only treat a notification as a wedge signal while the session is
        // mid-task. Claude also fires Notification when idle and waiting for the
        // next prompt — for haiflow that's the normal idle state, not a wedge.
        const state = readState(session);
        if (state.status === "busy") {
          const message = typeof body.message === "string" ? body.message.slice(0, 500) : undefined;
          writeState(session, {
            waiting: true,
            waitingMessage: message,
            waitingSince: new Date().toISOString(),
            transcriptPath: body.transcript_path,
          });
          log("warn", "hook_notification", { session, message });
        }
        return Response.json({ ok: true });
      },
    },

    "/session/start": {
      POST: authed(async (req) => {
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = sanitizeSession((body.session as string) || "default");
        const requestedCwd = body.cwd as string | undefined;

        let cwd: string;
        if (FORCED_CWD) {
          if (requestedCwd && requestedCwd !== FORCED_CWD) {
            log("warn", "session_start_cwd_overridden", { session, requested: requestedCwd, forced: FORCED_CWD });
          }
          cwd = FORCED_CWD;
        } else if (!ALLOW_REQUEST_CWD) {
          log("warn", "session_start_rejected", { session, reason: "request cwd disabled and HAIFLOW_CWD unset" });
          return Response.json({ error: "cwd from request is disabled; set HAIFLOW_CWD on the server" }, { status: 400 });
        } else {
          if (!requestedCwd) {
            return Response.json({ error: "cwd is required" }, { status: 400 });
          }
          cwd = requestedCwd;
        }

        const result = await startClaudeSession(session, cwd);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 409 });
        }
        return Response.json({ started: true, session, tmux: tmuxName(session), cwd });
      }),
    },

    "/session/stop": {
      POST: authed(async (req) => {
        let session = "default";
        try {
          const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
          session = sanitizeSession((body.session as string) || "default");
        } catch {}

        const result = stopClaudeSession(session);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 404 });
        }
        return Response.json({ stopped: true, session });
      }),
    },

    "/session/remove": {
      POST: authed(async (req) => {
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = sanitizeSession((body.session as string) || "");
        if (!session) return Response.json({ error: "session is required" }, { status: 400 });

        const state = readState(session);
        if (state.status !== "offline") {
          return Response.json({ error: "Session must be offline to remove" }, { status: 409 });
        }

        const dir = `${BASE_DIR}/${session}`;
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true });
        }
        log("info", "session_removed", { session });
        return Response.json({ removed: true, session });
      }),
    },

    // Bulk-reap stale OFFLINE sessions whose state dir would otherwise linger
    // forever and add per-tick scan cost. Only offline sessions older than the
    // TTL are removed; idle/busy sessions and recently-offline ones are kept.
    "/sessions/prune": {
      POST: authed(async (req) => {
        const body = (await readJson(req)) ?? {};
        const ttlHours = Number(body.olderThanHours ?? SESSION_TTL_HOURS) || SESSION_TTL_HOURS;
        const cutoff = Date.now() - ttlHours * 3_600_000;
        const pruned: string[] = [];
        for (const { session, status } of listSessions()) {
          if (status !== "offline") continue;
          const since = Date.parse(readState(session).since ?? "");
          if (Number.isFinite(since) && since > cutoff) continue; // too recent
          try {
            rmSync(`${BASE_DIR}/${session}`, { recursive: true });
            pruned.push(session);
          } catch {}
        }
        log("info", "sessions_pruned", { count: pruned.length, ttlHours });
        return Response.json({ pruned, count: pruned.length, ttlHours });
      }),
    },

    // Interrupt a running session: send Escape (default) or Ctrl-C into its TUI,
    // optionally followed by a steering prompt. Use this to unstick a session
    // wedged on a permission prompt, or to redirect a running agent.
    "/interrupt": {
      POST: authed(async (req) => {
        const body = await readJson(req);
        if (!body) return Response.json({ error: "Invalid or empty JSON body" }, { status: 400 });
        const session = sanitizeSession((body.session as string) || "default");
        const mode = body.mode === "ctrl-c" ? "ctrl-c" : "escape";

        if (!isTmuxRunning(session)) {
          return Response.json({ error: `Session '${session}' is not running` }, { status: 404 });
        }

        const sent = sendInterrupt(session, mode);
        if (!sent) {
          return Response.json({ error: "Failed to send interrupt" }, { status: 500 });
        }
        // We just acted on the wedge — clear the waiting flag.
        writeState(session, { waiting: false, waitingMessage: undefined, waitingSince: undefined });

        let steered = false;
        if (typeof body.prompt === "string" && body.prompt.length > 0) {
          const prompt = body.prompt as string;
          if (prompt.length > MAX_PROMPT_SIZE) {
            return Response.json({ error: `prompt exceeds ${MAX_PROMPT_SIZE} character limit` }, { status: 413 });
          }
          const validation = validateStructural(prompt);
          if (!validation.ok) {
            return Response.json({ error: `Prompt rejected: ${validation.reason}` }, { status: 400 });
          }
          await Bun.sleep(250); // let the interrupt settle before typing
          steered = sendToTmux(session, prompt);
        }

        log("info", "interrupt_sent", { session, mode, steered });
        return Response.json({ interrupted: true, session, mode, steered });
      }),
    },

    "/health": new Response("ok"),
    "/version": {
      GET: () => Response.json({ version: VERSION, startedAt: STARTED_AT, redis: eventBus.connected }),
    },
    "/dashboard": dashboard,

    // WebSocket upgrade for live terminal view
    "/terminal": {
      GET: (req: Request) => {
        const url = new URL(req.url);
        const session = sanitizeSession(url.searchParams.get("session") ?? "default");
        const key = url.searchParams.get("key") ?? "";

        // Auth via query param (WebSocket can't set custom headers from browser)
        const keyBuf = Buffer.from(`Bearer ${key}`);
        const match = keyBuf.length === API_KEY_BUFFER.length &&
          crypto.timingSafeEqual(keyBuf, API_KEY_BUFFER);
        if (!match) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        if (!isTmuxRunning(session)) {
          return Response.json({ error: "Session not running" }, { status: 404 });
        }

        // Control mode = a WRITABLE attach. It bypasses validateStructural and
        // the guardrail skill, so it's gated behind the API key (checked above)
        // and the HAIFLOW_ALLOW_TAKEOVER kill-switch.
        const control = url.searchParams.get("mode") === "control" && ALLOW_TAKEOVER;

        const upgraded = server.upgrade(req, { data: { session, control } });
        if (!upgraded) {
          return Response.json({ error: "WebSocket upgrade failed" }, { status: 500 });
        }
      },
    },
  },

  websocket: {
    open(ws: ServerWebSocket<TerminalWSData>) {
      const session = ws.data.session;
      const control = !!ws.data.control;
      const target = tmuxName(session);

      // Use `script` as a PTY wrapper so tmux gets a real terminal. In control
      // mode we drop `-r` (read-only) so the attach is writable.
      const ro = control ? [] : ["-r"];
      const cmd = process.platform === "darwin"
        ? ["script", "-q", "/dev/null", "tmux", "attach-session", "-t", target, ...ro]
        : ["script", "-qc", `tmux attach-session -t ${target}${control ? "" : " -r"}`, "/dev/null"];

      const proc = Bun.spawn(cmd, {
        stdin: control ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, TERM: "xterm-256color" },
      });

      ws.data.proc = proc;

      if (control) {
        // Pause auto-drain while the human holds the wheel.
        writeState(session, { intervened: true });
        log("warn", "terminal_control_opened", { session });
      }

      // Stream tmux output to the WebSocket via explicit reader
      const reader = proc.stdout.getReader();
      ws.data.reader = reader;
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try { ws.send(value); } catch { break; }
          }
        } catch {
          // Stream ended or errored
        }
        try { ws.close(); } catch {}
      })();

      // Close WebSocket if process exits unexpectedly
      proc.exited.then(() => {
        try { ws.close(); } catch {}
      }).catch(() => {});

      log("info", "terminal_ws_opened", { session });
    },

    message(ws: ServerWebSocket<TerminalWSData>, msg: string | Buffer) {
      // Only control-mode sockets accept input; view-mode ignores it.
      if (!ws.data.control) return;
      const stdin = ws.data.proc?.stdin;
      if (!stdin) return;
      try {
        stdin.write(typeof msg === "string" ? msg : new Uint8Array(msg));
        stdin.flush();
      } catch {
        // PTY closed
      }
    },

    close(ws: ServerWebSocket<TerminalWSData>) {
      const session = ws.data.session;
      // Release the stdout reader lock so the killed PTY's stream can be
      // collected instead of leaving a locked stream + zombie `script` process.
      try { ws.data.reader?.cancel(); } catch {}
      try { ws.data.proc?.kill(); } catch {}
      if (ws.data.control) {
        writeState(session, { intervened: false });
        log("info", "terminal_control_closed", { session });
      }
      log("info", "terminal_ws_closed", { session });
    },
  },

  development: {
    hmr: true,
    console: true,
  },

  fetch(req) {
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

for (const dir of readdirSync(BASE_DIR).filter((d) => existsSync(`${BASE_DIR}/${d}/state.json`))) {
  if (isTmuxRunning(dir) && getSessionId(dir)) {
    const state = readState(dir);
    const patch = recoverSessionPatch(state, new Date().toISOString());
    if (patch) writeState(dir, patch);
  }
}

const sweptPrompts = sweepStalePromptFiles();
if (sweptPrompts > 0) log("info", "stale_prompts_swept", { count: sweptPrompts });

log("info", "server_started", { port: server.port, auth: !!API_KEY });
log("info", "sessions_recovered", { sessions: listSessions() });

installGuardrailSkill();

// Replay unprocessed events from previous run
const unprocessed = await eventBus.getUnprocessedEvents();
for (const evt of unprocessed) {
  log("info", "event_replay", { eventId: evt.id, topic: evt.topic });
  await handlePipelineEvent(evt.topic, {
    session: evt.sourceSession,
    taskId: evt.taskId,
    message: evt.message,
    chain: evt.chain,
  }, { skipRecording: true, existingEventId: evt.id });
}
if (unprocessed.length > 0) {
  log("info", "events_replayed", { count: unprocessed.length });
}

// Retry failed webhooks every 60 seconds
const retryTimer = setInterval(async () => {
  const retries = await eventBus.getPendingWebhookRetries();
  for (const retry of retries) {
    const pipeline = readPipeline();
    const topicConfig = pipeline.topics[retry.topic];
    if (!topicConfig) continue;

    const webhookUrl = retry.subscriber.replace("webhook:", "");
    const wh = topicConfig.webhooks?.find((w) => w.url === webhookUrl);
    if (!wh || wh.enabled === false) continue;

    const payload = buildWebhookPayload(retry.topic, {
      session: retry.sourceSession, taskId: retry.taskId, message: retry.message,
    });

    postWebhook(wh, payload).then(async () => {
      await eventBus.updateDelivery(retry.eventId, retry.subscriber, { status: "delivered" });
      await eventBus.finalizeEvent(retry.eventId);
      log("info", "pipeline_webhook_retried", { topic: retry.topic, url: wh.url });
    }).catch(async (err) => {
      const schedule = nextRetrySchedule(retry.attempts, Date.now());
      await eventBus.updateDelivery(retry.eventId, retry.subscriber, {
        status: "failed",
        lastError: String(err),
        ...(schedule ? { nextRetryAt: schedule.nextRetryAt } : {}),
      });
      await eventBus.finalizeEvent(retry.eventId);
    });
  }
}, 60_000);

// Prune events older than 7 days, every 24 hours
const pruneTimer = setInterval(async () => {
  const pruned = await eventBus.prune(7);
  if (pruned > 0) log("info", "events_pruned", { count: pruned });
}, 86_400_000);

// Delay tick: drain scheduled queue items once their notBefore passes, even on
// an idle session (normal draining only happens when a task Stops). drainQueue
// no-ops when nothing is eligible, so this is cheap.
const delayTickTimer = setInterval(() => {
  for (const { session, status } of listSessions()) {
    if (status === "idle") drainQueue(session);
  }
}, 5_000);

// Watchdog: catch sessions wedged on a permission prompt (flagged "waiting" by
// the Notification hook) or past their hard deadline, so a stuck session can't
// silently sit busy forever and starve its queue. Recovery (Escape + drain) is
// opt-in via HAIFLOW_WATCHDOG_RECOVER; by default this only alerts in the logs.
const watchdogTimer = setInterval(() => {
  for (const { session, status } of listSessions()) {
    if (status !== "busy") continue;
    const state = readState(session);
    const now = Date.now();
    const overDeadline = state.deadlineAt ? Date.parse(state.deadlineAt) < now : false;
    const waitingTooLong = state.waiting && state.waitingSince
      ? now - Date.parse(state.waitingSince) > WAITING_GRACE_MS
      : false;
    if (!overDeadline && !waitingTooLong) continue;

    const reason = overDeadline ? "timeout" : "waiting";
    log("warn", "watchdog_triggered", {
      session, reason, taskId: state.currentTaskId,
      waitingMessage: state.waitingMessage, recover: WATCHDOG_RECOVER,
    });

    if (!WATCHDOG_RECOVER || !isTmuxRunning(session)) continue;

    sendInterrupt(session, "escape");
    if (state.currentTaskId) {
      saveResponse(session, state.currentTaskId, state.currentPrompt, undefined,
        `[haiflow] task recovered by watchdog (${reason})`);
      recordTaskFinish({ id: state.currentTaskId, session, status: "timed_out", error: `watchdog:${reason}` });
    }
    writeState(session, {
      status: "idle", since: new Date().toISOString(),
      waiting: false, waitingMessage: undefined, waitingSince: undefined, deadlineAt: undefined,
    });
    drainQueue(session);
    log("info", "watchdog_recovered", { session, reason, taskId: state.currentTaskId });
  }

  // Time out stuck map runs (a shard never returned) and reap old finished ones.
  const nowMs = Date.now();
  for (const [id, run] of mapRuns) {
    if (!run.reduced && nowMs - run.createdAt > MAP_TIMEOUT_MS) finishMapRun(run, true);
    else if (run.reduced && nowMs - run.createdAt > MAP_TIMEOUT_MS + 3_600_000) mapRuns.delete(id);
  }
}, WATCHDOG_INTERVAL_MS);

// Graceful shutdown: a process manager (systemd, docker stop, pm2) sends SIGTERM.
// Without a handler the timers are killed mid-flight, the Redis connection is
// left open, and spawned terminal PTYs are orphaned. Flush everything and exit.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown", { signal });
  for (const timer of [retryTimer, pruneTimer, delayTickTimer, watchdogTimer]) {
    clearInterval(timer);
  }
  try { server.stop(true); } catch {}
  try { eventBus.close(); } catch {}
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => shutdown(signal));
}
