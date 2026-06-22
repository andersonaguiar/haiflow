import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";

const TEST_DIR = "/tmp/haiflow-boot-test";
const PORT = 9888;

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("startup prompt-file sweep", () => {
  test("removes stale /tmp/haiflow-prompt-*.txt left by a crashed run", async () => {
    const sentinel = `/tmp/haiflow-prompt-${randomUUID()}.txt`;
    writeFileSync(sentinel, "stale large-prompt contents");

    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: {
        ...process.env, PORT: String(PORT), HAIFLOW_DATA_DIR: TEST_DIR,
        HAIFLOW_API_KEY: "boot-test-key", HAIFLOW_GUARDRAILS: "false",
      },
      stdout: "ignore", stderr: "ignore",
    });

    try {
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) { ready = true; break; } } catch {}
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);
      // The boot sweep runs during module init, before /health responds.
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      proc.kill();
      try { unlinkSync(sentinel); } catch {}
    }
  });
});
