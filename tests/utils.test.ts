import { test, expect, describe } from "bun:test";
import { recoverSessionPatch, prefixedId, generateId } from "../src/utils";

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
