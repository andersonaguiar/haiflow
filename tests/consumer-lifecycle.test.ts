import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";

/**
 * Consumer lifecycle e2e — simulates an external service driving haiflow end to
 * end: POST /session/start → POST /trigger (the payload) → stream the response
 * → POST /session/stop. This is the exact sequence n8n, scripts, and other
 * consumers run, and the flow people report breaking.
 *
 * Unlike tests/integration.test.ts (which needs the real Claude CLI + auth and
 * is skipped in CI), this drives a FAKE Claude (tests/fixtures/fake-claude.ts)
 * exposed on PATH as `claude`. haiflow spawns it in tmux exactly as it would the
 * real CLI, so every HTTP contract, hook handshake, and tmux send path is
 * exercised for real — only the model is faked. That makes the consumer
 * lifecycle deterministic and runnable anywhere tmux exists.
 */

const TEST_PORT = 9899; // outside the 9876-9890 cluster other test files use
const TEST_DIR = "/tmp/haiflow-consumer-test";
const BIN_DIR = "/tmp/haiflow-consumer-bin";
const TEST_API_KEY = "consumer-test-key";
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SESSION = "consumer-test";
// Every session name this file may start, so setup/teardown can kill leftovers
// from an aborted prior run (otherwise a stale tmux session is "reused" and the
// next run sees the wrong state).
const ALL_SESSIONS = [SESSION, "consumer-fof", "consumer-both", "consumer-nolink", "consumer-nocwd-fof"];
const TIMEOUT = 30_000;

const FAKE_SRC = join(import.meta.dir, "fixtures", "fake-claude.ts");
const HAS_TMUX = !!Bun.which("tmux");

let server: ReturnType<typeof Bun.spawn>;

const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) return { status: res.status, data: await res.json() };
  return { status: res.status, data: await res.text() };
}

interface SSEEvent {
  event: string;
  data: any;
}

// Parse every SSE event in a buffered stream body. Defensive against malformed
// data lines so a parse glitch surfaces as a readable failure, not a throw deep
// inside a test. Mirrors how an EventSource consumer dispatches by event name.
function parseSSEEvents(text: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    let data: any = dataLine.slice(6);
    try {
      data = JSON.parse(data);
    } catch {
      /* keep the raw string for the failure message */
    }
    events.push({ event: eventLine.slice(7).trim(), data });
  }
  return events;
}

// Reduce a stream to its terminal payload (the `complete` data, or an `error`).
function finalResult(events: SSEEvent[]): { messages?: string[]; error?: string } {
  for (const e of [...events].reverse()) {
    if (e.event === "complete") return e.data;
    if (e.event === "error") return { error: e.data?.error ?? "stream error" };
  }
  return { error: `no complete event (got: ${events.map((e) => e.event).join(",") || "nothing"})` };
}

async function streamRaw(id: string, timeoutSec = 20, session = SESSION): Promise<SSEEvent[]> {
  const res = await fetch(`${BASE}/responses/${id}/stream?session=${session}&timeout=${timeoutSec}`, {
    headers: authHeaders,
  });
  return parseSSEEvents(await res.text());
}

async function streamResponse(id: string, timeoutSec = 20, session = SESSION) {
  return finalResult(await streamRaw(id, timeoutSec, session));
}

// Poll /status until it reaches `target` (or time out). Avoids racing a single
// status snapshot against the fake's processing window.
async function waitForStatus(target: string, maxMs = 4000, session = SESSION): Promise<string> {
  const deadline = Date.now() + maxMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await api(`/status?session=${session}`);
    last = r.data.status;
    if (last === target) return last;
    await Bun.sleep(50);
  }
  return last;
}

// A local receiver for fire-and-forget completion callbacks. Records every POST
// body and wakes any waiter the instant a matching one arrives (event-driven —
// no polling). If a callback never arrives, the per-test timeout surfaces it.
let callbackServer: ReturnType<typeof Bun.serve> | undefined;
let callbackPort = 0;
const receivedCallbacks: any[] = [];
const callbackWaiters: Array<{ match: (c: any) => boolean; resolve: (c: any) => void }> = [];

