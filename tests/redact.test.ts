import { test, expect, describe } from "bun:test";
import { redact } from "../src/redact";

describe("secret redaction", () => {
  test("redacts an AWS access key", () => {
    const r = redact("creds: AKIAIOSFODNN7EXAMPLE done");
    expect(r.text).toContain("[REDACTED:aws-access-key]");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.count).toBe(1);
    expect(r.types).toContain("aws-access-key");
  });

  test("redacts a GitHub token", () => {
    const r = redact("token ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(r.text).toContain("[REDACTED:github-token]");
  });

  test("redacts an Anthropic key without tripping the OpenAI rule twice", () => {
    const r = redact("key=sk-ant-abc123def456ghi789jkl012mno");
    expect(r.text).toContain("[REDACTED:anthropic-key]");
    expect(r.count).toBe(1);
  });

  test("redacts a JWT and a Bearer token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijKLMNOP";
    const r = redact(`auth eyJ ${jwt} and Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234`);
    expect(r.text).toContain("[REDACTED:jwt]");
    expect(r.text).toContain("[REDACTED:bearer-token]");
  });

  test("redacts a private key block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nABCDEF\nGHIJKL\n-----END RSA PRIVATE KEY-----";
    const r = redact(`here it is:\n${key}\nthanks`);
    expect(r.text).toContain("[REDACTED:private-key]");
    expect(r.text).not.toContain("ABCDEF");
  });

  test("leaves ordinary text untouched", () => {
    const r = redact("Fixed the bug in foo.ts at commit 1a2b3c4. All 12 tests pass.");
    expect(r.count).toBe(0);
    expect(r.text).toBe("Fixed the bug in foo.ts at commit 1a2b3c4. All 12 tests pass.");
  });

  test("emails are opt-in", () => {
    expect(redact("ping me at a@b.com").count).toBe(0);
    const r = redact("ping me at a@b.com", { emails: true });
    expect(r.text).toContain("[REDACTED:email]");
  });

  test("supports operator-supplied extra patterns", () => {
    const r = redact("internal id ACME-9988", { extraPatterns: [/ACME-\d+/g] });
    expect(r.text).toContain("[REDACTED:custom]");
  });
});
