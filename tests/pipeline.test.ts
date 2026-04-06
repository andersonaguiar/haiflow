import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";

const TEST_PORT = 9878;
const TEST_DIR = "/tmp/haiflow-pipeline-test";
const TEST_API_KEY = "test-pipeline-key";
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.spawn>;

const authHeaders: Record<string, string> = { "Authorization": `Bearer ${TEST_API_KEY}` };

async function api(path: string, method = "GET", body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
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

function writeQueue(session: string, items: object[]) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/queue.json`, JSON.stringify(items));
}

function writePipeline(config: object) {
  writeFileSync(`${TEST_DIR}/pipeline.json`, JSON.stringify(config));
}

function readQueue(session: string): any[] {
  const file = `${TEST_DIR}/${session}/queue.json`;
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8"));
}

function readState(session: string): any {
  const file = `${TEST_DIR}/${session}/state.json`;
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY,
      // No REDIS_URL — tests run with direct dispatch fallback
    },
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

// renderTemplate unit tests are in index.test.ts (imported from src/utils.ts)

// --- GET /pipeline ---

describe("GET /pipeline", () => {
  test("returns empty config when no pipeline.json", async () => {
    // Remove pipeline.json if it exists
    const file = `${TEST_DIR}/pipeline.json`;
    if (existsSync(file)) rmSync(file);

    const { status, data } = await api("/pipeline");
    expect(status).toBe(200);
    expect(data.topics).toEqual({});
    expect(data.emitters).toEqual({});
    expect(data.redis).toBe(true);
    expect(Array.isArray(data.recentEvents)).toBe(true);
  });

  test("returns pipeline config when pipeline.json exists", async () => {
    writePipeline({
      topics: {
        "test.ready": {
          subscribers: [{ session: "worker", promptTemplate: "Do: {{message}}" }],
        },
      },
      emitters: { "source": ["test.ready"] },
    });

    const { status, data } = await api("/pipeline");
    expect(status).toBe(200);
    expect(data.topics["test.ready"]).toBeDefined();
    expect(data.topics["test.ready"].subscribers).toHaveLength(1);
    expect(data.emitters.source).toEqual(["test.ready"]);
  });
});

// --- GET /pipeline/topics ---

describe("GET /pipeline/topics", () => {
  test("returns topic names", async () => {
    writePipeline({
      topics: {
        "design.ready": { subscribers: [] },
        "code.ready": { subscribers: [] },
      },
      emitters: {},
    });

    const { status, data } = await api("/pipeline/topics");
    expect(status).toBe(200);
    expect(data).toContain("design.ready");
    expect(data).toContain("code.ready");
  });

  test("returns empty array when no topics", async () => {
    writePipeline({ topics: {}, emitters: {} });
    const { status, data } = await api("/pipeline/topics");
    expect(status).toBe(200);
    expect(data).toEqual([]);
  });
});

// --- POST /publish ---

describe("POST /publish", () => {
  test("requires topic and message", async () => {
    const { status } = await api("/publish", "POST", { topic: "test" });
    expect(status).toBe(400);

    const res2 = await api("/publish", "POST", { message: "hello" });
    expect(res2.status).toBe(400);
  });

  test("publishes to known topic and dispatches to idle subscriber", async () => {
    // Set up pipeline with a subscriber
    writePipeline({
      topics: {
        "test.topic": {
          subscribers: [{ session: "sub-idle", promptTemplate: "Handle: {{message}}" }],
        },
      },
      emitters: {},
    });

    // Create an idle subscriber session (without tmux — sendToTmux will fail but state should update)
    writeState("sub-idle", { status: "idle", since: new Date().toISOString() });

    const { status, data } = await api("/publish", "POST", {
      topic: "test.topic",
      message: "test payload",
    });

    expect(status).toBe(200);
    expect(data.published).toBe(true);
    expect(data.topic).toBe("test.topic");

    // Subscriber state should now be busy (even though tmux send fails)
    await Bun.sleep(100);
    const state = readState("sub-idle");
    expect(state.status).toBe("busy");
    expect(state.currentPrompt).toBe("Handle: test payload");
  });

  test("queues for busy subscriber", async () => {
    writePipeline({
      topics: {
        "test.busy": {
          subscribers: [{ session: "sub-busy", promptTemplate: "Work: {{message}}" }],
        },
      },
      emitters: {},
    });

    writeState("sub-busy", {
      status: "busy",
      since: new Date().toISOString(),
      currentTaskId: "existing-task",
    });
    writeQueue("sub-busy", []);

    const { status } = await api("/publish", "POST", {
      topic: "test.busy",
      message: "queued work",
    });

    expect(status).toBe(200);

    await Bun.sleep(100);
    const queue = readQueue("sub-busy");
    expect(queue.length).toBe(1);
    expect(queue[0].prompt).toBe("Work: queued work");
    expect(queue[0].source).toBe("pipeline:test.busy");
  });

  test("queues for offline subscriber", async () => {
    writePipeline({
      topics: {
        "test.offline": {
          subscribers: [{ session: "sub-offline", promptTemplate: "Later: {{message}}" }],
        },
      },
      emitters: {},
    });

    writeState("sub-offline", { status: "offline", since: new Date().toISOString() });
    writeQueue("sub-offline", []);

    await api("/publish", "POST", {
      topic: "test.offline",
      message: "offline work",
    });

    await Bun.sleep(100);
    const queue = readQueue("sub-offline");
    expect(queue.length).toBe(1);
    expect(queue[0].prompt).toBe("Later: offline work");
  });

  test("blocks structural escape in pipeline message", async () => {
    writePipeline({
      topics: {
        "test.struct": {
          subscribers: [{ session: "sub-struct", promptTemplate: "Process: {{message}}" }],
        },
      },
      emitters: {},
    });

    writeState("sub-struct", { status: "idle", since: new Date().toISOString() });

    const { status } = await api("/publish", "POST", {
      topic: "test.struct",
      message: "tmux send-keys 'rm -rf /' Enter",
    });
    expect(status).toBe(400);
  });

  test("skips disabled subscribers", async () => {
    writePipeline({
      topics: {
        "test.disabled": {
          subscribers: [
            { session: "sub-disabled", promptTemplate: "{{message}}", enabled: false },
          ],
        },
      },
      emitters: {},
    });

    writeState("sub-disabled", { status: "idle", since: new Date().toISOString() });

    await api("/publish", "POST", {
      topic: "test.disabled",
      message: "should be skipped",
    });

    await Bun.sleep(100);
    const state = readState("sub-disabled");
    // Should still be idle — subscriber was disabled
    expect(state.status).toBe("idle");
  });

  test("rejects oversized messages", async () => {
    writePipeline({
      topics: { "test.size": { subscribers: [] } },
      emitters: {},
    });

    const hugeMessage = "x".repeat(512_001);
    const { status, data } = await api("/publish", "POST", {
      topic: "test.size",
      message: hugeMessage,
    });
    expect(status).toBe(413);
    expect((data as any).error).toContain("limit");
  });

  test("skips subscriber already in chain (circular protection)", async () => {
    writePipeline({
      topics: {
        "test.circular": {
          subscribers: [
            { session: "origin-session", promptTemplate: "Loop: {{message}}" },
            { session: "safe-session", promptTemplate: "Safe: {{message}}" },
          ],
        },
      },
      emitters: {},
    });

    writeState("origin-session", { status: "idle", since: new Date().toISOString() });
    writeState("safe-session", { status: "busy", since: new Date().toISOString() });
    writeQueue("safe-session", []);

    // Publish with origin-session already in the chain — it should be skipped
    const { status, data } = await api("/publish", "POST", {
      topic: "test.circular",
      message: "looped payload",
      session: "origin-session",
    });

    expect(status).toBe(200);

    await Bun.sleep(100);

    // origin-session should still be idle (skipped due to chain)
    const originState = readState("origin-session");
    expect(originState.status).toBe("idle");

    // safe-session should have been queued
    const safeQueue = readQueue("safe-session");
    expect(safeQueue.length).toBe(1);
    expect(safeQueue[0].prompt).toBe("Safe: looped payload");
  });

  test("propagates source session and chain tracking", async () => {
    writePipeline({
      topics: {
        "test.chain": {
          subscribers: [{ session: "chain-sub", promptTemplate: "{{message}}" }],
        },
      },
      emitters: {},
    });

    writeState("chain-sub", { status: "busy", since: new Date().toISOString() });
    writeQueue("chain-sub", []);

    await api("/publish", "POST", {
      topic: "test.chain",
      message: "chained",
      session: "chain-origin",
    });

    await Bun.sleep(100);
    const queue = readQueue("chain-sub");
    expect(queue.length).toBe(1);
    expect(queue[0].source).toBe("pipeline:test.chain");
    // Chain should include the source session
    expect(queue[0].chain).toContain("chain-origin");
  });

  test("fans out to multiple subscribers", async () => {
    writePipeline({
      topics: {
        "test.fanout": {
          subscribers: [
            { session: "fan-a", promptTemplate: "A: {{message}}" },
            { session: "fan-b", promptTemplate: "B: {{message}}" },
          ],
        },
      },
      emitters: {},
    });

    writeState("fan-a", { status: "busy", since: new Date().toISOString() });
    writeState("fan-b", { status: "busy", since: new Date().toISOString() });
    writeQueue("fan-a", []);
    writeQueue("fan-b", []);

    await api("/publish", "POST", { topic: "test.fanout", message: "broadcast" });

    await Bun.sleep(100);
    const queueA = readQueue("fan-a");
    const queueB = readQueue("fan-b");
    expect(queueA.length).toBe(1);
    expect(queueA[0].prompt).toBe("A: broadcast");
    expect(queueB.length).toBe(1);
    expect(queueB[0].prompt).toBe("B: broadcast");
  });
});

// --- Pipeline introspection ---

describe("pipeline introspection", () => {
  test("recent events are tracked after publish", async () => {
    writePipeline({
      topics: {
        "track.test": {
          subscribers: [{ session: "track-sub", promptTemplate: "{{message}}" }],
        },
      },
      emitters: {},
    });

    writeState("track-sub", { status: "busy", since: new Date().toISOString() });
    writeQueue("track-sub", []);

    await api("/publish", "POST", { topic: "track.test", message: "tracked" });
    await Bun.sleep(100);

    const { data } = await api("/pipeline");
    const recent = data.recentEvents;
    const found = recent.find((e: any) => e.topic === "track.test");
    expect(found).toBeDefined();
    expect(found.subscribers).toContain("track-sub");
  });
});

// --- Outbound webhooks ---

describe("pipeline webhooks", () => {
  test("fires outbound webhook when topic publishes", async () => {
    // Start a tiny webhook receiver
    let received: any = null;
    const webhookServer = Bun.serve({
      port: 19876,
      routes: {
        "/hook": {
          POST: async (req) => {
            received = await req.json();
            return Response.json({ ok: true });
          },
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });

    try {
      writePipeline({
        topics: {
          "wh.test": {
            subscribers: [],
            webhooks: [
              { url: "http://localhost:19876/hook" },
            ],
          },
        },
        emitters: {},
      });

      await api("/publish", "POST", {
        topic: "wh.test",
        message: "webhook payload",
        session: "test-agent",
      });

      // Give the async fetch time to complete
      await Bun.sleep(300);

      expect(received).not.toBeNull();
      expect(received.topic).toBe("wh.test");
      expect(received.message).toBe("webhook payload");
      expect(received.sourceSession).toBe("test-agent");
      expect(received.publishedAt).toBeDefined();
    } finally {
      webhookServer.stop();
    }
  });

  test("skips disabled webhooks", async () => {
    let called = false;
    const webhookServer = Bun.serve({
      port: 19877,
      routes: {
        "/hook": {
          POST: async () => {
            called = true;
            return Response.json({ ok: true });
          },
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });

    try {
      writePipeline({
        topics: {
          "wh.disabled": {
            subscribers: [],
            webhooks: [
              { url: "http://localhost:19877/hook", enabled: false },
            ],
          },
        },
        emitters: {},
      });

      await api("/publish", "POST", {
        topic: "wh.disabled",
        message: "should not arrive",
      });

      await Bun.sleep(300);
      expect(called).toBe(false);
    } finally {
      webhookServer.stop();
    }
  });

  test("sends custom headers", async () => {
    let receivedHeaders: Record<string, string> = {};
    const webhookServer = Bun.serve({
      port: 19878,
      routes: {
        "/hook": {
          POST: async (req) => {
            receivedHeaders = Object.fromEntries(req.headers.entries());
            return Response.json({ ok: true });
          },
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });

    try {
      writePipeline({
        topics: {
          "wh.headers": {
            subscribers: [],
            webhooks: [
              {
                url: "http://localhost:19878/hook",
                headers: { "X-Pipeline-Secret": "s3cret" },
              },
            ],
          },
        },
        emitters: {},
      });

      await api("/publish", "POST", {
        topic: "wh.headers",
        message: "with headers",
      });

      await Bun.sleep(300);
      expect(receivedHeaders["x-pipeline-secret"]).toBe("s3cret");
      expect(receivedHeaders["content-type"]).toBe("application/json");
    } finally {
      webhookServer.stop();
    }
  });
});

// --- Webhook-only topics (no subscribers) ---

describe("webhook-only topics", () => {
  test("publishes to topic with webhooks but no subscribers field", async () => {
    let received: any = null;
    const webhookServer = Bun.serve({
      port: 19879,
      routes: {
        "/hook": {
          POST: async (req) => {
            received = await req.json();
            return Response.json({ ok: true });
          },
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });

    try {
      writePipeline({
        topics: {
          "wh.only": {
            description: "Topic with webhooks but no subscribers array",
            webhooks: [
              { url: "http://localhost:19879/hook", method: "POST" },
            ],
          },
        },
        emitters: {},
      });

      const { status, data } = await api("/publish", "POST", {
        topic: "wh.only",
        message: "webhook-only test",
      });
      expect(status).toBe(200);
      expect(data.published).toBe(true);

      await Bun.sleep(300);
      expect(received).not.toBeNull();
      expect(received.topic).toBe("wh.only");
      expect(received.message).toBe("webhook-only test");
    } finally {
      webhookServer.stop();
    }
  });

  test("publishes to topic with empty subscribers array and webhooks", async () => {
    let received: any = null;
    const webhookServer = Bun.serve({
      port: 19880,
      routes: {
        "/hook": {
          POST: async (req) => {
            received = await req.json();
            return Response.json({ ok: true });
          },
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });

    try {
      writePipeline({
        topics: {
          "wh.empty-subs": {
            subscribers: [],
            webhooks: [
              { url: "http://localhost:19880/hook" },
            ],
          },
        },
        emitters: {},
      });

      const { status } = await api("/publish", "POST", {
        topic: "wh.empty-subs",
        message: "empty subs test",
      });
      expect(status).toBe(200);

      await Bun.sleep(300);
      expect(received).not.toBeNull();
      expect(received.message).toBe("empty subs test");
    } finally {
      webhookServer.stop();
    }
  });
});

// --- Template variables ---

describe("prompt template variables", () => {
  test("all template variables are rendered", async () => {
    writePipeline({
      topics: {
        "vars.test": {
          subscribers: [
            {
              session: "vars-sub",
              promptTemplate:
                "topic={{topic}} source={{sourceSession}} task={{taskId}} msg={{message}}",
            },
          ],
        },
      },
      emitters: {},
    });

    writeState("vars-sub", { status: "busy", since: new Date().toISOString() });
    writeQueue("vars-sub", []);

    await api("/publish", "POST", {
      topic: "vars.test",
      message: "hello",
      session: "my-source",
    });

    await Bun.sleep(100);
    const queue = readQueue("vars-sub");
    expect(queue.length).toBe(1);
    expect(queue[0].prompt).toContain("topic=vars.test");
    expect(queue[0].prompt).toContain("source=my-source");
    expect(queue[0].prompt).toContain("msg=hello");
    // taskId is auto-generated, just check it's not empty
    expect(queue[0].prompt).not.toContain("task=\n");
  });
});
