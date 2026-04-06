import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from "fs";
import { RedisClient } from "bun";
import dashboard from "./dashboard/index.html";
import {
  sanitizeSession, sanitizeId, generateId, tmuxName,
  validateStructural, buildSecurityPreamble,
  isAllowedTranscriptPath, renderTemplate,
} from "./utils";

const BASE_DIR = process.env.HAIFLOW_DATA_DIR ?? "/tmp/haiflow";
const PORT = Number(process.env.PORT ?? 3333);
const API_KEY = process.env.HAIFLOW_API_KEY?.trim();
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Max prompt/message size: 512KB — safely under Claude Code's ~150K usable token budget
// and under tmux/OS transport limits. The file-based fallback in sendToTmux handles delivery.
const MAX_PROMPT_SIZE = 512_000;

if (!API_KEY) {
  console.error("HAIFLOW_API_KEY is required. Set it in your .env or environment.");
  process.exit(1);
}

mkdirSync(BASE_DIR, { recursive: true });

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

function readPipeline(): PipelineConfig {
  const file = `${BASE_DIR}/pipeline.json`;
  if (!existsSync(file)) return EMPTY_PIPELINE;
  try {
    const raw = readFileSync(file, "utf-8");
    const config = JSON.parse(raw);
    return { topics: config.topics ?? {}, emitters: config.emitters ?? {} };
  } catch {
    log("warn", "pipeline_config_invalid", { file });
    return EMPTY_PIPELINE;
  }
}

// --- Redis pub/sub ---

let redisPublisher: RedisClient | null = null;
let redisSubscriber: RedisClient | null = null;
let redisAvailable = false;

// Recent pipeline events for introspection (ring buffer)
const pipelineEvents: Array<{
  topic: string;
  sourceSession: string;
  taskId: string;
  subscribers: string[];
  publishedAt: string;
}> = [];
const MAX_EVENTS = 50;

function trackEvent(event: typeof pipelineEvents[number]) {
  pipelineEvents.push(event);
  if (pipelineEvents.length > MAX_EVENTS) pipelineEvents.shift();
}

async function initRedis() {
  try {
    redisPublisher = new RedisClient(REDIS_URL);
    await redisPublisher.connect();
    redisSubscriber = await redisPublisher.duplicate();

    const pipeline = readPipeline();
    const topicNames = Object.keys(pipeline.topics);

    for (const topic of topicNames) {
      await redisSubscriber.subscribe(`haiflow:${topic}`, (rawMessage: string) => {
        try {
          const event = JSON.parse(rawMessage);
          // Use the channel topic, not the message body — prevents spoofing
          handlePipelineEvent(topic, event);
        } catch {
          log("error", "pipeline_message_parse_failed", { topic });
        }
      });
    }

    redisAvailable = true;
    const safeUrl = REDIS_URL.replace(/:\/\/[^@]+@/, "://*****@");
    log("info", "redis_connected", { url: safeUrl, topics: topicNames });
  } catch (err) {
    const safeUrl = REDIS_URL.replace(/:\/\/[^@]+@/, "://*****@");
    log("warn", "redis_unavailable", { url: safeUrl, error: String(err) });
    redisAvailable = false;
  }
}

