import { test, expect, describe } from "bun:test";
import { recoverSessionPatch, prefixedId, generateId, checkRateLimit, type RateWindow } from "../src/utils";

describe("checkRateLimit (fixed-window)", () => {
  test("allows up to the limit, then blocks", () => {
    const state = new Map<string, RateWindow>();
    expect(checkRateLimit(state, "s", 1000, 2, 60_000).allowed).toBe(true);
    expect(checkRateLimit(state, "s", 1000, 2, 60_000).allowed).toBe(true);
    const blocked = checkRateLimit(state, "s", 1000, 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  test("resets once the window elapses", () => {
    const state = new Map<string, RateWindow>();
    checkRateLimit(state, "s", 1000, 1, 60_000); // uses the slot
    expect(checkRateLimit(state, "s", 1000, 1, 60_000).allowed).toBe(false);
    // 60s later -> new window
    expect(checkRateLimit(state, "s", 61_001, 1, 60_000).allowed).toBe(true);
  });

  test("tracks keys independently", () => {
    const state = new Map<string, RateWindow>();
    expect(checkRateLimit(state, "a", 0, 1, 60_000).allowed).toBe(true);
    expect(checkRateLimit(state, "a", 0, 1, 60_000).allowed).toBe(false);
    expect(checkRateLimit(state, "b", 0, 1, 60_000).allowed).toBe(true);
  });

  test("limit <= 0 disables the limit", () => {
    const state = new Map<string, RateWindow>();
    for (let i = 0; i < 5; i++) expect(checkRateLimit(state, "s", 0, 0, 60_000).allowed).toBe(true);
  });
});

describe("prefixedId", () => {
  test("uses the given prefix and the <prefix>_<ms>_<6 chars> shape", () => {
    const id = prefixedId("evt");
    expect(id).toMatch(/^evt_\d+_[a-z0-9]{1,6}$/);
  });

  test("generateId is prefixedId('task')", () => {
    expect(generateId()).toStartWith("task_");
  });

  test("successive ids differ", () => {
    expect(prefixedId("map")).not.toBe(prefixedId("map"));
  });
});

const NOW = "2026-06-22T00:00:00.000Z";

describe("recoverSessionPatch (boot recovery)", () => {
  test("returns null when nothing is stale", () => {
    expect(recoverSessionPatch({ status: "idle" }, NOW)).toBeNull();
    expect(recoverSessionPatch({ status: "busy" }, NOW)).toBeNull();
  });

  test("clears a stale intervened flag without touching an idle status", () => {
    const patch = recoverSessionPatch({ status: "idle", intervened: true }, NOW);
    expect(patch).toEqual({ intervened: false });
  });

  test("clears stale waiting fields", () => {
    const patch = recoverSessionPatch({ status: "busy", waiting: true }, NOW);
    expect(patch).toEqual({ waiting: false, waitingMessage: undefined, waitingSince: undefined });
  });

  test("revives an offline-but-running session to idle", () => {
    const patch = recoverSessionPatch({ status: "offline" }, NOW);
    expect(patch).toEqual({ status: "idle", since: NOW });
  });

  test("clears intervened AND waiting AND revives offline in one patch", () => {
    const patch = recoverSessionPatch({ status: "offline", intervened: true, waiting: true }, NOW);
    expect(patch).toEqual({
      intervened: false,
      waiting: false,
      waitingMessage: undefined,
      waitingSince: undefined,
      status: "idle",
      since: NOW,
    });
  });
});
