import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from "fs";
import { join } from "path";

/**
 * Claude fires StopFailure instead of Stop when an API error ends a turn
 * (expired login, rate limit, billing). Before haiflow handled it, such a turn
 * left the session "busy" forever: nothing ever marked it idle, so its queue
 * never drained and callers waited on a task that had already died.
 *
 * The first half seeds state and posts the hook directly. The second half runs
 * the fake Claude in tmux with guardrails on, since the guardrail command is
 * the first turn a session makes and so where an expired login surfaces.
 */

const TEST_PORT = 9901;
const TEST_DIR = "/tmp/haiflow-stop-failure-test";
const HOME_DIR = "/tmp/haiflow-stop-failure-home";
const BIN_DIR = "/tmp/haiflow-stop-failure-bin";
const WORK_DIR = "/tmp/haiflow-stop-failure-work";
const TEST_API_KEY = "stop-failure-key";
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const FAKE_SRC = join(import.meta.dir, "fixtures", "fake-claude.ts");
const HAS_TMUX = !!Bun.which("tmux");
const TMUX_SESSIONS = ["sf-authfail", "sf-oneshot", "sf-ratelimit"];

let server: ReturnType<typeof Bun.spawn>;
let callbackServer: ReturnType<typeof Bun.serve> | undefined;
const callbacks: any[] = [];

const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

function seed(session: string, claudeId: string, state: object, queue?: object[]) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify(state));
  if (queue) writeFileSync(`${dir}/queue.json`, JSON.stringify(queue));
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await Bun.sleep(50);
    last = await read();
  }
  return last;
}

