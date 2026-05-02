import { RedisClient } from "bun";

// --- Types ---

export type EventStatus = "published" | "delivered" | "partial" | "failed";
export type DeliveryStatus = "pending" | "delivered" | "queued" | "failed" | "skipped";
export type DeliveryType = "session" | "webhook";

export interface EventRecord {
  id: string;
  topic: string;
  message: string;
  sourceSession: string;
  taskId: string;
  chain: string[];
  publishedAt: string;
  status: EventStatus;
}

export interface DeliveryRecord {
  eventId: string;
  subscriber: string;
  type: DeliveryType;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export interface WebhookRetry extends DeliveryRecord {
  topic: string;
  message: string;
}

const EVENT_TTL = 7 * 86_400; // 7 days in seconds
const MAX_EVENTS = 1000;
const CONNECT_TIMEOUT_MS = 3000;

// --- EventBus ---

export class EventBus {
  private redis: RedisClient;
  // false when Redis is unreachable. Methods short-circuit to safe defaults
  // so the rest of the server (HTTP API, sessions, queues) keeps working.
  // Pipeline events become fire-and-forget — no persistence, no retry.
  public readonly connected: boolean;

  private constructor(redisUrl: string, connected: boolean) {
    this.redis = new RedisClient(redisUrl);
    this.connected = connected;
  }

