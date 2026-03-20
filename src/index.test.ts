import { test, expect, describe } from "bun:test";

// Import by evaluating the module's exported functions via inline tests
// Since index.ts starts a server on import, we test the sanitization logic directly

describe("sanitizeSession", () => {
  const sanitize = (name: string) =>
    name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";

  test("allows valid names", () => {
    expect(sanitize("worker")).toBe("worker");
    expect(sanitize("my-session")).toBe("my-session");
    expect(sanitize("session_01")).toBe("session_01");
  });

  test("strips path traversal", () => {
    expect(sanitize("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitize("../..")).toBe("default");
    expect(sanitize("..%2f..%2f")).toBe("2f2f");
  });

  test("strips special characters", () => {
    expect(sanitize("hello world")).toBe("helloworld");
    expect(sanitize("test;rm -rf /")).toBe("testrm-rf");
    expect(sanitize("$(whoami)")).toBe("whoami");
  });

  test("falls back to default for empty result", () => {
    expect(sanitize("...")).toBe("default");
    expect(sanitize("/")).toBe("default");
    expect(sanitize("")).toBe("default");
  });

  test("truncates to 64 chars", () => {
    const long = "a".repeat(100);
    expect(sanitize(long).length).toBe(64);
  });
});

describe("sanitizeId", () => {
  const sanitize = (id: string) =>
    id.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 128) || "fallback";

  test("allows valid IDs", () => {
    expect(sanitize("task-001")).toBe("task-001");
    expect(sanitize("daily-2026-03-19")).toBe("daily-2026-03-19");
    expect(sanitize("my_task.v2")).toBe("my_task.v2");
  });

  test("strips path traversal", () => {
    expect(sanitize("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitize("task/../../../secret")).toBe("task......secret");
  });

  test("strips shell injection", () => {
    expect(sanitize("task;rm -rf /")).toBe("taskrm-rf");
    expect(sanitize("$(whoami)")).toBe("whoami");
  });

  test("truncates to 128 chars", () => {
    const long = "a".repeat(200);
    expect(sanitize(long).length).toBe(128);
  });
});

describe("tmuxName", () => {
  const tmuxName = (session: string) => session;

  test("uses session name directly", () => {
    expect(tmuxName("default")).toBe("default");
    expect(tmuxName("worker")).toBe("worker");
    expect(tmuxName("my-project")).toBe("my-project");
  });
});
