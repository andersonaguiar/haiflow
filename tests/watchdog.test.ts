import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";

const TEST_PORT = 9880;
const TEST_DIR = "/tmp/haiflow-watchdog-test";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.spawn>;
const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object, headers: Record<string, string> = authHeaders) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

function seed(session: string, claudeId: string, state: object) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify(state));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_GUARDRAILS: "false" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(() => {
  server?.kill();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("POST /hooks/notification", () => {
  test("flags a busy session as waiting", async () => {
    seed("wd-busy", "claude-wd-busy", { status: "busy", since: new Date().toISOString(), currentTaskId: "t1" });
    const { data } = await api("/hooks/notification", "POST", {
      session_id: "claude-wd-busy",
      message: "Claude needs your permission to use Bash",
    });
    expect(data.ok).toBe(true);

    const status = await api("/status?session=wd-busy");
    expect(status.data.waiting).toBe(true);
    expect(status.data.waitingMessage).toContain("permission");
  });

  test("ignores notification on an idle session (normal idle-waiting)", async () => {
    seed("wd-idle", "claude-wd-idle", { status: "idle", since: new Date().toISOString() });
    await api("/hooks/notification", "POST", { session_id: "claude-wd-idle", message: "waiting for input" });
    const status = await api("/status?session=wd-idle");
    expect(status.data.waiting).toBeUndefined();
  });

  test("returns ok for unknown session", async () => {
    const { data } = await api("/hooks/notification", "POST", { session_id: "nope" });
    expect(data.ok).toBe(true);
  });

  test("notification is rejected through a proxy header", async () => {
    const res = await fetch(`${BASE}/hooks/notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "1.2.3.4" },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /interrupt", () => {
  test("404 when the session is not running", async () => {
    const { status, data } = await api("/interrupt", "POST", { session: "not-running" });
    expect(status).toBe(404);
    expect(data.error).toContain("not running");
  });

  test("requires auth", async () => {
    const res = await fetch(`${BASE}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("prompt hook clears a prior waiting flag", async () => {
    seed("wd-clear", "claude-wd-clear", { status: "busy", since: new Date().toISOString(), waiting: true, waitingMessage: "blocked", currentTaskId: "t9" });
    await api("/hooks/prompt", "POST", { session_id: "claude-wd-clear", prompt: "carry on" });
    const status = await api("/status?session=wd-clear");
    expect(status.data.waiting).toBe(false);
  });
});
