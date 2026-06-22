import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";

const TEST_PORT = 9883;
const TEST_DIR = "/tmp/haiflow-pool-test";
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

function seedIdle(session: string) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, `claude-${session}`);
  writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "idle", since: new Date().toISOString() }));
}

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  // Pool config
  writeFileSync(`${TEST_DIR}/pipeline.json`, JSON.stringify({
    topics: {}, emitters: {},
    pools: { workers: { members: ["w1", "w2"] }, single: { members: ["pw1"] } },
  }));
  for (const s of ["w1", "w2", "pw1", "reducer"]) seedIdle(s);

  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, PORT: String(TEST_PORT), HAIFLOW_DATA_DIR: TEST_DIR, HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_GUARDRAILS: "false" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(() => {
  server?.kill();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("worker pool", () => {
  test("POST /pool/:name/trigger dispatches to an idle member", async () => {
    const res = await api("/pool/single/trigger", "POST", { prompt: "hello", id: "pt-1" });
    expect(res.status).toBe(200);
    expect(res.data.member).toBe("pw1");
    expect(res.data.where).toBe("sent");
    const status = await api("/status?session=pw1");
    expect(status.data.status).toBe("busy");
    expect(status.data.currentTaskId).toBe("pt-1");
  });

  test("404 for an unknown pool", async () => {
    const res = await api("/pool/ghost/trigger", "POST", { prompt: "x" });
    expect(res.status).toBe(404);
  });
});

describe("map-reduce", () => {
  test("fans items across the pool and reduces once all return", async () => {
    const map = await api("/map", "POST", {
      items: ["alpha", "beta"],
      pool: "workers",
      mapTemplate: "Summarise: {{item}}",
      reduce: { session: "reducer", promptTemplate: "Combine these:\n{{results}}" },
    });
    expect(map.status).toBe(200);
    expect(map.data.total).toBe(2);
    expect(map.data.reduce).toBe(true);
    const runId = map.data.runId;

    // Both members idle -> both got a shard immediately
    const w1 = await api("/status?session=w1");
    const w2 = await api("/status?session=w2");
    expect(w1.data.status).toBe("busy");
    expect(w2.data.status).toBe("busy");

    // Run not reduced yet
    let run = await api(`/map/${runId}`);
    expect(run.data.reduced).toBe(false);

    // Simulate each worker finishing its shard
    await api("/hooks/stop", "POST", { session_id: "claude-w1", last_assistant_message: "RESULT_A" });
    run = await api(`/map/${runId}`);
    expect(run.data.reduced).toBe(false); // only 1 of 2

    await api("/hooks/stop", "POST", { session_id: "claude-w2", last_assistant_message: "RESULT_B" });
    run = await api(`/map/${runId}`);
    expect(run.data.reduced).toBe(true);
    expect(run.data.collected).toBe(2);

    // Reducer fired with both results
    const reducer = await api("/status?session=reducer");
    expect(reducer.data.status).toBe("busy");
    expect(reducer.data.currentPrompt).toContain("RESULT_A");
    expect(reducer.data.currentPrompt).toContain("RESULT_B");
  });

  test("rejects unknown pool and empty items", async () => {
    expect((await api("/map", "POST", { items: ["a"], pool: "ghost", mapTemplate: "x {{item}}" })).status).toBe(404);
    expect((await api("/map", "POST", { items: [], pool: "workers", mapTemplate: "x" })).status).toBe(400);
  });
});

describe("map partial timeout", () => {
  // Dedicated server with a short map timeout + fast watchdog so a stranded
  // shard is reaped within the test rather than after 30 minutes.
  const PT_DIR = "/tmp/haiflow-pool-pt-test";
  const PT_PORT = 9889;
  const PT_BASE = `http://localhost:${PT_PORT}`;
  let proc: ReturnType<typeof Bun.spawn>;

  async function ptApi(path: string, method = "GET", body?: object) {
    const res = await fetch(`${PT_BASE}${path}`, {
      method,
      headers: body ? { ...authHeaders, "Content-Type": "application/json" } : authHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  }

  beforeAll(async () => {
    if (existsSync(PT_DIR)) rmSync(PT_DIR, { recursive: true });
    mkdirSync(PT_DIR, { recursive: true });
    writeFileSync(`${PT_DIR}/pipeline.json`, JSON.stringify({
      topics: {}, emitters: {}, pools: { workers: { members: ["pw1", "pw2"] } },
    }));
    for (const s of ["pw1", "pw2", "pr"]) {
      const dir = `${PT_DIR}/${s}`;
      mkdirSync(`${dir}/responses`, { recursive: true });
      writeFileSync(`${dir}/session-id`, `claude-${s}`);
      writeFileSync(`${dir}/state.json`, JSON.stringify({ status: "idle", since: new Date().toISOString() }));
    }
    proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: {
        ...process.env, PORT: String(PT_PORT), HAIFLOW_DATA_DIR: PT_DIR,
        HAIFLOW_API_KEY: TEST_API_KEY, HAIFLOW_GUARDRAILS: "false",
        HAIFLOW_MAP_TIMEOUT_SEC: "1", HAIFLOW_WATCHDOG_INTERVAL_MS: "300",
      },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${PT_BASE}/health`)).ok) return; } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Server failed to start");
  });

  afterAll(() => {
    proc?.kill();
    if (existsSync(PT_DIR)) rmSync(PT_DIR, { recursive: true });
  });

  test("reducer fires with '(no output)' when a shard never returns", async () => {
    const map = await ptApi("/map", "POST", {
      items: ["a", "b"],
      pool: "workers",
      mapTemplate: "do {{item}}",
      reduce: { session: "pr", promptTemplate: "merge:\n{{results}}" },
    });
    const runId = map.data.runId;

    // Only shard 0 (pw1) reports; pw2's shard never does.
    await ptApi("/hooks/stop", "POST", { session_id: "claude-pw1", last_assistant_message: "SHARD_A" });

    // Wait for the run to age past MAP_TIMEOUT_MS (1s) and the watchdog to reap it.
    let reduced = false;
    for (let i = 0; i < 150; i++) {
      const run = await ptApi(`/map/${runId}`);
      if (run.data.reduced) { reduced = true; break; }
      await Bun.sleep(200);
    }
    expect(reduced).toBe(true);

    const reducer = await ptApi("/status?session=pr");
    expect(reducer.data.status).toBe("busy");
    expect(reducer.data.currentPrompt).toContain("SHARD_A");
    expect(reducer.data.currentPrompt).toContain("(no output)");
  }, 15000);
});
