export interface Session {
  session: string;
  status: "idle" | "busy" | "offline";
  tmux: string;
}

export type SessionStatus = Session["status"];

export interface Status {
  status: SessionStatus;
  since: string;
  currentPrompt?: string;
  currentTaskId?: string;
  queueLength: number;
}

export interface QueueItem {
  id: string;
  prompt: string;
  addedAt: string;
  source?: string;
}

export interface ResponseItem {
  id: string;
  completed_at: string;
}

export interface PipelineSubscriber {
  session: string;
  promptTemplate: string;
  enabled?: boolean;
}

export interface WebhookSubscriber {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface TopicConfig {
  description?: string;
  subscribers: PipelineSubscriber[];
  webhooks?: WebhookSubscriber[];
}

export interface PipelineConfig {
  topics: Record<string, TopicConfig>;
  emitters: Record<string, string[]>;
  redis: boolean;
  recentEvents: PipelineEvent[];
}

export interface PipelineEvent {
  topic: string;
  sourceSession: string;
  taskId: string;
  subscribers: string[];
  publishedAt: string;
}

export type DeliveryStatus = "pending" | "delivered" | "queued" | "failed" | "skipped";
export type EventStatus = "published" | "delivered" | "partial" | "failed";

export interface DeliveryRecord {
  eventId: string;
  subscriber: string;
  type: "session" | "webhook";
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  topic: string;
  message: string;
  sourceSession: string;
  taskId: string;
  chain: string[];
  publishedAt: string;
  status: EventStatus;
  deliveries: DeliveryRecord[];
}
