import { test, expect, describe } from "bun:test";
import { evaluateWebhook, buildGithubPrompt, type GithubConfig } from "../src/github-bot";

const cfg: GithubConfig = {
  trigger: "@haiflow",
  allowedRepos: new Set(["acme/widgets"]),
  allowedSenders: new Set(["alice"]),
};

function comment(overrides: any = {}) {
  return {
    action: "created",
    comment: { id: 99, body: "@haiflow please fix the login bug" },
    repository: { full_name: "acme/widgets" },
    sender: { login: "alice" },
    issue: { number: 42 },
    ...overrides,
  };
}

describe("evaluateWebhook gating", () => {
  test("handles an allowlisted mention on an allowlisted repo", () => {
    const d = evaluateWebhook("issue_comment", comment(), cfg);
    expect(d.handle).toBe(true);
    expect(d.repo).toBe("acme/widgets");
    expect(d.issueNumber).toBe(42);
    expect(d.sender).toBe("alice");
  });

  test("ignores non-comment events", () => {
    expect(evaluateWebhook("push", comment(), cfg).handle).toBe(false);
  });

  test("ignores edits (action != created)", () => {
    expect(evaluateWebhook("issue_comment", comment({ action: "edited" }), cfg).handle).toBe(false);
  });

  test("ignores comments without the trigger phrase", () => {
    expect(evaluateWebhook("issue_comment", comment({ comment: { id: 1, body: "thanks" } }), cfg).handle).toBe(false);
  });

  test("refuses a repo that is not allowlisted", () => {
    const d = evaluateWebhook("issue_comment", comment({ repository: { full_name: "evil/repo" } }), cfg);
    expect(d.handle).toBe(false);
    expect(d.reason).toContain("repo");
  });

  test("refuses a sender that is not allowlisted", () => {
    const d = evaluateWebhook("issue_comment", comment({ sender: { login: "mallory" } }), cfg);
    expect(d.handle).toBe(false);
    expect(d.reason).toContain("sender");
  });

  test("detects a PR comment", () => {
    const d = evaluateWebhook("issue_comment", comment({ issue: { number: 7, pull_request: {} } }), cfg);
    expect(d.handle).toBe(true);
    expect(d.isPR).toBe(true);
  });
});

describe("buildGithubPrompt framing", () => {
  test("frames the comment as untrusted and enforces draft-PR rules", () => {
    const d = evaluateWebhook("issue_comment", comment(), cfg);
    const prompt = buildGithubPrompt(d);
    expect(prompt).toContain("BEGIN COMMENT");
    expect(prompt).toContain("please fix the login bug");
    expect(prompt).toContain("UNTRUSTED");
    expect(prompt).toContain("DRAFT pull request");
    expect(prompt).toContain("never commit to or push the default branch");
  });
});
