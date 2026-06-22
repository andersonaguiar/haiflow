import { test, expect, describe, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import {
  initLedger, recordTaskStart, recordTaskFinish, queryTasks, getTask,
  extractFromTranscript, usageSince,
} from "../src/ledger";
import { estimateSavings, priceForModel } from "../src/pricing";

const DIR = "/tmp/haiflow-ledger-test";

beforeAll(() => {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
  mkdirSync(DIR, { recursive: true });
  initLedger(DIR);
});

describe("ledger task lifecycle", () => {
  test("records start then finish and merges the row", () => {
    recordTaskStart({ id: "t-1", session: "s1", prompt: "do a thing", source: "trigger" });
    let row = getTask("t-1");
    expect(row?.status).toBe("running");
    expect(row?.prompt).toBe("do a thing");

    recordTaskFinish({
      id: "t-1",
      session: "s1",
      status: "completed",
      steps: [{ seq: 0, tool: "Bash", summary: "ls", isError: false }],
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100, totalTokens: 115 },
      model: "claude-opus-4-8",
      commandsRun: ["ls"],
      filesChanged: [],
      savedUsd: 0.001,
    });

    row = getTask("t-1");
    expect(row?.status).toBe("completed");
    expect(row?.steps.length).toBe(1);
    expect(row?.steps[0]?.tool).toBe("Bash");
    expect(row?.usage?.totalTokens).toBe(115);
    expect(row?.commands_run).toEqual(["ls"]);
    expect(row?.duration_ms).not.toBeNull();
  });

  test("filters by session and status", () => {
    recordTaskStart({ id: "t-2", session: "s2", prompt: "x" });
    recordTaskStart({ id: "t-3", session: "s2", prompt: "y" });
    recordTaskFinish({ id: "t-3", session: "s2", status: "completed" });

    const all = queryTasks({ session: "s2" });
    expect(all.total).toBe(2);

    const running = queryTasks({ session: "s2", status: "running" });
    expect(running.total).toBe(1);
    expect(running.tasks[0]?.id).toBe("t-2");
  });

  test("getTask scoped by session returns null on mismatch", () => {
    expect(getTask("t-1", "wrong-session")).toBeNull();
    expect(getTask("t-1", "s1")?.id).toBe("t-1");
  });
});

describe("transcript extraction", () => {
  const transcript = [
    { type: "user", timestamp: "2026-06-09T10:00:00Z", message: { role: "user", content: "Fix the bug in foo.ts" } },
    { type: "assistant", timestamp: "2026-06-09T10:00:01Z", message: { role: "assistant", model: "claude-opus-4-8", content: [
      { type: "text", text: "I'll fix it." },
      { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "bun test" } },
    ], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 } } },
    { type: "user", timestamp: "2026-06-09T10:00:02Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool_1", is_error: true, content: "test failed" },
    ] } },
    { type: "assistant", timestamp: "2026-06-09T10:00:03Z", message: { role: "assistant", model: "claude-opus-4-8", content: [
      { type: "tool_use", id: "tool_2", name: "Edit", input: { file_path: "/repo/foo.ts", old_string: "a", new_string: "b" } },
      { type: "text", text: "Fixed." },
    ], usage: { input_tokens: 80, output_tokens: 40 } } },
    { type: "user", timestamp: "2026-06-09T10:00:04Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool_2", is_error: false, content: "ok" },
    ] } },
    { type: "assistant", timestamp: "2026-06-09T10:00:05Z", message: { role: "assistant", content: [
      { type: "text", text: "All done, tests pass." },
    ] } },
  ].map((e) => JSON.stringify(e)).join("\n");

  let result: ReturnType<typeof extractFromTranscript>;
  beforeAll(() => {
    const path = `${DIR}/transcript.jsonl`;
    writeFileSync(path, transcript);
    result = extractFromTranscript(path);
  });

  test("extracts ordered tool steps with error pairing", () => {
    expect(result?.steps.length).toBe(2);
    expect(result?.steps[0]?.tool).toBe("Bash");
    expect(result?.steps[0]?.isError).toBe(true);   // tool_1 result was is_error
    expect(result?.steps[1]?.tool).toBe("Edit");
    expect(result?.steps[1]?.isError).toBe(false);
    expect(result?.steps[1]?.filePath).toBe("/repo/foo.ts");
    expect(result?.steps[1]?.detail).toContain("- a");
    expect(result?.steps[1]?.detail).toContain("+ b");
  });

  test("derives commands and files changed", () => {
    expect(result?.commandsRun).toEqual(["bun test"]);
    expect(result?.filesChanged).toEqual(["/repo/foo.ts"]);
  });

  test("sums usage across assistant turns", () => {
    expect(result?.usage?.inputTokens).toBe(180);
    expect(result?.usage?.outputTokens).toBe(90);
    expect(result?.usage?.cacheReadTokens).toBe(2000);
    expect(result?.usage?.cacheCreationTokens).toBe(500);
    expect(result?.usage?.totalTokens).toBe(2770);
    expect(result?.model).toBe("claude-opus-4-8");
  });

  test("collects assistant text messages", () => {
    expect(result?.messages).toEqual(["I'll fix it.", "Fixed.", "All done, tests pass."]);
  });

  test("returns null for a missing file", () => {
    expect(extractFromTranscript(`${DIR}/does-not-exist.jsonl`)).toBeNull();
  });
});

