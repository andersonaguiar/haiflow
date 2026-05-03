import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync } from "fs";

/**
 * Integration tests — starts a REAL Claude Code session via haiflow,
 * sends a prompt, waits for the response via SSE, and verifies the full lifecycle.
 *
 * These tests require:
 * - Claude Code CLI installed and authenticated
 * - Redis running (docker run -d -p 6379:6379 redis)
 * - No other haiflow server on the test port
 *
 * Run: bun test tests/integration.test.ts
 */

const TEST_PORT = 9877;
const TEST_DIR = "/tmp/haiflow-integration-test";
const TEST_API_KEY = "integration-test-key";
const BASE = `http://localhost:${TEST_PORT}`;
const TIMEOUT = 120_000; // 2 min per test — Claude needs time

let server: ReturnType<typeof Bun.spawn>;

const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) {
    return { status: res.status, data: await res.json() };
  }
  return { status: res.status, data: await res.text() };
}

function parseSSE(text: string): { messages?: string[]; error?: string } {
  for (const block of text.split("\n\n").reverse()) {
    if (block.includes("event: complete")) {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) return JSON.parse(line.slice(6));
    }
    if (block.includes("event: error")) {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (line) return { error: JSON.parse(line.slice(6)).error };
    }
  }
  return { error: "No complete event found" };
}

beforeAll(async () => {
  // Kill any stale tmux sessions left behind by an aborted prior run.
  // Without this, startClaudeSession sees a "running" session, skips
  // launching Claude, and the new test sends prompts into a dead pane.
  for (const name of ["integration-test", "chain-a", "chain-b"]) {
    Bun.spawnSync(["tmux", "kill-session", "-t", name]);
  }
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_PORT: String(TEST_PORT),
      // Plumbing tests don't exercise the guardrail skill — keep the
      // session prompt-tip clean so test prompts aren't filtered.
      HAIFLOW_GUARDRAILS: "false",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(async () => {
  // Stop any test sessions
  try {
    await api("/session/stop", "POST", { session: "integration-test" });
  } catch {}
  try {
    await api("/session/stop", "POST", { session: "chain-a" });
  } catch {}
  try {
    await api("/session/stop", "POST", { session: "chain-b" });
  } catch {}

  server?.kill();
  await Bun.sleep(500);

  // Clean up tmux sessions
  Bun.spawnSync(["tmux", "kill-session", "-t", "integration-test"]);
  Bun.spawnSync(["tmux", "kill-session", "-t", "chain-a"]);
  Bun.spawnSync(["tmux", "kill-session", "-t", "chain-b"]);

  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// --- Full lifecycle ---

describe("session lifecycle", () => {
  test(
    "start session → trigger → stream → response → stop",
    async () => {
      // 1. Start session
      const start = await api("/session/start", "POST", {
        session: "integration-test",
        cwd: "/tmp",
      });
      expect(start.status).toBe(200);
      expect(start.data.started).toBe(true);

      // 2. Verify session is idle and ready
      const status1 = await api("/status?session=integration-test");
      expect(status1.status).toBe(200);
      expect(status1.data.status).toBe("idle");

      // 3. Trigger a prompt — use a literal-echo task so the assertion is
      // deterministic and doesn't depend on the model "thinking".
      const trigger = await api("/trigger", "POST", {
        prompt: "Reply with the literal text: PONG-LIFE and nothing else.",
        session: "integration-test",
        id: "int-test-1",
        source: "integration-test",
      });
      expect(trigger.status).toBe(200);
      expect(trigger.data.sent).toBe(true);
      expect(trigger.data.id).toBe("int-test-1");

      // 4. Verify session is busy
      const status2 = await api("/status?session=integration-test");
      expect(status2.data.status).toBe("busy");

      // 5. Stream response via SSE
      const sseRes = await fetch(
        `${BASE}/responses/int-test-1/stream?session=integration-test&timeout=90`,
        { headers: authHeaders }
      );
      expect(sseRes.status).toBe(200);
      const sseText = await sseRes.text();
      const parsed = parseSSE(sseText);

      // 6. Verify we got a response with messages
      expect(parsed.messages).toBeDefined();
      expect(parsed.messages!.length).toBeGreaterThan(0);

      // 7. The response should contain the literal echo token
      const fullResponse = parsed.messages!.join("\n");
      expect(fullResponse).toContain("PONG-LIFE");

      // 8. Verify response is persisted
      const response = await api("/responses/int-test-1?session=integration-test");
      expect(response.status).toBe(200);
      expect(response.data.messages).toBeDefined();

      // 9. Verify session is back to idle
      const status3 = await api("/status?session=integration-test");
      expect(status3.data.status).toBe("idle");

      // 10. Stop session
      const stop = await api("/session/stop", "POST", { session: "integration-test" });
      expect(stop.status).toBe(200);
      expect(stop.data.stopped).toBe(true);
    },
    TIMEOUT
  );
});

describe("queue draining", () => {
  test(
    "queues prompt when busy and drains when idle",
    async () => {
      // Start session
      await api("/session/start", "POST", {
        session: "integration-test",
        cwd: "/tmp",
      });

      // Send first prompt — literal echo, no model "thinking" required
      const trigger1 = await api("/trigger", "POST", {
        prompt: "Reply with the literal text: PONG-Q1 and nothing else.",
        session: "integration-test",
        id: "int-test-q1",
      });
      expect(trigger1.data.sent).toBe(true);

      // Send second prompt while busy — should queue
      const trigger2 = await api("/trigger", "POST", {
        prompt: "Reply with the literal text: PONG-Q2 and nothing else.",
        session: "integration-test",
        id: "int-test-q2",
      });
      expect(trigger2.data.queued).toBe(true);

      // Wait for first response
      const sse1 = await fetch(
        `${BASE}/responses/int-test-q1/stream?session=integration-test&timeout=90`,
        { headers: authHeaders }
      );
      const parsed1 = parseSSE(await sse1.text());
      expect(parsed1.messages).toBeDefined();
      expect(parsed1.messages!.join("\n")).toContain("PONG-Q1");

      // Wait for second response (auto-drained from queue)
      const sse2 = await fetch(
        `${BASE}/responses/int-test-q2/stream?session=integration-test&timeout=90`,
        { headers: authHeaders }
      );
      const parsed2 = parseSSE(await sse2.text());
      expect(parsed2.messages).toBeDefined();
      expect(parsed2.messages!.join("\n")).toContain("PONG-Q2");

      // Stop session
      await api("/session/stop", "POST", { session: "integration-test" });
    },
    TIMEOUT * 2
  );
});
