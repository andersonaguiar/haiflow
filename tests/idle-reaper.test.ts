import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";

/**
 * A session is a Claude Code process holding its context in memory, measured
 * at around 350MB. Nothing in haiflow used to reclaim one: the watchdog only
 * touches sessions that are BUSY and wedged, and /sessions/prune only removes
 * the state directory of a session whose tmux is already gone. So a caller
 * that started sessions and forgot to stop them filled the host, and the host
 * is usually shared with whatever else that caller runs.
 *
 * These tests pin what the reaper will and will not stop. The sessions here
 * have no tmux behind them, so nothing is actually killed — what is asserted
 * is which ones the sweep selects, which is the part that has to be right.
 */
const TEST_PORT = 9871;
const TEST_DIR = "/tmp/haiflow-idle-reaper-test";
const TEST_API_KEY = "test-api-key";
const BASE = `http://localhost:${TEST_PORT}`;

let server: ReturnType<typeof Bun.spawn>;
/** Sessions this file really started, so a developer's tmux is left as found. */
const started: string[] = [];
const authHeaders: Record<string, string> = { Authorization: `Bearer ${TEST_API_KEY}` };

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function seed(session: string, state: object, queued: string[] = []) {
  const dir = `${TEST_DIR}/${session}`;
  mkdirSync(`${dir}/responses`, { recursive: true });
  writeFileSync(`${dir}/session-id`, `claude-${session}`);
  writeFileSync(`${dir}/state.json`, JSON.stringify({ session, ...state }));
  // queueLength on the state file is ignored: readState recomputes it from
  // the queue file, so a queue has to be a real one.
  writeFileSync(
    `${dir}/queue.json`,
    JSON.stringify(queued.map((prompt, i) => ({ id: `q${i}`, prompt, addedAt: new Date().toISOString() }))),
  );
}

const stateOf = (session: string) =>
  JSON.parse(readFileSync(`${TEST_DIR}/${session}/state.json`, "utf-8"));

beforeAll(async () => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  server = Bun.spawn(["bun", "run", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HAIFLOW_DATA_DIR: TEST_DIR,
      HAIFLOW_API_KEY: TEST_API_KEY,
      HAIFLOW_GUARDRAILS: "false",
      HAIFLOW_SESSION_IDLE_MIN: "10",
      HAIFLOW_WATCHDOG_INTERVAL_MS: "200",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
});

afterAll(async () => {
  for (const session of started) {
    await fetch(`${BASE}/session/stop`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    }).catch(() => {});
  }
  server?.kill();
  // `force` because the server may have removed a session dir under us as the
  // sweep ran, and a cleanup race is not a test failure.
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("idle session reaper", () => {
  test("leaves alone everything that is not a finished, forgotten session", async () => {
    // Each of these is a session someone would be angry to lose.
    seed("busy-now", { status: "busy", since: minutesAgo(60), queueLength: 0 });
    seed("waiting-on-a-human", { status: "idle", since: minutesAgo(60), waiting: true, queueLength: 0 });
    seed("work-queued", { status: "idle", since: minutesAgo(60) }, ["do the thing"]);
    seed("opted-out", { status: "idle", since: minutesAgo(60), queueLength: 0, idleMinutes: 0 });
    seed("within-its-window", { status: "idle", since: minutesAgo(2), queueLength: 0 });
    seed("longer-window", { status: "idle", since: minutesAgo(30), queueLength: 0, idleMinutes: 120 });

    await Bun.sleep(700);

    for (const session of [
      "busy-now",
      "waiting-on-a-human",
      "work-queued",
      "opted-out",
      "within-its-window",
      "longer-window",
    ]) {
      expect(stateOf(session).status).not.toBe("offline");
    }
  });

  // The other half: a session that finished long ago and was never stopped.
  // With no tmux behind it there is nothing to kill, but its state still
  // claims to be idle — a lie every caller of /sessions reads — so the sweep
  // corrects it. On a real host this is where the process gets stopped.
  test("acts on a session that finished long ago and was forgotten", async () => {
    seed("finished-and-forgotten", { status: "idle", since: minutesAgo(45), queueLength: 0 });

    await Bun.sleep(700);

    expect(stateOf("finished-and-forgotten").status).toBe("offline");
  });

  // Rejected before anything is started, so this is the same answer with or
  // without tmux on the machine.
  test("refuses a window that is not a number of minutes", async () => {
    // NaN is in the list because JSON.stringify writes it as null, and
    // Number(null) is 0 — which would have meant "never expire".
    for (const idleMinutes of [-1, "soon", NaN, null]) {
      const res = await fetch(`${BASE}/session/start`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ session: "bad-window", cwd: TEST_DIR, idleMinutes }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("idleMinutes");
    }
  });

  // CI has no tmux or claude on purpose, so starting a session fails fast with
  // 409 there and succeeds with 200 on a developer's machine. Either way the
  // value was accepted rather than rejected, which is what this asserts; that
  // the window then governs the sweep is covered by the seeded cases above.
  test("accepts a valid window, including nought for never", async () => {
    for (const idleMinutes of [0, 45]) {
      const res = await fetch(`${BASE}/session/start`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ session: `window-${idleMinutes}`, cwd: TEST_DIR, idleMinutes }),
      });
      expect([200, 409]).toContain(res.status);
      // On a machine that can start one, the caller is told which window it
      // actually got rather than having to know the host's default.
      if (res.status === 200) {
        expect((await res.json()).idleMinutes).toBe(idleMinutes);
        expect(stateOf(`window-${idleMinutes}`).idleMinutes).toBe(idleMinutes);
        started.push(`window-${idleMinutes}`);
      }
    }
  }, 30_000);
});
