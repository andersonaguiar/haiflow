import { test, expect, describe } from "bun:test";
import { createHmac } from "crypto";
import { verifySignature, type IngestRecipe } from "../src/ingest";

const SECRET = "unit-secret";
const hmac = (data: string) => createHmac("sha256", SECRET).update(data).digest("hex");
const nowSec = () => Math.floor(Date.now() / 1000);

describe("verifySignature: github scheme", () => {
  const recipe: IngestRecipe = { scheme: "github", secret: SECRET, target: "trigger" };
  const body = JSON.stringify({ action: "opened" });

  test("accepts a valid signature and uses the delivery GUID as the nonce", () => {
    const r = verifySignature(recipe, body, {
      "x-hub-signature-256": "sha256=" + hmac(body),
      "x-github-delivery": "guid-123",
    });
    expect(r.ok).toBe(true);
    expect(r.nonce).toBe("guid-123");
  });

  test("falls back to the signature as nonce when no delivery header is present", () => {
    const sig = "sha256=" + hmac(body);
    const r = verifySignature(recipe, body, { "x-hub-signature-256": sig });
    expect(r.ok).toBe(true);
    expect(r.nonce).toBe(sig);
  });

  test("two identical-body events get distinct nonces via their delivery GUIDs", () => {
    const sig = "sha256=" + hmac(body);
    const a = verifySignature(recipe, body, { "x-hub-signature-256": sig, "x-github-delivery": "guid-a" });
    const b = verifySignature(recipe, body, { "x-hub-signature-256": sig, "x-github-delivery": "guid-b" });
    expect(a.ok && b.ok).toBe(true);
    expect(a.nonce).not.toBe(b.nonce);
  });

  test("rejects a tampered signature", () => {
    const r = verifySignature(recipe, body, {
      "x-hub-signature-256": "sha256=deadbeef",
      "x-github-delivery": "guid-x",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad signature");
  });
});

describe("verifySignature: stripe scheme", () => {
  const recipe: IngestRecipe = { scheme: "stripe", secret: SECRET, target: "publish", topic: "t", maxAgeSec: 300 };
  const body = JSON.stringify({ id: "evt_1" });

  test("accepts a fresh, valid signature signed over t.body", () => {
    const t = nowSec();
    const v1 = hmac(`${t}.${body}`);
    const r = verifySignature(recipe, body, { "stripe-signature": `t=${t},v1=${v1}` });
    expect(r.ok).toBe(true);
    expect(r.nonce).toBe(v1);
  });

  test("rejects a tampered v1", () => {
    const r = verifySignature(recipe, body, { "stripe-signature": `t=${nowSec()},v1=deadbeef` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad signature");
  });

  test("rejects a malformed header (missing v1)", () => {
    const r = verifySignature(recipe, body, { "stripe-signature": `t=${nowSec()}` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed stripe-signature");
  });

  test("rejects a stale timestamp outside maxAge", () => {
    const t = nowSec() - 10_000;
    const v1 = hmac(`${t}.${body}`); // signature is valid; only freshness fails
    const r = verifySignature(recipe, body, { "stripe-signature": `t=${t},v1=${v1}` });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale timestamp");
  });
});

describe("verifySignature: generic hmac-sha256 timestamp freshness", () => {
  const recipe: IngestRecipe = { scheme: "hmac-sha256", secret: SECRET, target: "trigger", maxAgeSec: 300 };
  const body = JSON.stringify({ hello: "world" });

  test("accepts a fresh timestamped request signed over ts.body", () => {
    const ts = String(nowSec());
    const r = verifySignature(recipe, body, {
      "x-haiflow-timestamp": ts,
      "x-haiflow-signature": hmac(`${ts}.${body}`),
    });
    expect(r.ok).toBe(true);
  });

  test("rejects a stale timestamp", () => {
    const ts = String(nowSec() - 10_000);
    const r = verifySignature(recipe, body, {
      "x-haiflow-timestamp": ts,
      "x-haiflow-signature": hmac(`${ts}.${body}`),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stale or invalid timestamp");
  });

  test("without a timestamp, signs over the raw body and uses the signature as nonce", () => {
    const sig = hmac(body);
    const r = verifySignature(recipe, body, { "x-haiflow-signature": sig });
    expect(r.ok).toBe(true);
    expect(r.nonce).toBe(sig);
  });
});
