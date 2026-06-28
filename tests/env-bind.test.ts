import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, rmSync } from "fs";

// A strong, non-placeholder key so production's key check passes by default.
const STRONG_KEY = "k".repeat(40);

let nextPort = 9940;
let active: ReturnType<typeof Bun.spawn> | null = null;
let activeDir: string | null = null;

type Boot =
  | { ok: true; base: string; stdout: string }
  | { ok: false; exitCode: number; stderr: string };

// Boot the server and resolve the moment it signals readiness (its
// `server_started` log) OR exits first (a fail-closed rejection). No polling /
// sleeping — we wait on the actual readiness/exit signal.
async function boot(extraEnv: Record<string, string>): Promise<Boot> {
  const port = nextPort++;
  const dataDir = `/tmp/haiflow-env-test-${port}`;
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true });
  activeDir = dataDir;

  const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      HAIFLOW_DATA_DIR: dataDir,
      HAIFLOW_API_KEY: STRONG_KEY,
      // Every case sets HAIFLOW_ENV explicitly; it wins over the runner's NODE_ENV.
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  active = proc;

  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let out = "";
  const ready = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      out += decoder.decode(value);
      if (out.includes("server_started")) return true;
    }
  })();

  const started = await Promise.race([ready, proc.exited.then(() => false)]);
  if (started) {
    // Keep draining stdout so the child's pipe never blocks while it runs.
    void (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch {} })();
    return { ok: true, base: `http://127.0.0.1:${port}`, stdout: out };
  }
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { ok: false, exitCode: proc.exitCode ?? -1, stderr };
}

afterEach(() => {
  active?.kill();
  active = null;
  if (activeDir && existsSync(activeDir)) rmSync(activeDir, { recursive: true });
  activeDir = null;
});

describe("env-aware bind hardening", () => {
  test("production refuses a public bind without acknowledgement", async () => {
    const r = await boot({ HAIFLOW_ENV: "production", HAIFLOW_HOST: "0.0.0.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("refusing to bind");
    }
  });

  test("production allows a public bind when explicitly acknowledged", async () => {
    const r = await boot({ HAIFLOW_ENV: "production", HAIFLOW_HOST: "0.0.0.0", HAIFLOW_ALLOW_PUBLIC_BIND: "true" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((await fetch(`${r.base}/health`)).ok).toBe(true);
      expect(r.stdout).toContain("public_bind_acknowledged");
    }
  });

  test("production rejects a weak/placeholder API key", async () => {
    const r = await boot({ HAIFLOW_ENV: "production", HAIFLOW_API_KEY: "changeme" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("too weak");
    }
  });

  test("production with the loopback default and a strong key boots", async () => {
    const r = await boot({ HAIFLOW_ENV: "production" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((await fetch(`${r.base}/health`)).ok).toBe(true);
      expect(r.stdout).toContain("loopback_origin");
    }
  });

  test("development allows a public bind (no tunnel required)", async () => {
    const r = await boot({ HAIFLOW_ENV: "development", HAIFLOW_HOST: "0.0.0.0" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((await fetch(`${r.base}/health`)).ok).toBe(true);
      expect(r.stdout).toContain("public_bind_dev");
    }
  });

  test("development boots with a weak key (prod enforcement does not apply)", async () => {
    const r = await boot({ HAIFLOW_ENV: "development", HAIFLOW_API_KEY: "test" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((await fetch(`${r.base}/health`)).ok).toBe(true);
  });
});