function handlePipelineEvent(
  topic: string,
  event: { session: string; taskId: string; message: string; chain?: string[] }
) {
  const pipeline = readPipeline();
  const topicConfig = pipeline.topics[topic];
  if (!topicConfig) return;

  const chain = [...(event.chain ?? []), event.session];
  const subscriberNames: string[] = [];

  for (const sub of topicConfig.subscribers) {
    if (sub.enabled === false) continue;

    const subscriberSession = sanitizeSession(sub.session);

    // Circular protection: skip if this session is already in the chain
    if (chain.includes(subscriberSession)) {
      log("warn", "pipeline_circular_skipped", { topic, subscriber: subscriberSession, chain });
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
      continue;
    }

    // Hard structural block check on rendered prompt
    const validation = validateStructural(prompt);
    if (!validation.ok) {
      log("warn", "pipeline_prompt_rejected", { topic, subscriber: subscriberSession, reason: validation.reason });
      continue;
    }

    const taskId = generateId();
    const state = readState(subscriberSession);

    if (state.status === "offline") {
      // Queue anyway so it's picked up when session starts
      const queue = readQueue(subscriberSession);
      queue.push({ id: taskId, prompt, addedAt: new Date().toISOString(), source: `pipeline:${topic}`, chain });
      writeQueue(subscriberSession, queue);
      log("warn", "pipeline_subscriber_offline", { topic, subscriber: subscriberSession, taskId });
      subscriberNames.push(subscriberSession);
      continue;
    }

    if (state.status === "busy") {
      const queue = readQueue(subscriberSession);
      queue.push({ id: taskId, prompt, addedAt: new Date().toISOString(), source: `pipeline:${topic}`, chain });
      writeQueue(subscriberSession, queue);
      log("info", "pipeline_queued", { topic, subscriber: subscriberSession, taskId });
      subscriberNames.push(subscriberSession);
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
    subscriberNames.push(subscriberSession);
  }

  // Fire outbound webhooks
  for (const wh of topicConfig.webhooks ?? []) {
    if (wh.enabled === false) continue;

    const payload = {
      topic,
      sourceSession: event.session,
      taskId: event.taskId,
      message: event.message,
      publishedAt: new Date().toISOString(),
    };

    fetch(wh.url, {
      method: wh.method ?? "POST",
      headers: { "Content-Type": "application/json", ...wh.headers },
      body: JSON.stringify(payload),
    }).then(() => {
      log("info", "pipeline_webhook_sent", { topic, url: wh.url });
    }).catch((err) => {
      log("error", "pipeline_webhook_failed", { topic, url: wh.url, error: String(err) });
    });

    subscriberNames.push(`webhook:${wh.url}`);
  }

  trackEvent({
    topic,
    sourceSession: event.session,
    taskId: event.taskId,
    subscribers: subscriberNames,
    publishedAt: new Date().toISOString(),
  });
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

  if (redisAvailable && redisPublisher) {
    const message = JSON.stringify({ topic, ...payload, publishedAt: new Date().toISOString() });
    await redisPublisher.publish(`haiflow:${topic}`, message);
    log("info", "event_published", { topic, session: payload.session, taskId: payload.taskId });
  } else {
    // Direct dispatch fallback when Redis is unavailable
    handlePipelineEvent(topic, payload);
    log("info", "event_published_direct", { topic, session: payload.session, taskId: payload.taskId });
  }
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

  // Prepend security preamble so Claude enforces .env, cwd, and injection rules
  const state = readState(session);
  const preamble = buildSecurityPreamble(state.cwd);
  const fullPrompt = preamble + prompt;

  const target = tmuxName(session);

  // For large prompts, write to a temp file and tell Claude to read it
  // to avoid tmux send-keys buffer limits
  if (fullPrompt.length > 2000) {
    const tmpFile = `/tmp/haiflow-prompt-${crypto.randomUUID()}.txt`;
    writeFileSync(tmpFile, fullPrompt, { mode: 0o600 });
    const shortPrompt = `Read the file ${tmpFile} and follow the instructions in it exactly.`;
    const result = Bun.spawnSync(["tmux", "send-keys", "-t", target, shortPrompt, "Enter"]);
    // Clean up temp file after a delay (give Claude time to read it)
    setTimeout(() => { try { unlinkSync(tmpFile); } catch {} }, 60_000);
    return result.exitCode === 0;
  }

  const result = Bun.spawnSync(["tmux", "send-keys", "-t", target, fullPrompt, "Enter"]);
  return result.exitCode === 0;
}

function isTmuxRunning(session: string): boolean {
  const result = Bun.spawnSync(["tmux", "has-session", "-t", tmuxName(session)]);
  return result.exitCode === 0;
}

function saveResponse(session: string, taskId: string, transcriptPath?: string, lastMessage?: string) {
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
          id: taskId, completed_at: new Date().toISOString(), messages,
        }, null, 2));
        log("info", "response_saved", { session, taskId, source: "transcript" });
        return;
      }
    } catch {}
  }

  if (lastMessage) {
    writeFileSync(file, JSON.stringify({
      id: taskId, completed_at: new Date().toISOString(), messages: [lastMessage],
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

function startClaudeSession(session: string, cwd: string): { success: boolean; error?: string } {
  if (isTmuxRunning(session)) {
    log("info", "session_reused", { session });
    writeState(session, { status: "idle", since: new Date().toISOString(), cwd });
    return { success: true };
  }

  const result = Bun.spawnSync([
    "tmux", "new-session", "-d", "-s", tmuxName(session), "-c", cwd,
    "claude", "--dangerously-skip-permissions",
  ]);

  if (result.exitCode !== 0) {
    log("error", "session_start_failed", { session, error: result.stderr.toString() });
    return { success: false, error: result.stderr.toString() };
  }

  setSessionId(session, null);
  writeState(session, { status: "idle", since: new Date().toISOString(), cwd });
  log("info", "session_started", { session, cwd });
  return { success: true };
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
      GET: authed(() => {
        const pipeline = readPipeline();
        return Response.json({ ...pipeline, redis: redisAvailable, recentEvents: pipelineEvents.slice(-10) });
      }),
    },

    "/pipeline/topics": {
      GET: authed(() => {
        const pipeline = readPipeline();
        return Response.json(Object.keys(pipeline.topics));
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
          saveResponse(session, state.currentTaskId, body.transcript_path, body.last_assistant_message);

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
        const cwd = body.cwd as string | undefined;

        if (!cwd) {
          return Response.json({ error: "cwd is required" }, { status: 400 });
        }

        const result = startClaudeSession(session, cwd);
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

    "/health": new Response("ok"),
    "/dashboard": dashboard,
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

// Initialize Redis for pipeline pub/sub (non-blocking — falls back to direct dispatch)
initRedis();
