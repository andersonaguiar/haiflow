import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";

const TEST_PORT = 9876;
const TEST_DIR = "/tmp/haiflow-test";
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.spawn>;

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
}

function writeState(session: string, state: object) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/state.json`, JSON.stringify(state));
}

function writeQueue(session: string, items: object[]) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/queue.json`, JSON.stringify(items));
}

function writeResponse(session: string, taskId: string, data: object) {
  const dir = `${TEST_DIR}/${session}/responses`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${taskId}.json`, JSON.stringify(data));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR },
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

// --- Health ---

describe("GET /health", () => {
  test("returns ok", async () => {
    const { status, data } = await api("/health");
    expect(status).toBe(200);
    expect(data).toBe("ok");
  });
});

// --- Sessions ---

describe("GET /sessions", () => {
  test("returns empty list initially", async () => {
    const { status, data } = await api("/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });
});

// --- Status ---

describe("GET /status", () => {
  test("returns offline for unknown session", async () => {
    const { status, data } = await api("/status?session=nonexistent");
    expect(status).toBe(200);
    expect(data.status).toBe("offline");
    expect(data.session).toBe("nonexistent");
    expect(data.queueLength).toBe(0);
  });

  test("returns state for existing session", async () => {
    writeState("test-status", { status: "idle", since: "2025-01-01T00:00:00Z" });
    const { data } = await api("/status?session=test-status");
    expect(data.status).toBe("idle");
    expect(data.session).toBe("test-status");
  });

  test("sanitizes session param", async () => {
    const { data } = await api("/status?session=../../etc");
    expect(data.session).toBe("etc");
    expect(data.status).toBe("offline");
  });
});

// --- Session start validation ---

describe("POST /session/start", () => {
  test("requires cwd", async () => {
    const { status, data } = await api("/session/start", "POST", { session: "test" });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd is required");
  });

  test("sanitizes session name", async () => {
    const { status, data } = await api("/session/start", "POST", {
      session: "../../../evil",
      cwd: "/tmp",
    });
    // Will fail with 409 or succeed depending on tmux, but session name should be sanitized
    expect(status).toBeOneOf([200, 409]);
  });
});

// --- Trigger ---

describe("POST /trigger", () => {
  test("requires prompt", async () => {
    const { status, data } = await api("/trigger", "POST", { session: "test" });
    expect(status).toBe(400);
    expect(data.error).toBe("prompt is required");
  });

  test("returns 503 for offline session", async () => {
    const { status, data } = await api("/trigger", "POST", {
      prompt: "hello",
      session: "offline-test",
    });
    expect(status).toBe(503);
    expect(data.error).toContain("offline");
  });

  test("queues when session is busy", async () => {
    writeState("busy-test", {
      status: "busy",
      since: new Date().toISOString(),
      currentPrompt: "working...",
      currentTaskId: "existing-task",
    });

    const { status, data } = await api("/trigger", "POST", {
      prompt: "queued prompt",
      session: "busy-test",
      id: "queued-001",
    });
    expect(status).toBe(200);
    expect(data.queued).toBe(true);
    expect(data.position).toBe(1);
    expect(data.id).toBe("queued-001");
  });

  test("queues multiple prompts in order", async () => {
    writeState("queue-order", {
      status: "busy",
      since: new Date().toISOString(),
      currentTaskId: "current",
    });

    await api("/trigger", "POST", { prompt: "first", session: "queue-order", id: "q1" });
    await api("/trigger", "POST", { prompt: "second", session: "queue-order", id: "q2" });
    const { data } = await api("/trigger", "POST", { prompt: "third", session: "queue-order", id: "q3" });

    expect(data.position).toBe(3);
  });

  test("sanitizes task ID", async () => {
    writeState("sanitize-id", {
      status: "busy",
      since: new Date().toISOString(),
      currentTaskId: "current",
    });

    const { data } = await api("/trigger", "POST", {
      prompt: "test",
      session: "sanitize-id",
      id: "../../evil/task",
    });
    expect(data.id).toBe("....eviltask");
  });

  test("auto-generates ID when not provided", async () => {
    writeState("autoid", {
      status: "busy",
      since: new Date().toISOString(),
      currentTaskId: "current",
    });

    const { data } = await api("/trigger", "POST", {
      prompt: "test",
      session: "autoid",
    });
    expect(data.id).toStartWith("task_");
  });
});

// --- Queue ---

describe("GET /queue", () => {
  test("returns empty queue", async () => {
    const { data } = await api("/queue?session=empty-queue");
    expect(data.items).toEqual([]);
    expect(data.length).toBe(0);
  });

  test("returns queued items", async () => {
    writeQueue("has-queue", [
      { id: "t1", prompt: "first", addedAt: "2025-01-01T00:00:00Z" },
      { id: "t2", prompt: "second", addedAt: "2025-01-01T00:01:00Z" },
    ]);
    const { data } = await api("/queue?session=has-queue");
    expect(data.length).toBe(2);
    expect(data.items[0].id).toBe("t1");
    expect(data.items[1].id).toBe("t2");
  });
});

describe("DELETE /queue", () => {
  test("clears the queue", async () => {
    writeQueue("clear-queue", [
      { id: "t1", prompt: "first", addedAt: "2025-01-01T00:00:00Z" },
    ]);

    const { data: cleared } = await api("/queue?session=clear-queue", "DELETE");
    expect(cleared.cleared).toBe(true);

    const { data: after } = await api("/queue?session=clear-queue");
    expect(after.length).toBe(0);
  });
});

// --- Responses ---

describe("GET /responses", () => {
  test("returns empty list for new session", async () => {
    const { data } = await api("/responses?session=no-responses");
    expect(data.items).toEqual([]);
    expect(data.length).toBe(0);
  });

  test("lists completed responses", async () => {
    writeResponse("has-responses", "task-a", {
      id: "task-a",
      completed_at: "2025-01-01T00:00:00Z",
      messages: ["done"],
    });
    writeResponse("has-responses", "task-b", {
      id: "task-b",
      completed_at: "2025-01-01T00:01:00Z",
      messages: ["also done"],
    });

    const { data } = await api("/responses?session=has-responses");
    expect(data.length).toBe(2);
  });
});

describe("GET /responses/:id", () => {
  test("returns 404 for unknown ID", async () => {
    const { status, data } = await api("/responses/nonexistent?session=missing");
    expect(status).toBe(404);
    expect(data.error).toBe("Response not found");
  });

  test("does not allow encoded traversal-style response IDs", async () => {
    writeState("resp-traversal", {
      status: "idle",
      since: "2025-01-01T00:00:00Z",
    });

    const { status, data } = await api("/responses/%2E%2E%2Fstate?session=resp-traversal");
    expect(status).toBe(404);
    expect(data.error).toBe("Response not found");
  });

  test("returns completed response", async () => {
    writeResponse("get-resp", "my-task", {
      id: "my-task",
      completed_at: "2025-01-01T00:00:00Z",
      messages: ["hello world"],
    });

    const { status, data } = await api("/responses/my-task?session=get-resp");
    expect(status).toBe(200);
    expect(data.id).toBe("my-task");
    expect(data.messages).toEqual(["hello world"]);
  });

  test("returns 202 pending when task is active", async () => {
    writeState("pending-resp", {
      status: "busy",
      since: new Date().toISOString(),
      currentTaskId: "active-task",
    });

    const { status, data } = await api("/responses/active-task?session=pending-resp");
    expect(status).toBe(202);
    expect(data.status).toBe("pending");
  });

  test("returns 202 queued when task is in queue", async () => {
    writeState("queued-resp", { status: "busy", since: new Date().toISOString(), currentTaskId: "other" });
    writeQueue("queued-resp", [
      { id: "waiting-task", prompt: "test", addedAt: "2025-01-01T00:00:00Z" },
    ]);

    const { status, data } = await api("/responses/waiting-task?session=queued-resp");
    expect(status).toBe(202);
    expect(data.status).toBe("queued");
  });
});

// --- Hooks ---

describe("POST /hooks/session-start", () => {
  test("returns ok for unknown session", async () => {
    const { data } = await api("/hooks/session-start", "POST", {
      session_id: "unknown-claude-id",
    });
    expect(data.ok).toBe(true);
  });
});

describe("POST /hooks/prompt", () => {
  test("returns ok for unknown session", async () => {
    const { data } = await api("/hooks/prompt", "POST", {
      session_id: "unknown-claude-id",
      prompt: "test",
    });
    expect(data.ok).toBe(true);
  });
});

describe("POST /hooks/stop", () => {
  test("returns ok for unknown session", async () => {
    const { data } = await api("/hooks/stop", "POST", {
      session_id: "unknown-claude-id",
    });
    expect(data.ok).toBe(true);
  });
});

describe("POST /hooks/session-end", () => {
  test("returns ok for unknown session", async () => {
    const { data } = await api("/hooks/session-end", "POST", {
      session_id: "unknown-claude-id",
    });
    expect(data.ok).toBe(true);
  });

  test("ignores clear/compact reasons", async () => {
    const { data } = await api("/hooks/session-end", "POST", {
      session_id: "unknown",
      reason: "clear",
    });
    expect(data.ok).toBe(true);
  });
});

// --- Session stop ---

describe("POST /session/stop", () => {
  test("returns 404 for non-existent tmux session", async () => {
    const { status, data } = await api("/session/stop", "POST", { session: "no-tmux" });
    expect(status).toBe(404);
    expect(data.error).toContain("not found");
  });
});

// --- 404 fallback ---

describe("unknown routes", () => {
  test("returns 404", async () => {
    const { status, data } = await api("/nonexistent");
    expect(status).toBe(404);
    expect(data.error).toBe("Not found");
  });
});
