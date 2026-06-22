import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { EventBus, nextRetrySchedule } from "../src/events";

describe("nextRetrySchedule (webhook retry backoff)", () => {
  const NOW = 1_000_000_000_000;

  test("doubles the delay each attempt: 60s, 120s, 240s, 480s", () => {
    expect(nextRetrySchedule(0, NOW)?.delayMs).toBe(60_000);
    expect(nextRetrySchedule(1, NOW)?.delayMs).toBe(120_000);
    expect(nextRetrySchedule(2, NOW)?.delayMs).toBe(240_000);
    expect(nextRetrySchedule(3, NOW)?.delayMs).toBe(480_000);
  });

  test("nextRetryAt is now + delay", () => {
    const s = nextRetrySchedule(1, NOW);
    expect(s?.nextRetryAt).toBe(new Date(NOW + 120_000).toISOString());
  });

  test("gives up (null) once 5 attempts are reached", () => {
    expect(nextRetrySchedule(4, NOW)).toBeNull();
    expect(nextRetrySchedule(5, NOW)).toBeNull();
  });
});

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let bus: EventBus;

beforeEach(async () => {
  bus = await EventBus.create(REDIS_URL);
  await bus.flush();
});

afterEach(async () => {
  await bus.flush();
  bus.close();
});

describe("EventBus no-Redis fallback", () => {
  test("degrades safely when Redis is unreachable", async () => {
    // Port 1 is never a Redis server, so the client cannot connect.
    const offline = await EventBus.create("redis://127.0.0.1:1");
    try {
      // The getter delegates to the live client, so it reports the real state.
      expect(offline.connected).toBe(false);

      // recordEvent still returns a usable evt_ id so caller code is unaffected,
      // but nothing is persisted.
      const id = await offline.recordEvent({
        topic: "t", message: "m", sourceSession: "s", taskId: "task_1",
      });
      expect(id).toStartWith("evt_");
      expect(await offline.getRecentEvents()).toEqual([]);
      expect(await offline.getUnprocessedEvents()).toEqual([]);

      // markNonce reports "unavailable" (not a silent "fresh") when there is no
      // store to dedupe against, so callers can fail closed instead of proceeding.
      expect(await offline.markNonce("nonce-1", 60)).toBe("unavailable");
    } finally {
      offline.close();
    }
  });
});

