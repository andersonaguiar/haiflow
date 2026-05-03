import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, statSync } from "fs";
import dashboard from "./dashboard/index.html";
import {
  sanitizeSession, sanitizeId, generateId, tmuxName,
  validateStructural,
  isAllowedTranscriptPath, renderTemplate,
} from "./utils";
import { EventBus } from "./events";

const BASE_DIR = process.env.HAIFLOW_DATA_DIR ?? "/tmp/haiflow";
const PORT = Number(process.env.PORT ?? 3333);
const API_KEY = process.env.HAIFLOW_API_KEY?.trim();
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const FORCED_CWD = process.env.HAIFLOW_CWD?.trim() || null;
const ALLOW_REQUEST_CWD = (process.env.HAIFLOW_ALLOW_REQUEST_CWD ?? "true").toLowerCase() !== "false";
const ENABLE_GUARDRAILS = (process.env.HAIFLOW_GUARDRAILS ?? "true").toLowerCase() !== "false";
const GUARDRAIL_SKILL_NAME = "haiflow-guardrails";

// Max prompt/message size: 512KB — safely under Claude Code's ~150K usable token budget
// and under tmux/OS transport limits. The file-based fallback in sendToTmux handles delivery.
const MAX_PROMPT_SIZE = 512_000;

if (!API_KEY) {
  console.error("HAIFLOW_API_KEY is required. Set it in your .env or environment.");
  process.exit(1);
}

mkdirSync(BASE_DIR, { recursive: true });
const eventBus = await EventBus.create(REDIS_URL);

// --- Structured logging ---

function log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
  if (level === "error") console.error(entry);
  else console.log(entry);
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
}

interface QueueItem {
  id: string;
  prompt: string;
  addedAt: string;
  source?: string;
  chain?: string[];
}

// --- Pipeline types ---

interface PipelineSubscriber {
  session: string;
  promptTemplate: string;
  enabled?: boolean;
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

interface PipelineConfig {
  topics: Record<string, TopicConfig>;
  emitters: Record<string, string[]>;
}

const EMPTY_PIPELINE: PipelineConfig = { topics: {}, emitters: {} };

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
    cachedPipeline = { topics: config.topics ?? {}, emitters: config.emitters ?? {} };
    cachedPipelineMtime = stat.mtimeMs;
    cachedPipelineSize = stat.size;
    return cachedPipeline;
  } catch {
    log("warn", "pipeline_config_invalid", { file });
    return EMPTY_PIPELINE;
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
    const state = readState(subscriberSession);

    if (state.status === "offline") {
      const queue = readQueue(subscriberSession);
      queue.push({ id: taskId, prompt, addedAt: new Date().toISOString(), source: `pipeline:${topic}`, chain });
      writeQueue(subscriberSession, queue);
      log("warn", "pipeline_subscriber_offline", { topic, subscriber: subscriberSession, taskId });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "queued");
      continue;
    }

    if (state.status === "busy") {
      const queue = readQueue(subscriberSession);
      queue.push({ id: taskId, prompt, addedAt: new Date().toISOString(), source: `pipeline:${topic}`, chain });
      writeQueue(subscriberSession, queue);
      log("info", "pipeline_queued", { topic, subscriber: subscriberSession, taskId });
      if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "queued");
      continue;
    }

    // Session is idle — send immediately
    writeState(subscriberSession, {
      status: "busy",
      since: new Date().toISOString(),
      currentPrompt: prompt,
      currentTaskId: taskId,
      currentChain: chain,
    });
    sendToTmux(subscriberSession, prompt);
    log("info", "pipeline_dispatched", { topic, subscriber: subscriberSession, taskId });
    if (eventId) await eventBus.recordDelivery(eventId, subscriberSession, "session", "delivered");
  }
}

