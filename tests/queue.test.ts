import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";

const TEST_PORT = 9882;
const TEST_DIR = "/tmp/haiflow-queue-test";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.spawn>;
const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

// Seed a busy session that haiflow can drive (has a session-id so the Stop hook
// resolves it). Returns the claude id.
function seedBusy(session: string, taskId = "current"): string {
  const claudeId = `claude-${session}`;
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "busy", since: new Date().toISOString(), currentTaskId: taskId }));
  return claudeId;
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

describe("smart queue", () => {
  test("drains the highest-priority eligible item first", async () => {
    const session = "q-prio";
    const claudeId = seedBusy(session);
    await api("/trigger", "POST", { prompt: "low", session, id: "p-low", priority: 0 });
    await api("/trigger", "POST", { prompt: "high", session, id: "p-high", priority: 5 });
    await api("/trigger", "POST", { prompt: "mid", session, id: "p-mid", priority: 1 });

    // Stop the current task -> drains the queue by priority
    await api("/hooks/stop", "POST", { session_id: claudeId, last_assistant_message: "done" });

    const status = await api(`/status?session=${session}`);
    expect(status.data.currentTaskId).toBe("p-high");
  });

  test("dedup drops a second enqueue with the same dedupKey", async () => {
    const session = "q-dedup";
    seedBusy(session);
    const first = await api("/trigger", "POST", { prompt: "x", session, id: "d1", dedupKey: "webhook-42" });
    expect(first.data.queued).toBe(true);
    const second = await api("/trigger", "POST", { prompt: "x", session, id: "d2", dedupKey: "webhook-42" });
    expect(second.data.deduped).toBe(true);

    const queue = await api(`/queue?session=${session}`);
    expect(queue.data.length).toBe(1);
  });

  test("delayed trigger on an idle session is queued, not sent", async () => {
    const session = "q-delay";
    mkdirSync(`${TEST_DIR}/${session}/responses`, { recursive: true });
    writeFileSync(`${TEST_DIR}/${session}/state.json`, JSON.stringify({ status: "idle", since: new Date().toISOString() }));

    const res = await api("/trigger", "POST", { prompt: "later", session, id: "delayed-1", delaySeconds: 60 });
    expect(res.data.queued).toBe(true);
    expect(res.data.notBefore).toBeDefined();

    const status = await api(`/status?session=${session}`);
    expect(status.data.status).toBe("idle"); // not sent yet
    const queue = await api(`/queue?session=${session}`);
    expect(queue.data.length).toBe(1);
  });

  test("POST /queue/:id re-prioritises a queued item", async () => {
    const session = "q-reprio";
    seedBusy(session);
    await api("/trigger", "POST", { prompt: "a", session, id: "r1" });
    const res = await api(`/queue/r1?session=${session}`, "POST", { priority: 9 });
    expect(res.status).toBe(200);
    expect(res.data.priority).toBe(9);
    const queue = await api(`/queue?session=${session}`);
    expect(queue.data.items[0].priority).toBe(9);
  });
});
