import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";

const TEST_PORT = 9879;
const TEST_DIR = "/tmp/haiflow-tasks-test";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;
// isAllowedTranscriptPath permits paths under /tmp/claude
const TRANSCRIPT_DIR = "/tmp/claude/haiflow-tasks-test";

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

function seedSession(session: string, claudeId: string, taskId: string) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, claudeId);
  writeFileSync(`${dir}/state.json`, JSON.stringify({
    status: "busy", since: new Date().toISOString(), currentTaskId: taskId, currentPrompt: "do the work",
  }));
}

function writeTranscript(name: string): string {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const path = `${TRANSCRIPT_DIR}/${name}.jsonl`;
  const lines = [
    { type: "user", message: { role: "user", content: "Refactor utils" } },
    { type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", content: [
      { type: "tool_use", id: "a1", name: "Bash", input: { command: "bun test" } },
    ], usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 1000 } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", is_error: false, content: "ok" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Refactor complete." }] } },
  ].map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path, lines);
  return path;
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_GUARDRAILS: "false" },
    stdout: "ignore",
    stderr: "ignore",
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
  if (existsSync(TRANSCRIPT_DIR)) rmSync(TRANSCRIPT_DIR, { recursive: true });
});

describe("task ledger endpoints", () => {
  test("Stop hook mines the transcript into a queryable task", async () => {
    const session = "ledger-e2e";
    const claudeId = "claude-ledger-e2e";
    const taskId = "task-e2e-1";
    seedSession(session, claudeId, taskId);
    const transcriptPath = writeTranscript("e2e1");

    const { data } = await api("/hooks/stop", "POST", {
      session_id: claudeId,
      transcript_path: transcriptPath,
      last_assistant_message: "Refactor complete.",
    });
    expect(data.ok).toBe(true);

    // GET /tasks
    const list = await api(`/tasks?session=${session}`);
    expect(list.status).toBe(200);
    expect(list.data.total).toBeGreaterThanOrEqual(1);
    const row = list.data.tasks.find((t: any) => t.id === taskId);
    expect(row).toBeDefined();
    expect(row.status).toBe("completed");
    expect(row.commands_run).toEqual(["bun test"]);
    expect(row.usage.totalTokens).toBe(300 + 1000);

    // GET /tasks/:id includes the saved response messages
    const one = await api(`/tasks/${taskId}?session=${session}`);
    expect(one.status).toBe(200);
    expect(one.data.steps[0].tool).toBe("Bash");
    expect(one.data.messages).toContain("Refactor complete.");

    // GET /responses/:id/timeline
    const timeline = await api(`/responses/${taskId}/timeline?session=${session}`);
    expect(timeline.status).toBe(200);
    expect(timeline.data.steps.length).toBe(1);
  });

  test("GET /usage reports tokens and savings", async () => {
    const usage = await api(`/usage?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`);
    expect(usage.status).toBe(200);
    expect(usage.data.totalTokens).toBeGreaterThanOrEqual(1300);
    expect(usage.data.savedUsd).toBeGreaterThan(0);
  });

  test("GET /usage/window returns 5h and 7d windows", async () => {
    const win = await api(`/usage/window`);
    expect(win.status).toBe(200);
    expect(win.data.windows["5h"]).toBeDefined();
    expect(win.data.windows["7d"]).toBeDefined();
  });

  test("GET /tasks/:id 404s for unknown task", async () => {
    const { status } = await api(`/tasks/nope?session=ledger-e2e`);
    expect(status).toBe(404);
  });
});