  static async create(redisUrl: string): Promise<EventBus> {
    const probe = new RedisClient(redisUrl);
    try {
      await Promise.race([
        probe.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("redis connect timeout")), CONNECT_TIMEOUT_MS)
        ),
      ]);
      probe.close();
      return new EventBus(redisUrl, true);
    } catch (err) {
      probe.close();
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "redis_unavailable",
        url: redisUrl,
        error: err instanceof Error ? err.message : String(err),
        note: "Pipeline events fall back to direct dispatch — no persistence or retry.",
      }));
      return new EventBus(redisUrl, false);
    }
  }

  /** Record a new event. Returns the event ID. */
  async recordEvent(opts: {
    topic: string;
    message: string;
    sourceSession: string;
    taskId: string;
    chain?: string[];
  }): Promise<string> {
    const id = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!this.connected) return id;

    const record: EventRecord = {
      id,
      topic: opts.topic,
      message: opts.message,
      sourceSession: opts.sourceSession,
      taskId: opts.taskId,
      chain: opts.chain ?? [],
      publishedAt: new Date().toISOString(),
      status: "published",
    };

    await this.redis.set(`haiflow:event:${id}`, JSON.stringify(record));
    await this.redis.expire(`haiflow:event:${id}`, EVENT_TTL);
    await this.redis.send("LPUSH", ["haiflow:events", id]);
    await this.redis.send("LTRIM", ["haiflow:events", "0", String(MAX_EVENTS - 1)]);
    await this.redis.send("SADD", ["haiflow:events:unprocessed", id]);

    return id;
  }

  /** Record a delivery for a subscriber. */
  async recordDelivery(
    eventId: string,
    subscriber: string,
    type: DeliveryType,
    status: DeliveryStatus
  ): Promise<void> {
    if (!this.connected) return;
    const now = new Date().toISOString();
    const record: DeliveryRecord = {
      eventId,
      subscriber,
      type,
      status,
      attempts: status === "delivered" || status === "queued" ? 1 : 0,
      lastError: null,
      deliveredAt: status === "delivered" ? now : null,
      nextRetryAt: null,
      createdAt: now,
    };

    await this.redis.send("HSET", [
      `haiflow:deliveries:${eventId}`,
      subscriber,
      JSON.stringify(record),
    ]);
    await this.redis.expire(`haiflow:deliveries:${eventId}`, EVENT_TTL);
  }

  /** Update a delivery's status. */
  async updateDelivery(
    eventId: string,
    subscriber: string,
    update: {
      status: DeliveryStatus;
      lastError?: string;
      nextRetryAt?: string;
    }
  ): Promise<void> {
    if (!this.connected) return;
    const fields = await this.redis.hmget(`haiflow:deliveries:${eventId}`, [subscriber]);
    const raw = fields?.[0];
    if (!raw) return;

    const record: DeliveryRecord = JSON.parse(raw);
    record.status = update.status;
    record.attempts += 1;
    if (update.lastError !== undefined) record.lastError = update.lastError;
    if (update.nextRetryAt !== undefined) record.nextRetryAt = update.nextRetryAt;
    if (update.status === "delivered") record.deliveredAt = new Date().toISOString();

    await this.redis.send("HSET", [
      `haiflow:deliveries:${eventId}`,
      subscriber,
      JSON.stringify(record),
    ]);

    // Update retry sorted set
    const retryKey = `${eventId}|${subscriber}`;
    if (update.status === "failed" && update.nextRetryAt) {
      await this.redis.send("ZADD", [
        "haiflow:retries",
        String(new Date(update.nextRetryAt).getTime()),
        retryKey,
      ]);
    } else {
      await this.redis.send("ZREM", ["haiflow:retries", retryKey]);
    }
  }

  /** Compute overall event status from its deliveries. */
  async finalizeEvent(eventId: string): Promise<void> {
    if (!this.connected) return;
    const deliveries = await this.getDeliveries(eventId);
    let status: EventStatus;

    if (deliveries.length === 0) {
      status = "delivered";
    } else {
      const statuses = deliveries.map((d) => d.status);
      const hasPending = statuses.includes("pending");
      const hasFailed = statuses.includes("failed");
      const allDone = statuses.every((s) => s === "delivered" || s === "skipped" || s === "queued");

      if (hasPending) {
        status = "published";
      } else if (allDone) {
        status = "delivered";
      } else if (hasFailed && statuses.some((s) => s === "delivered" || s === "queued")) {
        status = "partial";
      } else {
        status = "failed";
      }
    }

    // Update event status
    const raw = await this.redis.get(`haiflow:event:${eventId}`);
    if (!raw) return;
    const record: EventRecord = JSON.parse(raw);
    record.status = status;
    await this.redis.set(`haiflow:event:${eventId}`, JSON.stringify(record));

    // Remove from unprocessed set if no longer "published"
    if (status !== "published") {
      await this.redis.send("SREM", ["haiflow:events:unprocessed", eventId]);
    }
  }

  /** Get recent events, newest first. */
  async getRecentEvents(limit = 50): Promise<EventRecord[]> {
    if (!this.connected) return [];
    const ids = (await this.redis.send("LRANGE", ["haiflow:events", "0", String(limit - 1)])) as string[];
    if (!ids || ids.length === 0) return [];

    const events: EventRecord[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`haiflow:event:${id}`);
      if (raw) events.push(JSON.parse(raw));
    }
    return events;
  }

  /** Get all deliveries for an event. */
  async getDeliveries(eventId: string): Promise<DeliveryRecord[]> {
    if (!this.connected) return [];
    const raw = await this.redis.send("HGETALL", [`haiflow:deliveries:${eventId}`]);
    if (!raw) return [];

    // HGETALL may return array [field, value, ...] or object depending on Bun version
    const deliveries: DeliveryRecord[] = [];
    if (Array.isArray(raw)) {
      for (let i = 1; i < raw.length; i += 2) {
        deliveries.push(JSON.parse(raw[i]));
      }
    } else if (typeof raw === "object") {
      for (const value of Object.values(raw as Record<string, string>)) {
        deliveries.push(JSON.parse(value));
      }
    }
    return deliveries;
  }

  /** Get failed webhook deliveries that are due for retry. */
  async getPendingWebhookRetries(): Promise<WebhookRetry[]> {
    if (!this.connected) return [];
    const now = String(Date.now());
    const members = (await this.redis.send("ZRANGEBYSCORE", [
      "haiflow:retries", "0", now,
    ])) as string[];
    if (!members || members.length === 0) return [];

    const retries: WebhookRetry[] = [];
    for (const member of members) {
      const [eventId, subscriber] = member.split("|");
      const fields = await this.redis.hmget(`haiflow:deliveries:${eventId}`, [subscriber]);
      const deliveryRaw = fields?.[0];
      if (!deliveryRaw) continue;

      const delivery: DeliveryRecord = JSON.parse(deliveryRaw);
      if (delivery.type !== "webhook" || delivery.status !== "failed" || delivery.attempts >= 5) continue;

      const eventRaw = await this.redis.get(`haiflow:event:${eventId}`);
      if (!eventRaw) continue;

      const event: EventRecord = JSON.parse(eventRaw);
      retries.push({
        ...delivery,
        topic: event.topic,
        message: event.message,
      });
    }
    return retries;
  }

  /** Get events with status 'published' (unprocessed, for startup replay). */
  async getUnprocessedEvents(): Promise<EventRecord[]> {
    if (!this.connected) return [];
    const ids = (await this.redis.send("SMEMBERS", ["haiflow:events:unprocessed"])) as string[];
    if (!ids || ids.length === 0) return [];

    const events: EventRecord[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`haiflow:event:${id}`);
      if (raw) {
        const record: EventRecord = JSON.parse(raw);
        if (record.status === "published") events.push(record);
      }
    }
    // Sort oldest first for replay order
    events.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    return events;
  }

  /** Delete events older than N days. Returns count deleted. */
  async prune(olderThanDays = 7): Promise<number> {
    if (!this.connected) return 0;
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const allIds = (await this.redis.send("LRANGE", ["haiflow:events", "0", "-1"])) as string[];
    if (!allIds || allIds.length === 0) return 0;

    let pruned = 0;
    const keepIds: string[] = [];

    for (const id of allIds) {
      const raw = await this.redis.get(`haiflow:event:${id}`);
      if (!raw) continue;

      const record: EventRecord = JSON.parse(raw);
      if (record.publishedAt < cutoff) {
        await this.redis.del(`haiflow:event:${id}`);
        await this.redis.del(`haiflow:deliveries:${id}`);
        await this.redis.send("SREM", ["haiflow:events:unprocessed", id]);
        pruned++;
      } else {
        keepIds.push(id);
      }
    }

    // Rebuild the events list with only kept IDs
    if (pruned > 0) {
      await this.redis.del("haiflow:events");
      if (keepIds.length > 0) {
        await this.redis.send("RPUSH", ["haiflow:events", ...keepIds]);
      }
    }

    return pruned;
  }

  /** Flush all haiflow keys (for testing). */
  async flush(): Promise<void> {
    if (!this.connected) return;
    const keys = (await this.redis.send("KEYS", ["haiflow:*"])) as string[];
    if (keys && keys.length > 0) {
      for (const key of keys) {
        await this.redis.del(key);
      }
    }
  }

  /** Close the Redis connection. */
  close() {
    if (!this.connected) return;
    this.redis.close();
  }
}
