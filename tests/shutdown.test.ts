import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, rmSync } from "fs";

const TEST_PORT = 9912;
const TEST_DIR = "/tmp/haiflow-shutdown-test";
const BASE = `http://localhost:${TEST_PORT}`;

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("graceful shutdown", () => {
  test("exits cleanly (code 0) on SIGTERM", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });

    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        HAIFLOW_DATA_DIR: TEST_DIR,
        HAIFLOW_API_KEY: "shutdown-test-key",
        HAIFLOW_GUARDRAILS: "false",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          const res = await fetch(`${BASE}/health`);
          if (res.ok) { ready = true; break; }
        } catch {}
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);

      // Without the SIGTERM handler the process is killed by the signal and
      // never reaches a clean exit. The handler clears timers, stops the server
      // and closes Redis, then exits 0.
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      if (!proc.killed) proc.kill("SIGKILL");
    }
  });
});