function deliverToWebhooks(
  topic: string,
  topicConfig: TopicConfig,
  event: { session: string; taskId: string; message: string },
  eventId?: string
) {
  for (const wh of topicConfig.webhooks ?? []) {
    if (wh.enabled === false) {
      if (eventId) eventBus.recordDelivery(eventId, `webhook:${wh.url}`, "webhook", "skipped");
      continue;
    }

    const payload = {
      topic,
      sourceSession: event.session,
      taskId: event.taskId,
      message: event.message,
      publishedAt: new Date().toISOString(),
    };

    if (eventId) eventBus.recordDelivery(eventId, `webhook:${wh.url}`, "webhook", "pending");

    const whSubscriber = `webhook:${wh.url}`;
    fetch(wh.url, {
      method: wh.method ?? "POST",
      headers: { "Content-Type": "application/json", ...wh.headers },
      body: JSON.stringify(payload),
    }).then(async () => {
      if (eventId) await eventBus.updateDelivery(eventId, whSubscriber, { status: "delivered" });
      log("info", "pipeline_webhook_sent", { topic, url: wh.url });
    }).catch(async (err) => {
      if (eventId) {
        const nextRetry = new Date(Date.now() + 60_000).toISOString();
        await eventBus.updateDelivery(eventId, whSubscriber, {
          status: "failed",
          lastError: String(err),
          nextRetryAt: nextRetry,
        });
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
  deliverToWebhooks(topic, topicConfig, event, eventId);

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
  writeFileSync(p.state, JSON.stringify(merged, null, 2));
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
  writeFileSync(p.queue, JSON.stringify(queue, null, 2));
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

function saveResponse(session: string, taskId: string, prompt?: string, transcriptPath?: string, lastMessage?: string) {
  if (!taskId) return;
  const file = responseFile(session, taskId);

  if (transcriptPath && isAllowedTranscriptPath(transcriptPath) && existsSync(transcriptPath)) {
    try {
      const lastUserLine = JSON.parse(
        Bun.spawnSync(["jq", "-s", 'to_entries | map(select(.value.type == "user")) | last | .key', transcriptPath]).stdout.toString()
      );
      const messages = JSON.parse(
        Bun.spawnSync(["jq", "-s", "--argjson", "start", String(lastUserLine ?? 0),
          '[.[$start:][] | select(.type == "assistant" and .message.role == "assistant") | .message.content[] | select(.type == "text") | .text]',
          transcriptPath]).stdout.toString()
      );
      if (Array.isArray(messages) && messages.length > 0) {
        writeFileSync(file, JSON.stringify({
          id: taskId, completed_at: new Date().toISOString(), prompt, messages,
        }, null, 2));
        log("info", "response_saved", { session, taskId, source: "transcript" });
        return;
      }
    } catch {}
  }

  if (lastMessage) {
    writeFileSync(file, JSON.stringify({
      id: taskId, completed_at: new Date().toISOString(), prompt, messages: [lastMessage],
    }, null, 2));
    log("info", "response_saved", { session, taskId, source: "fallback" });
  }
}

function drainQueue(session: string) {
  const state = readState(session);
  if (state.status !== "idle") return;

  const queue = readQueue(session);
  if (queue.length === 0) return;

  const next = queue.shift()!;
  writeQueue(session, queue);

  writeState(session, {
    status: "busy",
    since: new Date().toISOString(),
    currentPrompt: next.prompt,
    currentTaskId: next.id,
    currentChain: next.chain,
  });

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

const server = Bun.serve({
  port: PORT,
  routes: {
    "/sessions": {
      GET: authed(() => Response.json(listSessions())),
    },

    "/status": {
      GET: authed((req) => Response.json(readState(getSessionParam(req)))),
    },

    "/trigger": {
      POST: authed(async (req) => {
        const body = await req.json();
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

        const state = readState(session);

        if (state.status === "offline") {
          return Response.json(
            { error: `Session '${session}' is offline. Start it with POST /session/start` },
            { status: 503 }
          );
        }

        if (state.status === "busy") {
          const queue = readQueue(session);
          queue.push({ id, prompt, addedAt: new Date().toISOString(), source });
          writeQueue(session, queue);
          log("info", "trigger_queued", { session, taskId: id, position: queue.length });
          return Response.json({
            id, session, queued: true, position: queue.length,
            message: "Claude is busy. Prompt added to queue.",
          });
        }

        writeState(session, {
          status: "busy",
          since: new Date().toISOString(),
          currentPrompt: prompt,
          currentTaskId: id,
        });

        const sent = sendToTmux(session, prompt);
        if (!sent) {
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
        const body = await req.json();
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
          message,
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

    // --- Hooks (no auth — these come from Claude Code itself) ---

    "/hooks/session-start": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await req.json();
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
        const body = await req.json();
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const state = readState(session);
        writeState(session, {
          status: "busy",
          since: new Date().toISOString(),
          currentPrompt: body.prompt,
          currentTaskId: state.currentTaskId,
        });

        return Response.json({ ok: true });
      },
    },

    "/hooks/stop": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await req.json();
        const session = findSessionByClaudeId(body.session_id);
        if (!session) return Response.json({ ok: true });

        const state = readState(session);
        if (state.currentTaskId) {
          saveResponse(session, state.currentTaskId, state.currentPrompt, body.transcript_path, body.last_assistant_message);

          // Pipeline: emit to subscribed topics, propagating chain for circular detection
          const pipeline = readPipeline();
          const emitterTopics = pipeline.emitters[session] ?? [];
          const responseText = body.last_assistant_message ?? "";
          for (const topic of emitterTopics) {
            await publishEvent(topic, {
              session,
              taskId: state.currentTaskId,
              message: responseText,
              chain: state.currentChain,
            });
          }
        }

        writeState(session, { status: "idle", since: new Date().toISOString() });
        drainQueue(session);
        log("info", "hook_stop", { session, taskId: state.currentTaskId });

        return Response.json({ ok: true });
      },
    },

    "/hooks/session-end": {
      POST: async (req) => {
        const err = requireLocalhost(req);
        if (err) return err;
        const body = await req.json();
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

    "/session/start": {
      POST: authed(async (req) => {
        const body = await req.json();
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
          const body = await req.json();
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
        const body = await req.json();
        const session = sanitizeSession((body.session as string) || "");
        if (!session) return Response.json({ error: "session is required" }, { status: 400 });

        const state = readState(session);
        if (state.status !== "offline") {
          return Response.json({ error: "Session must be offline to remove" }, { status: 409 });
        }

        const dir = `${BASE_DIR}/${session}`;
        if (existsSync(dir)) {
          const { rmSync } = await import("fs");
          rmSync(dir, { recursive: true });
        }
        log("info", "session_removed", { session });
        return Response.json({ removed: true, session });
      }),
    },

    "/health": new Response("ok"),
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

        const upgraded = server.upgrade(req, { data: { session } });
        if (!upgraded) {
          return Response.json({ error: "WebSocket upgrade failed" }, { status: 500 });
        }
      },
    },
  },

  websocket: {
    open(ws: any) {
      const session = ws.data.session as string;
      const target = tmuxName(session);

      // Use `script` as PTY wrapper so tmux gets a real terminal
      const cmd = process.platform === "darwin"
        ? ["script", "-q", "/dev/null", "tmux", "attach-session", "-t", target, "-r"]
        : ["script", "-qc", `tmux attach-session -t ${target} -r`, "/dev/null"];

      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, TERM: "xterm-256color" },
      });

      ws.data.proc = proc;

      // Stream tmux output to the WebSocket via explicit reader
      const reader = proc.stdout.getReader();
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

    message(_ws: any, _msg: any) {
      // Read-only: ignore all input from the browser
    },

    close(ws: any) {
      const session = ws.data.session as string;
      try { ws.data.proc?.kill(); } catch {}
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
    if (state.status === "offline") {
      writeState(dir, { status: "idle", since: new Date().toISOString() });
    }
  }
}

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
setInterval(async () => {
  const retries = await eventBus.getPendingWebhookRetries();
  for (const retry of retries) {
    const pipeline = readPipeline();
    const topicConfig = pipeline.topics[retry.topic];
    if (!topicConfig) continue;

    const webhookUrl = retry.subscriber.replace("webhook:", "");
    const wh = topicConfig.webhooks?.find((w) => w.url === webhookUrl);
    if (!wh || wh.enabled === false) continue;

    const payload = {
      topic: retry.topic,
      sourceSession: retry.sourceSession,
      taskId: retry.taskId,
      message: retry.message,
      publishedAt: new Date().toISOString(),
    };

    fetch(wh.url, {
      method: wh.method ?? "POST",
      headers: { "Content-Type": "application/json", ...wh.headers },
      body: JSON.stringify(payload),
    }).then(async () => {
      await eventBus.updateDelivery(retry.eventId, retry.subscriber, { status: "delivered" });
      await eventBus.finalizeEvent(retry.eventId);
      log("info", "pipeline_webhook_retried", { topic: retry.topic, url: wh.url });
    }).catch(async (err) => {
      const attempts = retry.attempts + 1;
      if (attempts >= 5) {
        await eventBus.updateDelivery(retry.eventId, retry.subscriber, { status: "failed", lastError: String(err) });
      } else {
        const delay = 60_000 * Math.pow(2, attempts - 1);
        await eventBus.updateDelivery(retry.eventId, retry.subscriber, {
          status: "failed",
          lastError: String(err),
          nextRetryAt: new Date(Date.now() + delay).toISOString(),
        });
      }
      await eventBus.finalizeEvent(retry.eventId);
    });
  }
}, 60_000);

// Prune events older than 7 days, every 24 hours
setInterval(async () => {
  const pruned = await eventBus.prune(7);
  if (pruned > 0) log("info", "events_pruned", { count: pruned });
}, 86_400_000);