function recordCallback(body: any): void {
  receivedCallbacks.push(body);
  for (let i = callbackWaiters.length - 1; i >= 0; i--) {
    if (callbackWaiters[i]!.match(body)) {
      callbackWaiters[i]!.resolve(body);
      callbackWaiters.splice(i, 1);
    }
  }
}

function waitForCallback(match: (cb: any) => boolean): Promise<any> {
  const existing = receivedCallbacks.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => callbackWaiters.push({ match, resolve }));
}

beforeAll(async () => {
  for (const s of ALL_SESSIONS) Bun.spawnSync(["tmux", "kill-session", "-t", s]);
  for (const dir of [TEST_DIR, BIN_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  // Expose the fake as `claude` on a bin dir we prepend to PATH. A tiny sh
  // shim execs it with the absolute bun path so resolution never depends on the
  // tmux session's own PATH for `bun` itself.
  mkdirSync(BIN_DIR, { recursive: true });
  const shim = join(BIN_DIR, "claude");
  await Bun.write(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SRC)} "$@"\n`);
  chmodSync(shim, 0o755);

  // Local receiver for completion callbacks.
  callbackServer = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST") {
        try {
          recordCallback(await req.json());
        } catch {
          recordCallback(null);
        }
      }
      return new Response("ok");
    },
  });
  callbackPort = callbackServer.port ?? 0;

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PATH: `${BIN_DIR}:${process.env.PATH}`,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_PORT: String(TEST_PORT),
      // Keep the prompt-tip clean: the guardrail slash command isn't part of the
      // plumbing under test and would race with the fake's input handling.
      HAIFLOW_GUARDRAILS: "false",
      // The fake links in ~100ms, so a happy-path start returns immediately
      // regardless of this ceiling — it only bounds the FAILURE case (the
      // unlinked-start test, which waits the full window). 6s keeps that test
      // brisk while leaving generous headroom for a slow link under load.
      HAIFLOW_START_READY_TIMEOUT_MS: "6000",
      // Enable per-trigger completion callbacks, restricted to our local receiver.
      HAIFLOW_ALLOW_TRIGGER_CALLBACK: "true",
      HAIFLOW_CALLBACK_ALLOW_HOSTS: "127.0.0.1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(async () => {
  try {
    await api("/session/stop", "POST", { session: SESSION });
  } catch {}
  for (const s of ALL_SESSIONS) Bun.spawnSync(["tmux", "kill-session", "-t", s]);
  server?.kill();
  await server?.exited; // wait for actual exit (frees the port deterministically)
  callbackServer?.stop(true);
  for (const dir of [TEST_DIR, BIN_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("consumer lifecycle", () => {
  test.skipIf(!HAS_TMUX)(
    "start session → send payload → haiflow processes → returns → stop",
    async () => {
      // 1. A consumer starts a session.
      const start = await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });
      expect(start.status).toBe(200);
      expect(start.data.started).toBe(true);

      // 2. The session reports idle and ready.
      const idle = await api(`/status?session=${SESSION}`);
      expect(idle.status).toBe(200);
      expect(idle.data.status).toBe("idle");

      // 3. The consumer sends a payload. The <<sleep>> token keeps the fake
      //    "processing" long enough to observe the busy state below.
      const id = "consumer-1";
      const trigger = await api("/trigger", "POST", {
        prompt: "process this consumer payload <<sleep:1500>>",
        session: SESSION,
        id,
        source: "consumer-test",
      });
      expect(trigger.status).toBe(200);
      expect(trigger.data.sent).toBe(true);
      expect(trigger.data.id).toBe(id);

      // 4. While processing, the session is busy (polled, not a racy snapshot).
      expect(await waitForStatus("busy")).toBe("busy");

      // 5. The consumer streams the response and gets it back.
      const result = await streamResponse(id);
      expect(result.error).toBeUndefined();
      expect(result.messages).toBeDefined();
      expect(result.messages!.length).toBeGreaterThan(0);
      const text = result.messages!.join("\n");
      expect(text).toContain("FAKE-CLAUDE-REPLY");
      expect(text).toContain("process this consumer payload");

      // 6. The response is persisted for polling consumers too.
      const persisted = await api(`/responses/${id}?session=${SESSION}`);
      expect(persisted.status).toBe(200);
      expect(persisted.data.messages.join("\n")).toContain("process this consumer payload");

      // 7. The session returns to idle.
      expect(await waitForStatus("idle")).toBe("idle");

      // 8. The consumer stops the session.
      const stop = await api("/session/stop", "POST", { session: SESSION });
      expect(stop.status).toBe(200);
      expect(stop.data.stopped).toBe(true);
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "delivers a multiline payload as a single prompt, intact",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      // A realistic multiline payload (under the 2000-char direct-send limit, so
      // it goes through tmux send-keys verbatim — the path most consumers hit).
      const payload = [
        "Line one of the payload.",
        "Line two has  internal   spacing kept.",
        "",
        "Line four after a blank line.",
        "Final line, no trailing newline.",
      ].join("\n");

      const id = "consumer-multiline";
      const trigger = await api("/trigger", "POST", { prompt: payload, session: SESSION, id });
      expect(trigger.status).toBe(200);
      expect(trigger.data.sent).toBe(true);

      const result = await streamResponse(id);
      expect(result.error).toBeUndefined();
      const text = result.messages!.join("\n");

      // The whole multiline payload survived as one prompt: every line present,
      // in order, and reported as 5 lines (newlines preserved, not split into
      // separate prompts).
      expect(text).toContain(payload);
      expect(text).toContain("lines=5");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "delivers a large multiline payload via the temp-file path",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      // Over 2000 chars → haiflow writes it to a temp file and tells Claude to
      // read it. A unique marker on a distinct line proves the big multiline
      // body arrived whole through that path.
      const marker = "MARKER-7f3a-payload-intact";
      const filler = Array.from({ length: 80 }, (_, i) => `line ${i} of a big payload with some words to pad it out`);
      const payload = [marker, ...filler].join("\n");
      expect(payload.length).toBeGreaterThan(2000);

      const id = "consumer-large";
      const trigger = await api("/trigger", "POST", { prompt: payload, session: SESSION, id });
      expect(trigger.status).toBe(200);
      expect(trigger.data.sent).toBe(true);

      const result = await streamResponse(id, 25);
      expect(result.error).toBeUndefined();
      const text = result.messages!.join("\n");
      expect(text).toContain(marker);
      expect(text).toContain("line 79 of a big payload");
      expect(text).toContain(`lines=${payload.split("\n").length}`);

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "captures the response from the transcript (primary path) with usage + model",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      // <<transcript>> makes the fake report via a real Claude transcript +
      // transcript_path (haiflow's primary capture path) rather than the
      // last_assistant_message fallback.
      const id = "consumer-transcript";
      const trigger = await api("/trigger", "POST", {
        prompt: "summarize the payload <<transcript>>",
        session: SESSION,
        id,
      });
      expect(trigger.data.sent).toBe(true);

      const result = await streamResponse(id);
      const text = result.messages!.join("\n");
      // The transcript text won, not the fallback string.
      expect(text).toContain("TRANSCRIPT-SOURCED");
      expect(text).not.toContain("FALLBACK-should-not-win");

      // The ledger mined usage + model from the transcript for this task.
      const task = await api(`/tasks/${id}?session=${SESSION}`);
      expect(task.status).toBe(200);
      expect(task.data.model).toBe("claude-fake-1");
      expect(task.data.usage.totalTokens).toBe(59); // 42 input + 17 output

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "streams a status event before the response completes",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      const id = "consumer-sse-status";
      await api("/trigger", "POST", { prompt: "slow one <<sleep:2500>>", session: SESSION, id });

      // The consumer opens the stream while the task is still running, so it
      // should see at least one `status: pending` event ahead of `complete`.
      const events = await streamRaw(id, 20);
      const statusIdx = events.findIndex((e) => e.event === "status" && e.data?.status === "pending");
      const completeIdx = events.findIndex((e) => e.event === "complete");
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      expect(completeIdx).toBeGreaterThan(statusIdx);
      expect(finalResult(events).messages!.join("\n")).toContain("slow one");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "polling a response while it's still running returns 202 pending",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      const id = "consumer-pending";
      await api("/trigger", "POST", { prompt: "long task <<sleep:2500>>", session: SESSION, id });

      // A polling consumer (no SSE) gets a 202 while the task is in flight.
      const pending = await api(`/responses/${id}?session=${SESSION}`);
      expect(pending.status).toBe(202);
      expect(pending.data.status).toBe("pending");

      // And a 200 once it finishes.
      const done = await streamResponse(id);
      expect(done.messages!.join("\n")).toContain("long task");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "queues a second payload while busy and drains it in order",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      // First payload holds the session busy long enough for the second to queue.
      const first = await api("/trigger", "POST", {
        prompt: "first payload PAYLOAD-ONE <<sleep:2000>>",
        session: SESSION,
        id: "consumer-q1",
      });
      expect(first.data.sent).toBe(true);

      const second = await api("/trigger", "POST", {
        prompt: "second payload PAYLOAD-TWO",
        session: SESSION,
        id: "consumer-q2",
      });
      expect(second.data.queued).toBe(true);
      expect(second.data.position).toBe(1);

      const r1 = await streamResponse("consumer-q1");
      expect(r1.messages!.join("\n")).toContain("PAYLOAD-ONE");

      // The queued payload auto-drains and completes on its own.
      const r2 = await streamResponse("consumer-q2");
      expect(r2.messages!.join("\n")).toContain("PAYLOAD-TWO");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT * 2
  );

  test.skipIf(!HAS_TMUX)(
    "starting an already-running session is idempotent",
    async () => {
      const first = await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });
      expect(first.data.started).toBe(true);

      // A consumer that re-issues start (e.g. a retry) gets a clean 200, not an
      // error, and the session is reused rather than re-spawned.
      const again = await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });
      expect(again.status).toBe(200);
      expect(again.data.started).toBe(true);
      expect(again.data.session).toBe(SESSION);

      // Still usable after the redundant start.
      await api("/trigger", "POST", { prompt: "still works AFTER-REDUNDANT-START", session: SESSION, id: "consumer-idem" });
      const result = await streamResponse("consumer-idem");
      expect(result.messages!.join("\n")).toContain("AFTER-REDUNDANT-START");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );
});

describe("consumer error paths", () => {
  test.skipIf(!HAS_TMUX)(
    "sending a payload to a stopped session returns 503 offline",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });
      await api("/session/stop", "POST", { session: SESSION });

      // A consumer that triggers after stopping (or after a crash) is told the
      // session is offline instead of having the payload silently swallowed.
      const trigger = await api("/trigger", "POST", { prompt: "too late", session: SESSION, id: "consumer-offline" });
      expect(trigger.status).toBe(503);
      expect(String(trigger.data.error).toLowerCase()).toContain("offline");
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "stopping a session that was never started returns 404",
    async () => {
      const stop = await api("/session/stop", "POST", { session: "consumer-never-started" });
      expect(stop.status).toBe(404);
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "polling an unknown response id returns 404",
    async () => {
      const res = await api(`/responses/no-such-task-id?session=${SESSION}`);
      expect(res.status).toBe(404);
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "a session whose hooks never link fails start instead of silently dropping payloads",
    async () => {
      const nolinkDir = "/tmp/haiflow-consumer-nolink";
      mkdirSync(nolinkDir, { recursive: true });
      const nolinkSession = "consumer-nolink";
      Bun.spawnSync(["tmux", "kill-session", "-t", nolinkSession]);

      // The fake (started in a *nolink cwd) never fires SessionStart, so haiflow
      // can't link a session id. Start must fail loudly (the consumer's payloads
      // would otherwise be accepted but never answered), not report started:true.
      const start = await api("/session/start", "POST", { session: nolinkSession, cwd: nolinkDir });
      expect(start.status).toBe(409);
      expect(start.data.session).toBe(nolinkSession);
      expect(String(start.data.error).toLowerCase()).toContain("hooks");

      // The dead pane was torn down, not left orphaned.
      expect(Bun.spawnSync(["tmux", "has-session", "-t", nolinkSession]).exitCode).not.toBe(0);

      Bun.spawnSync(["tmux", "kill-session", "-t", nolinkSession]);
      if (existsSync(nolinkDir)) rmSync(nolinkDir, { recursive: true, force: true });
    },
    TIMEOUT
  );
});

describe("fire-and-forget", () => {
  test.skipIf(!HAS_TMUX)(
    "ephemeral: one trigger auto-starts an offline session and stops it after responding",
    async () => {
      const fofSession = "consumer-fof";
      Bun.spawnSync(["tmux", "kill-session", "-t", fofSession]); // ensure offline

      // A single trigger to an offline session with ephemeral+cwd: haiflow brings
      // the session up, runs the one task, and tears it down afterwards.
      const id = "fof-1";
      const trigger = await api("/trigger", "POST", {
        prompt: "fire and forget ME-EPHEMERAL",
        session: fofSession,
        cwd: "/tmp",
        ephemeral: true,
        id,
      });
      expect(trigger.status).toBe(200);
      expect(trigger.data.sent).toBe(true);
      expect(trigger.data.autoStarted).toBe(true);
      expect(trigger.data.ephemeral).toBe(true);

      const result = await streamResponse(id, 20, fofSession);
      expect(result.error).toBeUndefined();
      expect(result.messages!.join("\n")).toContain("ME-EPHEMERAL");

      // The session was stopped automatically once it responded.
      expect(await waitForStatus("offline", 8000, fofSession)).toBe("offline");
      expect(Bun.spawnSync(["tmux", "has-session", "-t", fofSession]).exitCode).not.toBe(0);
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "callbackUrl: haiflow POSTs the result to the caller's webhook on completion",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      const id = "cb-1";
      const trigger = await api("/trigger", "POST", {
        prompt: "please call me back CALLBACK-PAYLOAD",
        session: SESSION,
        callbackUrl: `http://127.0.0.1:${callbackPort}/cb`,
        id,
      });
      expect(trigger.data.sent).toBe(true);
      expect(trigger.data.callbackScheduled).toBe(true);

      await streamResponse(id);

      const cb = await waitForCallback((c) => c && c.id === id);
      expect(cb).toBeDefined();
      expect(cb.event).toBe("task.completed");
      expect(cb.session).toBe(SESSION);
      expect(cb.status).toBe("completed");
      expect(cb.messages.join("\n")).toContain("CALLBACK-PAYLOAD");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "both: ephemeral lifecycle and a completion callback together",
    async () => {
      const bothSession = "consumer-both";
      Bun.spawnSync(["tmux", "kill-session", "-t", bothSession]);

      const id = "both-1";
      const trigger = await api("/trigger", "POST", {
        prompt: "do both BOTH-PAYLOAD",
        session: bothSession,
        cwd: "/tmp",
        ephemeral: true,
        callbackUrl: `http://127.0.0.1:${callbackPort}/cb`,
        id,
      });
      expect(trigger.data.autoStarted).toBe(true);
      expect(trigger.data.callbackScheduled).toBe(true);

      await streamResponse(id, 20, bothSession);

      const cb = await waitForCallback((c) => c && c.id === id);
      expect(cb).toBeDefined();
      expect(cb.messages.join("\n")).toContain("BOTH-PAYLOAD");
      expect(await waitForStatus("offline", 8000, bothSession)).toBe("offline");
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "rejects a callbackUrl whose host is not allowlisted",
    async () => {
      await api("/session/start", "POST", { session: SESSION, cwd: "/tmp" });

      const bad = await api("/trigger", "POST", {
        prompt: "x",
        session: SESSION,
        callbackUrl: "http://example.com/hook",
        id: "cb-bad",
      });
      expect(bad.status).toBe(400);
      expect(String(bad.data.error).toLowerCase()).toContain("allow");

      await api("/session/stop", "POST", { session: SESSION });
    },
    TIMEOUT
  );

  test.skipIf(!HAS_TMUX)(
    "ephemeral trigger to an offline session without a cwd is rejected",
    async () => {
      const s = "consumer-nocwd-fof";
      Bun.spawnSync(["tmux", "kill-session", "-t", s]);
      const r = await api("/trigger", "POST", { prompt: "x", session: s, ephemeral: true, id: "fof-nocwd" });
      expect(r.status).toBe(400);
      expect(String(r.data.error).toLowerCase()).toContain("cwd");
    },
    TIMEOUT
  );
});
