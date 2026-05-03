import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, rmSync } from "fs";

const TEST_API_KEY = "test-api-key";
const authHeaders: Record<string, string> = { "Authorization": `Bearer ${TEST_API_KEY}` };

let nextPort = 9920;
let activeServer: ReturnType<typeof Bun.spawn> | null = null;
let activeDataDir: string | null = null;

async function startServer(extraEnv: Record<string, string>): Promise<{ base: string }> {
  const port = nextPort++;
  const dataDir = `/tmp/haiflow-cwd-test-${port}`;
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true });

  activeServer = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      HAIFLOW_DATA_DIR: dataDir,
      HAIFLOW_API_KEY: TEST_API_KEY,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  activeDataDir = dataDir;

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { base };
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Server on port ${port} failed to start`);
}

async function api(base: string, path: string, body?: object) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, data: ct.includes("json") ? await res.json() : await res.text() };
}

afterEach(async () => {
  activeServer?.kill();
  activeServer = null;
  if (activeDataDir && existsSync(activeDataDir)) {
    rmSync(activeDataDir, { recursive: true });
  }
  activeDataDir = null;
});

describe("session/start cwd config", () => {
  test("default: request cwd is required", async () => {
    const { base } = await startServer({});
    const { status, data } = await api(base, "/session/start", { session: "t1" });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd is required");
  });

  test("HAIFLOW_ALLOW_REQUEST_CWD=false rejects request that omits HAIFLOW_CWD on server", async () => {
    const { base } = await startServer({ HAIFLOW_ALLOW_REQUEST_CWD: "false" });
    const { status, data } = await api(base, "/session/start", { session: "t2", cwd: "/tmp" });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd from request is disabled; set HAIFLOW_CWD on the server");
  });

  test("HAIFLOW_ALLOW_REQUEST_CWD=false also rejects requests with no cwd at all", async () => {
    const { base } = await startServer({ HAIFLOW_ALLOW_REQUEST_CWD: "false" });
    const { status, data } = await api(base, "/session/start", { session: "t3" });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd from request is disabled; set HAIFLOW_CWD on the server");
  });

  test("HAIFLOW_CWD set: request without cwd is accepted (uses forced cwd)", async () => {
    const { base } = await startServer({ HAIFLOW_CWD: "/tmp" });
    const { status, data } = await api(base, "/session/start", { session: "t4" });
    // The cwd-validation gate must pass. tmux/claude may still fail with 409
    // depending on host setup — that is unrelated to env-var routing.
    expect(status).not.toBe(400);
    if (status === 200) expect(data.cwd).toBe("/tmp");
  });

  test("HAIFLOW_CWD set: request cwd is ignored, forced cwd wins", async () => {
    const { base } = await startServer({ HAIFLOW_CWD: "/tmp" });
    const { status, data } = await api(base, "/session/start", { session: "t5", cwd: "/var" });
    expect(status).not.toBe(400);
    if (status === 200) expect(data.cwd).toBe("/tmp");
  });

  test("HAIFLOW_CWD + HAIFLOW_ALLOW_REQUEST_CWD=false: forced cwd is used and request cwd ignored", async () => {
    const { base } = await startServer({ HAIFLOW_CWD: "/tmp", HAIFLOW_ALLOW_REQUEST_CWD: "false" });
    const { status, data } = await api(base, "/session/start", { session: "t6", cwd: "/var" });
    expect(status).not.toBe(400);
    if (status === 200) expect(data.cwd).toBe("/tmp");
  });

  test("HAIFLOW_ALLOW_REQUEST_CWD=true (explicit) preserves default behaviour", async () => {
    const { base } = await startServer({ HAIFLOW_ALLOW_REQUEST_CWD: "true" });
    const { status, data } = await api(base, "/session/start", { session: "t7" });
    expect(status).toBe(400);
    expect(data.error).toBe("cwd is required");
  });
});
