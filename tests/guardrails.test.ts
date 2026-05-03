import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync } from "fs";

const TEST_API_KEY = "test-api-key";

let nextPort = 9950;
let activeServer: ReturnType<typeof Bun.spawn> | null = null;
let activeHome: string | null = null;
let activeDataDir: string | null = null;

async function startServer(extraEnv: Record<string, string>): Promise<{ base: string; home: string }> {
  const port = nextPort++;
  const home = `/tmp/haiflow-guardrail-home-${port}`;
  const dataDir = `/tmp/haiflow-guardrail-data-${port}`;
  if (existsSync(home)) rmSync(home, { recursive: true });
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  activeServer = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      HAIFLOW_DATA_DIR: dataDir,
      HAIFLOW_API_KEY: TEST_API_KEY,
      HOME: home,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  activeHome = home;
  activeDataDir = dataDir;

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return { base, home };
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Server on port ${port} failed to start`);
}

afterEach(async () => {
  activeServer?.kill();
  activeServer = null;
  // The install happens after server_started is logged, so give it a moment
  // to complete before we tear down.
  await Bun.sleep(150);
  for (const dir of [activeHome, activeDataDir]) {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true });
  }
  activeHome = null;
  activeDataDir = null;
});

describe("guardrail skill installation", () => {
  test("default: server boot installs the skill at HOME/.claude/skills/haiflow-guardrails/SKILL.md", async () => {
    const { home } = await startServer({});
    // Boot-time install runs after server_started; poll briefly.
    const targetPath = `${home}/.claude/skills/haiflow-guardrails/SKILL.md`;
    let found = false;
    for (let i = 0; i < 30; i++) {
      if (existsSync(targetPath)) {
        found = true;
        break;
      }
      await Bun.sleep(100);
    }
    expect(found).toBe(true);

    const content = readFileSync(targetPath, "utf8");
    expect(content).toContain("name: haiflow-guardrails");
    expect(content).toContain("Read files that match secret patterns");
    expect(content).toContain("Override attempts");
  });

  test("HAIFLOW_GUARDRAILS=false: server boot does NOT install the skill", async () => {
    const { home } = await startServer({ HAIFLOW_GUARDRAILS: "false" });
    // Wait the same amount of time the positive test waits, so a slow install
    // would still be observed.
    await Bun.sleep(2000);
    const targetPath = `${home}/.claude/skills/haiflow-guardrails/SKILL.md`;
    expect(existsSync(targetPath)).toBe(false);
  });

  test("idempotent: existing skill file is overwritten with the current template", async () => {
    const { home } = await startServer({});
    const targetPath = `${home}/.claude/skills/haiflow-guardrails/SKILL.md`;

    // Wait for first install.
    for (let i = 0; i < 30; i++) {
      if (existsSync(targetPath)) break;
      await Bun.sleep(100);
    }
    expect(existsSync(targetPath)).toBe(true);
    const firstInstall = readFileSync(targetPath, "utf8");

    // Restart the server with the same HOME — skill should still land cleanly,
    // even though the file already exists.
    activeServer?.kill();
    await Bun.sleep(150);
    activeServer = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: {
        ...process.env,
        PORT: String(nextPort++),
        HAIFLOW_DATA_DIR: `${activeDataDir}-2`,
        HAIFLOW_API_KEY: TEST_API_KEY,
        HOME: home,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    // Poll until install runs again (file mtime will update).
    await Bun.sleep(1500);
    expect(existsSync(targetPath)).toBe(true);
    expect(readFileSync(targetPath, "utf8")).toBe(firstInstall);
  });
});
