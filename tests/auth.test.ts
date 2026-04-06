import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";

const TEST_PORT = 9877;
const TEST_DIR = "/tmp/haiflow-auth-test";
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-secret-key-123";

let server: ReturnType<typeof Bun.spawn>;

async function api(path: string, method = "GET", body?: object, token?: string) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text(),
  };
}

function writeState(session: string, state: object) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/state.json`, JSON.stringify(state));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: API_KEY },
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(() => {
  server?.kill();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// --- Auth: public routes require token ---

describe("auth", () => {
  test("health bypasses auth", async () => {
    const { status } = await api("/health");
    expect(status).toBe(200);
  });

  test("hooks bypass auth", async () => {
    const { status, data } = await api("/hooks/session-start", "POST", { session_id: "test" });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  test("hooks/prompt bypasses auth", async () => {
    const { status, data } = await api("/hooks/prompt", "POST", { session_id: "test", prompt: "hi" });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  test("hooks/stop bypasses auth", async () => {
    const { status, data } = await api("/hooks/stop", "POST", { session_id: "test" });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  test("hooks/session-end bypasses auth", async () => {
    const { status, data } = await api("/hooks/session-end", "POST", { session_id: "test" });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  test("rejects requests without token", async () => {
    const { status, data } = await api("/sessions");
    expect(status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  test("rejects requests with wrong token", async () => {
    const { status, data } = await api("/sessions", "GET", undefined, "wrong-key");
    expect(status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  test("accepts requests with correct token", async () => {
    const { status } = await api("/sessions", "GET", undefined, API_KEY);
    expect(status).toBe(200);
  });

  test("protects /status", async () => {
    const noAuth = await api("/status");
    expect(noAuth.status).toBe(401);

    const withAuth = await api("/status", "GET", undefined, API_KEY);
    expect(withAuth.status).toBe(200);
  });

  test("protects /trigger", async () => {
    const { status } = await api("/trigger", "POST", { prompt: "test" });
    expect(status).toBe(401);
  });

  test("protects /queue GET", async () => {
    const { status } = await api("/queue");
    expect(status).toBe(401);
  });

  test("protects /queue DELETE", async () => {
    const { status } = await api("/queue", "DELETE");
    expect(status).toBe(401);
  });

  test("protects /responses", async () => {
    const { status } = await api("/responses");
    expect(status).toBe(401);
  });

  test("protects /responses/:id", async () => {
    const { status } = await api("/responses/test-id");
    expect(status).toBe(401);
  });

  test("protects /responses/:id/stream", async () => {
    const res = await fetch(`${BASE}/responses/test-id/stream`);
    expect(res.status).toBe(401);
  });

  test("protects /session/start", async () => {
    const { status } = await api("/session/start", "POST", { cwd: "/tmp" });
    expect(status).toBe(401);
  });

  test("protects /session/stop", async () => {
    const { status } = await api("/session/stop", "POST", {});
    expect(status).toBe(401);
  });

  test("protects DELETE /responses", async () => {
    const { status } = await api("/responses", "DELETE");
    expect(status).toBe(401);
  });

  test("protects /pipeline", async () => {
    const { status } = await api("/pipeline");
    expect(status).toBe(401);
  });

  test("protects /pipeline/topics", async () => {
    const { status } = await api("/pipeline/topics");
    expect(status).toBe(401);
  });

  test("protects /publish", async () => {
    const { status } = await api("/publish", "POST", { topic: "t", message: "m" });
    expect(status).toBe(401);
  });
});