beforeAll(async () => {
  for (const s of TMUX_SESSIONS) Bun.spawnSync(["tmux", "kill-session", "-t", s]);
  for (const dir of [TEST_DIR, HOME_DIR, BIN_DIR, WORK_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(HOME_DIR, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });
  for (const d of ["authfail", "ratelimit"]) mkdirSync(join(WORK_DIR, d), { recursive: true });

  const shim = join(BIN_DIR, "claude");
  await Bun.write(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SRC)} "$@"\n`);
  chmodSync(shim, 0o755);

  callbackServer = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST") callbacks.push(await req.json().catch(() => null));
      return new Response("ok");
    },
  });

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PATH: `${BIN_DIR}:${process.env.PATH}`,
      HOME: HOME_DIR,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_GUARDRAILS: "true",
      HAIFLOW_START_READY_TIMEOUT_MS: "6000",
      HAIFLOW_ALLOW_REQUEST_CWD: "true",
      HAIFLOW_ALLOW_TRIGGER_CALLBACK: "true",
      HAIFLOW_CALLBACK_ALLOW_HOSTS: "127.0.0.1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(async () => {
  for (const s of TMUX_SESSIONS) Bun.spawnSync(["tmux", "kill-session", "-t", s]);
  server?.kill();
  await server?.exited;
  callbackServer?.stop(true);
  for (const dir of [TEST_DIR, HOME_DIR, BIN_DIR, WORK_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /hooks/stop-failure", () => {
  test("fails the running task and returns the session to idle", async () => {
    seed("sf-busy", "claude-sf-busy", { status: "busy", since: new Date().toISOString(), currentTaskId: "sf-task-1", currentPrompt: "do it" });
    const { data } = await api("/hooks/stop-failure", "POST", {
      session_id: "claude-sf-busy",
      error: "authentication_failed",
      last_assistant_message: "Login expired · Please run /login",
    });
    expect(data.ok).toBe(true);

    const status = await api("/status?session=sf-busy");
    expect(status.data.status).toBe("idle");
    expect(status.data.lastFailure.error).toBe("authentication_failed");
    expect(status.data.lastFailure.message).toBe("Login expired · Please run /login");

    // Pollers and SSE streams need a definitive end, not a hang.
    const resp = await api("/responses/sf-task-1?session=sf-busy");
    expect(resp.status).toBe(200);
    expect(resp.data.messages[0]).toContain("task failed: authentication_failed");
  });

  test("hands the session the next queued task", async () => {
    seed(
      "sf-drain",
      "claude-sf-drain",
      { status: "busy", since: new Date().toISOString(), currentTaskId: "sf-drain-1" },
      [{ id: "sf-drain-2", prompt: "next", addedAt: "2026-01-01T00:00:00Z" }],
    );
    await api("/hooks/stop-failure", "POST", { session_id: "claude-sf-drain", error: "rate_limit" });

    const status = await api("/status?session=sf-drain");
    expect(status.data.status).toBe("busy");
    expect(status.data.currentTaskId).toBe("sf-drain-2");
    expect((await api("/queue?session=sf-drain")).data.length).toBe(0);
  });

  test("a turn with no task (the guardrail command) still frees the session", async () => {
    seed("sf-notask", "claude-sf-notask", { status: "busy", since: new Date().toISOString() });
    await api("/hooks/stop-failure", "POST", { session_id: "claude-sf-notask", error: "authentication_failed" });
    const status = await api("/status?session=sf-notask");
    expect(status.data.status).toBe("idle");
    expect(status.data.lastFailure.error).toBe("authentication_failed");
  });

  test("a later clean Stop clears the recorded failure", async () => {
    seed("sf-clear", "claude-sf-clear", {
      status: "busy", since: new Date().toISOString(), currentTaskId: "sf-clear-1",
      lastFailure: { error: "rate_limit", at: new Date().toISOString() },
    });
    await api("/hooks/stop", "POST", { session_id: "claude-sf-clear", last_assistant_message: "ok" });
    const status = await api("/status?session=sf-clear");
    expect(status.data.status).toBe("idle");
    expect(status.data.lastFailure).toBeUndefined();
  });

  test("returns ok for an unknown session", async () => {
    const { data } = await api("/hooks/stop-failure", "POST", { session_id: "nope", error: "rate_limit" });
    expect(data.ok).toBe(true);
  });

  test("is rejected through a proxy header", async () => {
    const res = await fetch(`${BASE}/hooks/stop-failure`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("sessions whose turns fail (fake Claude in tmux)", () => {
  test.skipIf(!HAS_TMUX)("start refuses a session whose login has expired, and tears it down", async () => {
    const start = await api("/session/start", "POST", { session: "sf-authfail", cwd: join(WORK_DIR, "authfail") });
    expect(start.status).toBe(409);
    expect(start.data.error).toContain("authentication_failed");
    expect(start.data.error).toContain("Login expired");
    expect(Bun.spawnSync(["tmux", "has-session", "-t", "sf-authfail"]).exitCode).not.toBe(0);
    expect((await api("/status?session=sf-authfail")).data.status).toBe("offline");
  }, 20_000);

  test.skipIf(!HAS_TMUX)("an ephemeral trigger reports the expired login instead of queueing forever", async () => {
    const res = await api("/trigger", "POST", {
      session: "sf-oneshot", prompt: "hello", ephemeral: true, cwd: join(WORK_DIR, "authfail"),
    });
    expect(res.status).toBe(503);
    expect(res.data.error).toContain("authentication_failed");
    expect(res.data.queued).toBeUndefined();
  }, 20_000);

  test.skipIf(!HAS_TMUX)("a transient failure keeps the session, fails the task, and calls back", async () => {
    const start = await api("/session/start", "POST", { session: "sf-ratelimit", cwd: join(WORK_DIR, "ratelimit") });
    expect(start.status).toBe(200);
    expect((await api("/status?session=sf-ratelimit")).data.lastFailure.error).toBe("rate_limit");

    const id = "sf-rl-task";
    const trigger = await api("/trigger", "POST", {
      session: "sf-ratelimit", prompt: "hello", id,
      callbackUrl: `http://127.0.0.1:${callbackServer!.port}/done`,
    });
    expect(trigger.data.sent).toBe(true);

    const cbs = await until(async () => callbacks.filter((c) => c?.id === id), (l) => l.length > 0);
    expect(cbs[0].event).toBe("task.failed");
    expect(cbs[0].status).toBe("failed");
    expect(cbs[0].error).toBe("rate_limit");

    const status = await until(() => api("/status?session=sf-ratelimit"), (r) => r.data.status === "idle");
    expect(status.data.status).toBe("idle");

    const task = await api(`/tasks/${id}?session=sf-ratelimit`);
    expect(task.data.status).toBe("failed");
    expect(task.data.error).toContain("rate_limit");
    expect(task.data.messages[0]).toContain("task failed: rate_limit");

    const doctor = await api("/doctor?session=sf-ratelimit");
    expect(doctor.data.healthy).toBe(true);
    expect(doctor.data.note).toContain("rate_limit");

    await api("/session/stop", "POST", { session: "sf-ratelimit" });
  }, 20_000);
});
