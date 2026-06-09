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

export interface TaskStep {
  seq: number;
  tool: string;
  summary: string;
  isError: boolean;
  detail?: string;
  filePath?: string;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface TaskRow {
  id: string;
  session: string;
  prompt: string | null;
  source: string | null;
  status: "running" | "completed" | "timed_out" | "cancelled" | "failed";
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  model: string | null;
  chain: string[];
  steps: TaskStep[];
  usage: TaskUsage | null;
  saved_usd: number | null;
  files_changed: string[];
  commands_run: string[];
  error: string | null;
  messages?: string[];
}

export interface UsageWindow {
  session: string;
  windows: {
    "5h": { tasks: number; totalTokens: number; savedUsd: number };
    "7d": { tasks: number; totalTokens: number; savedUsd: number };
  };
  alertThresholdTokens: number | null;
  alert: boolean;
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
