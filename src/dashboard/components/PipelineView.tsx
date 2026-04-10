import React, { useState, useCallback } from "react";
import { getPipeline, getPipelineTopics, getEvents, publishEvent } from "../api";
import { Badge, Card, EmptyState, Skeleton, NetworkIcon, useToast } from "./ui";
import { usePolling } from "../hooks";
import { timeAgo, truncate } from "../utils";
import type { PipelineConfig, EventRecord, DeliveryRecord } from "../types";

// --- Pipeline Config Section ---

function TopicCard({ name, config }: { name: string; config: { description?: string; subscribers?: { session: string; promptTemplate: string; enabled?: boolean }[]; webhooks?: { url: string; method?: string; enabled?: boolean }[] } }) {
  return (
    <Card className="p-3 space-y-2">
      <div>
        <h4 className="text-sm font-medium text-gray-200">{name}</h4>
        {config.description && <p className="text-xs text-gray-500 mt-0.5">{config.description}</p>}
      </div>

      {config.subscribers && config.subscribers.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Subscribers</span>
          <div className="mt-1 space-y-1">
            {config.subscribers.map((sub, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <Badge variant="session" />
                <span className="text-gray-300">{sub.session}</span>
                {sub.enabled === false && <span className="text-gray-600 text-[10px]">(disabled)</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {config.webhooks && config.webhooks.length > 0 && (
        <div>
          <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Webhooks</span>
          <div className="mt-1 space-y-1">
            {config.webhooks.map((wh, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <Badge variant="webhook" />
                <span className="text-gray-400 font-mono truncate max-w-48">{wh.url}</span>
                {wh.method && <span className="text-gray-600 text-[10px] uppercase">{wh.method}</span>}
                {wh.enabled === false && <span className="text-gray-600 text-[10px]">(disabled)</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function EmitterRow({ session, topics }: { session: string; topics: string[] }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1.5">
      <span className="text-gray-300 font-medium min-w-24">{session}</span>
      <span className="text-gray-600">&rarr;</span>
      <div className="flex gap-1 flex-wrap">
        {topics.map((t) => (
          <span key={t} className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-400 text-[10px]">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function PipelineConfig({ pipeline }: { pipeline: PipelineConfig }) {
  const topicEntries = Object.entries(pipeline.topics);
  const emitterEntries = Object.entries(pipeline.emitters);
  const isEmpty = topicEntries.length === 0 && emitterEntries.length === 0;

  if (isEmpty) {
    return (
      <EmptyState
        icon={<NetworkIcon size={24} />}
        title="No pipeline configured"
        description="Create a pipeline.json in your data directory to set up topics, subscribers, and emitters"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Topics */}
      <div>
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
          Topics ({topicEntries.length})
        </h3>
        <div className="space-y-2">
          {topicEntries.map(([name, config]) => (
            <TopicCard key={name} name={name} config={config} />
          ))}
        </div>
      </div>

      {/* Emitters */}
      {emitterEntries.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
            Emitters ({emitterEntries.length})
          </h3>
          <Card className="p-3">
            {emitterEntries.map(([session, topics]) => (
              <EmitterRow key={session} session={session} topics={topics} />
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}

// --- Publish Form ---

function PublishForm({ topics }: { topics: string[] }) {
  const [topic, setTopic] = useState("");
  const [session, setSession] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic || !message.trim()) return;
    setLoading(true);
    try {
      await publishEvent(topic, message.trim(), session.trim() || undefined);
      toast("Event published", "success");
      setMessage("");
    } catch {
      toast("Failed to publish event", "error");
    }
    setLoading(false);
  };

  return (
    <Card className="p-4">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Publish Event</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-600 font-medium block mb-1">Topic</label>
            {topics.length > 0 ? (
              <select
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-gray-500 transition-colors"
              >
                <option value="">Select topic...</option>
                {topics.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Topic name"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-gray-500 transition-colors"
              />
            )}
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-gray-600 font-medium block mb-1">Source Session (optional)</label>
            <input
              type="text"
              value={session}
              onChange={(e) => setSession(e.target.value)}
              placeholder="external"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-gray-500 transition-colors"
            />
          </div>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-600 font-medium block mb-1">Message</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Event message..."
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-gray-500 resize-none transition-colors"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading || !topic || !message.trim()}
            className="bg-gray-700 hover:bg-gray-600 rounded px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading ? "Publishing..." : "Publish"}
          </button>
        </div>
      </form>
    </Card>
  );
}

// --- Event History ---

function DeliveryRow({ delivery }: { delivery: DeliveryRecord }) {
  return (
    <div className="flex items-center gap-3 text-xs py-1 px-1">
      <Badge variant={delivery.type} className="text-[10px]" />
      <span className="text-gray-300 min-w-24">{delivery.subscriber}</span>
      <Badge variant={delivery.status} className="text-[10px]" />
      {delivery.attempts > 1 && (
        <span className="text-gray-600 text-[10px]">{delivery.attempts} attempts</span>
      )}
      {delivery.lastError && (
        <span className="text-red-400/70 text-[10px] truncate max-w-40" title={delivery.lastError}>
          {delivery.lastError}
        </span>
      )}
      {delivery.nextRetryAt && (
        <span className="text-gray-600 text-[10px]">retry {timeAgo(delivery.nextRetryAt)}</span>
      )}
    </div>
  );
}

function EventRow({ event }: { event: EventRecord }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-gray-800/50 transition-colors text-sm"
      >
        <Badge variant={event.status} className="text-[10px] shrink-0" />
        <span className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-400 shrink-0">
          {event.topic}
        </span>
        <span className="text-gray-500 text-xs shrink-0">{event.sourceSession}</span>
        <span className="text-gray-400 text-xs truncate flex-1">{truncate(event.message, 80)}</span>
        <span className="text-[10px] text-gray-600 shrink-0">{timeAgo(event.publishedAt)}</span>
        <span className="text-xs text-gray-600 shrink-0 w-4 text-center">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 animate-[fadeIn_150ms_ease-out]">
          <div>
            <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Message</span>
            <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 mt-0.5 whitespace-pre-wrap break-words overflow-x-auto">
              {event.message}
            </pre>
          </div>
          {event.chain.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Chain</span>
              <div className="flex gap-1 mt-0.5">
                {event.chain.map((c, i) => (
                  <span key={i} className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-400">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}
          {event.deliveries.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">
                Deliveries ({event.deliveries.length})
              </span>
              <div className="mt-1 bg-gray-800/50 rounded p-2 space-y-0.5">
                {event.deliveries.map((d, i) => (
                  <DeliveryRow key={i} delivery={d} />
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-4 text-[10px] text-gray-600">
            <span>ID: <span className="font-mono">{event.id}</span></span>
            <span>Task: <span className="font-mono">{event.taskId}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}

function EventHistory() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    try {
      const data = await getEvents(50);
      setEvents(data.events || []);
    } catch {}
    setLoading(false);
  }, []);

  usePolling(fetchEvents, 5000);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 rounded" />
        <Skeleton className="h-10 rounded" />
        <Skeleton className="h-10 rounded" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        title="No events yet"
        description="Events will appear here when published to pipeline topics"
      />
    );
  }

  return (
    <Card>
      {events.map((e) => (
        <EventRow key={e.id} event={e} />
      ))}
    </Card>
  );
}

// --- Main Pipeline View ---

export function PipelineView() {
  const [pipeline, setPipeline] = useState<PipelineConfig | null>(null);
  const [topics, setTopics] = useState<string[]>([]);

  const fetchPipeline = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([getPipeline(), getPipelineTopics()]);
      setPipeline(p);
      setTopics(t);
    } catch {}
  }, []);

  usePolling(fetchPipeline, 10_000);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      {/* Config */}
      <section>
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Pipeline Configuration</h2>
        {pipeline ? (
          <PipelineConfig pipeline={pipeline} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Skeleton className="h-32 rounded-lg" />
            <Skeleton className="h-32 rounded-lg" />
          </div>
        )}
      </section>

      {/* Publish */}
      <section>
        <PublishForm topics={topics} />
      </section>

      {/* Event History */}
      <section>
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Event History</h2>
        <EventHistory />
      </section>
    </div>
  );
}