describe("pricing / savings", () => {
  test("picks the right model tier", () => {
    expect(priceForModel("claude-opus-4-8").output).toBe(75);
    expect(priceForModel("claude-sonnet-4-6").output).toBe(15);
    expect(priceForModel("claude-haiku-4-5").output).toBe(5);
    expect(priceForModel(null).output).toBe(15); // default sonnet
  });

  test("computes equivalent API cost from usage", () => {
    const usage = { inputTokens: 180, outputTokens: 90, cacheCreationTokens: 500, cacheReadTokens: 2000, totalTokens: 2770 };
    // opus: (180*15 + 90*75 + 500*18.75 + 2000*1.5) / 1e6
    expect(estimateSavings(usage, "claude-opus-4-8")).toBeCloseTo(0.021825, 6);
    expect(estimateSavings(null, "claude-opus-4-8")).toBe(0);
  });
});

describe("usageSince windowing", () => {
  test("aggregates finished tasks within the window", () => {
    const now = Date.now();
    mkdirSync(`${DIR}-win`, { recursive: true });
    initLedger(`${DIR}-win`);   // fresh DB so the window count is deterministic
    recordTaskStart({ id: "w-1", session: "w", prompt: "p" });
    recordTaskFinish({
      id: "w-1", session: "w", status: "completed",
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 2 },
      savedUsd: 0.5,
    });
    const agg = usageSince(new Date(now - 3_600_000).toISOString());
    expect(agg.tasks).toBe(1);
    expect(agg.totalTokens).toBe(2);
    expect(agg.savedUsd).toBeCloseTo(0.5, 6);
  });
});

describe("ledger finish merge + orphan finish", () => {
  test("recordTaskFinish without a prior start inserts a row with null started_at/duration", () => {
    // The watchdog finishes a stuck task it never started; dispatchOrQueue can
    // also race the Stop hook. The row must still be valid, just unwindowed.
    recordTaskFinish({ id: "orphan-1", session: "s9", status: "timed_out", error: "watchdog:timeout" });
    const row = getTask("orphan-1");
    expect(row?.status).toBe("timed_out");
    expect(row?.error).toBe("watchdog:timeout");
    expect(row?.started_at).toBeNull();
    expect(row?.duration_ms).toBeNull();
    expect(row?.prompt).toBeNull();
  });

  test("a second finish preserves steps/model via COALESCE while updating status/error", () => {
    recordTaskStart({ id: "merge-1", session: "s9", prompt: "p" });
    recordTaskFinish({
      id: "merge-1",
      session: "s9",
      status: "completed",
      steps: [{ seq: 0, tool: "Bash", summary: "ls", isError: false }],
      model: "claude-opus-4-8",
    });
    // A second hook (e.g. watchdog after the Stop hook) re-finishes with only a
    // new status + error. The earlier timeline must survive, not be wiped.
    recordTaskFinish({ id: "merge-1", session: "s9", status: "failed", error: "later failure" });

    const row = getTask("merge-1");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("later failure");
    expect(row?.steps.length).toBe(1);
    expect(row?.steps[0]?.tool).toBe("Bash");
    expect(row?.model).toBe("claude-opus-4-8");
  });
});