describe("EventBus", () => {
  // --- markNonce (replay nonce) ---

  test("markNonce: fresh once, then duplicate", async () => {
    const key = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    expect(await bus.markNonce(key, 60)).toBe("fresh");
    expect(await bus.markNonce(key, 60)).toBe("duplicate");
  });

  // --- recordEvent ---

  test("recordEvent returns an event ID", async () => {
    const id = await bus.recordEvent({
      topic: "test.done",
      message: "hello",
      sourceSession: "agent-1",
      taskId: "task_123",
    });
    expect(id).toStartWith("evt_");
  });

  test("recordEvent stores event with published status", async () => {
    await bus.recordEvent({
      topic: "test.done",
      message: "result",
      sourceSession: "agent-1",
      taskId: "task_123",
      chain: ["agent-0"],
    });

    const events = await bus.getRecentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe("test.done");
    expect(events[0]!.message).toBe("result");
    expect(events[0]!.sourceSession).toBe("agent-1");
    expect(events[0]!.taskId).toBe("task_123");
    expect(events[0]!.chain).toEqual(["agent-0"]);
    expect(events[0]!.status).toBe("published");
    expect(events[0]!.publishedAt).toBeTruthy();
  });

  test("recordEvent defaults chain to empty array", async () => {
    await bus.recordEvent({
      topic: "test.done",
      message: "hello",
      sourceSession: "agent-1",
      taskId: "task_123",
    });

    const events = await bus.getRecentEvents();
    expect(events[0]!.chain).toEqual([]);
  });

  // --- getRecentEvents ---

  test("getRecentEvents returns newest first", async () => {
    await bus.recordEvent({ topic: "a", message: "first", sourceSession: "s", taskId: "t1" });
    await bus.recordEvent({ topic: "b", message: "second", sourceSession: "s", taskId: "t2" });

    const events = await bus.getRecentEvents();
    expect(events[0]!.topic).toBe("b");
    expect(events[1]!.topic).toBe("a");
  });

  test("getRecentEvents respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await bus.recordEvent({ topic: "t", message: `msg${i}`, sourceSession: "s", taskId: `t${i}` });
    }

    const events = await bus.getRecentEvents(3);
    expect(events).toHaveLength(3);
  });

  // --- recordDelivery ---

  test("recordDelivery stores delivery with correct fields", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "worker", "session", "queued");

    const deliveries = await bus.getDeliveries(eventId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventId).toBe(eventId);
    expect(deliveries[0]!.subscriber).toBe("worker");
    expect(deliveries[0]!.type).toBe("session");
    expect(deliveries[0]!.status).toBe("queued");
    expect(deliveries[0]!.attempts).toBe(1);
    expect(deliveries[0]!.createdAt).toBeTruthy();
  });

  test("recordDelivery sets deliveredAt for delivered status", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "worker", "session", "delivered");

    const deliveries = await bus.getDeliveries(eventId);
    expect(deliveries[0]!.deliveredAt).toBeTruthy();
  });

  test("recordDelivery does not set deliveredAt for pending status", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://example.com", "webhook", "pending");

    const deliveries = await bus.getDeliveries(eventId);
    expect(deliveries[0]!.deliveredAt).toBeNull();
    expect(deliveries[0]!.attempts).toBe(0);
  });

  // --- updateDelivery ---

  test("updateDelivery changes status and increments attempts", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");

    await bus.updateDelivery(eventId, "webhook:http://x.com", { status: "delivered" });

    const deliveries = await bus.getDeliveries(eventId);
    expect(deliveries[0]!.status).toBe("delivered");
    expect(deliveries[0]!.attempts).toBe(1);
    expect(deliveries[0]!.deliveredAt).toBeTruthy();
  });

  test("updateDelivery stores error and retry time", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");

    const retryAt = new Date(Date.now() + 60_000).toISOString();
    await bus.updateDelivery(eventId, "webhook:http://x.com", {
      status: "failed",
      lastError: "connection refused",
      nextRetryAt: retryAt,
    });

    const deliveries = await bus.getDeliveries(eventId);
    expect(deliveries[0]!.status).toBe("failed");
    expect(deliveries[0]!.lastError).toBe("connection refused");
    expect(deliveries[0]!.nextRetryAt).toBe(retryAt);
  });

  // --- finalizeEvent ---

  test("finalizeEvent sets delivered when all deliveries done", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "worker-1", "session", "delivered");
    await bus.recordDelivery(eventId, "worker-2", "session", "queued");
    await bus.recordDelivery(eventId, "disabled", "session", "skipped");

    await bus.finalizeEvent(eventId);

    const events = await bus.getRecentEvents();
    expect(events[0]!.status).toBe("delivered");
  });

  test("finalizeEvent sets partial when some failed", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "worker", "session", "delivered");
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");
    await bus.updateDelivery(eventId, "webhook:http://x.com", { status: "failed", lastError: "timeout" });

    await bus.finalizeEvent(eventId);

    const events = await bus.getRecentEvents();
    expect(events[0]!.status).toBe("partial");
  });

  test("finalizeEvent sets failed when all failed", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://a.com", "webhook", "pending");
    await bus.recordDelivery(eventId, "webhook:http://b.com", "webhook", "pending");
    await bus.updateDelivery(eventId, "webhook:http://a.com", { status: "failed", lastError: "err" });
    await bus.updateDelivery(eventId, "webhook:http://b.com", { status: "failed", lastError: "err" });

    await bus.finalizeEvent(eventId);

    const events = await bus.getRecentEvents();
    expect(events[0]!.status).toBe("failed");
  });

  test("finalizeEvent stays published when deliveries pending", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");

    await bus.finalizeEvent(eventId);

    const events = await bus.getRecentEvents();
    expect(events[0]!.status).toBe("published");
  });

  test("finalizeEvent sets delivered when no deliveries", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });

    await bus.finalizeEvent(eventId);

    const events = await bus.getRecentEvents();
    expect(events[0]!.status).toBe("delivered");
  });

  // --- getPendingWebhookRetries ---

  test("getPendingWebhookRetries returns failed webhooks due for retry", async () => {
    const eventId = await bus.recordEvent({ topic: "calc.done", message: "4", sourceSession: "calc", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");

    const pastRetry = new Date(Date.now() - 1000).toISOString();
    await bus.updateDelivery(eventId, "webhook:http://x.com", {
      status: "failed",
      lastError: "timeout",
      nextRetryAt: pastRetry,
    });

    const retries = await bus.getPendingWebhookRetries();
    expect(retries).toHaveLength(1);
    expect(retries[0]!.topic).toBe("calc.done");
    expect(retries[0]!.message).toBe("4");
  });

  test("getPendingWebhookRetries excludes future retries", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");

    const futureRetry = new Date(Date.now() + 600_000).toISOString();
    await bus.updateDelivery(eventId, "webhook:http://x.com", {
      status: "failed",
      lastError: "timeout",
      nextRetryAt: futureRetry,
    });

    const retries = await bus.getPendingWebhookRetries();
    expect(retries).toHaveLength(0);
  });

  test("getPendingWebhookRetries excludes deliveries with 5+ attempts", async () => {
    const eventId = await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });
    await bus.recordDelivery(eventId, "webhook:http://x.com", "webhook", "pending");

    const pastRetry = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      await bus.updateDelivery(eventId, "webhook:http://x.com", {
        status: "failed",
        lastError: "err",
        nextRetryAt: pastRetry,
      });
    }

    const retries = await bus.getPendingWebhookRetries();
    expect(retries).toHaveLength(0);
  });

  // --- getUnprocessedEvents ---

  test("getUnprocessedEvents returns events with published status", async () => {
    await bus.recordEvent({ topic: "a", message: "1", sourceSession: "s", taskId: "t1" });
    const id2 = await bus.recordEvent({ topic: "b", message: "2", sourceSession: "s", taskId: "t2" });

    await bus.finalizeEvent(id2);

    const unprocessed = await bus.getUnprocessedEvents();
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0]!.topic).toBe("a");
  });

  test("getUnprocessedEvents returns oldest first", async () => {
    await bus.recordEvent({ topic: "a", message: "1", sourceSession: "s", taskId: "t1" });
    await bus.recordEvent({ topic: "b", message: "2", sourceSession: "s", taskId: "t2" });

    const unprocessed = await bus.getUnprocessedEvents();
    expect(unprocessed[0]!.topic).toBe("a");
    expect(unprocessed[1]!.topic).toBe("b");
  });

  // --- prune ---

  test("prune deletes old events", async () => {
    await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });

    // Prune with -1 days = cutoff is in the future, deletes everything
    const pruned = await bus.prune(-1);
    expect(pruned).toBe(1);
    expect(await bus.getRecentEvents()).toHaveLength(0);
  });

  test("prune keeps recent events", async () => {
    await bus.recordEvent({ topic: "t", message: "m", sourceSession: "s", taskId: "t1" });

    const pruned = await bus.prune(7);
    expect(pruned).toBe(0);
    expect(await bus.getRecentEvents()).toHaveLength(1);
  });
});
