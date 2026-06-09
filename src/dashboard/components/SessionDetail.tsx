import React, { useState, useCallback } from "react";
import { getStatus, getQueue, getResponses, getResponse, clearQueue, clearResponses, stopSession, interruptSession, cancelQueueItem, AuthError } from "../api";
import { TriggerForm } from "./TriggerForm";
import { TerminalView } from "./TerminalView";
import { HistoryView } from "./HistoryView";
import { Badge, Skeleton, SkeletonLine, EmptyState, Card, StatCard, InboxIcon, MessageIcon, useToast } from "./ui";
import { usePolling } from "../hooks";
import { timeAgo } from "../utils";
import type { Status, QueueItem, ResponseItem } from "../types";

type Tab = "terminal" | "queue" | "responses" | "history";

function ExpandableResponse({ session, id, completedAt }: { session: string; id: string; completedAt: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ prompt?: string; messages?: string[]; redactions?: number } | null>(null);

  const load = async () => {
    if (data) { setOpen(!open); return; }
    setOpen(true);
    try {
      const res = await getResponse(session, id);
      setData({ prompt: res.data.prompt, messages: res.data.messages || [], redactions: res.data.redactions });
    } catch {
      setData({ messages: ["Failed to load response"] });
    }
  };

  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <button onClick={load} className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-800/50 transition-colors text-sm">
        <span className="text-gray-400 font-mono text-xs truncate flex-1">{id}</span>
        <span className="text-xs text-gray-600 shrink-0">{timeAgo(completedAt)}</span>
        <span className="text-xs text-gray-600 shrink-0">{open ? "−" : "+"}</span>
      </button>
      {open && data && (
        <div className="px-3 pb-3 space-y-2 animate-[fadeIn_150ms_ease-out]">
          {data.prompt && (
            <div>
              <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Prompt</span>
              <pre className="text-xs text-blue-300 bg-blue-950/30 border border-blue-900/30 rounded p-2 mt-0.5 whitespace-pre-wrap break-words overflow-x-auto">
                {data.prompt}
              </pre>
            </div>
          )}
          <div>
            <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Response</span>
            {data.redactions ? (
              <span className="ml-2 text-[10px] text-amber-400/80" title="Secret-shaped strings were redacted from this response before storage">
                {data.redactions} redaction{data.redactions === 1 ? "" : "s"}
              </span>
            ) : null}
            {data.messages?.map((msg, i) => (
              <pre key={i} className="text-xs text-gray-300 bg-gray-800 rounded p-2 mt-0.5 whitespace-pre-wrap break-words overflow-x-auto">
                {msg}
              </pre>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ExpandableQueueItem({ item, onCancel }: { item: QueueItem; onCancel: (id: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <div className="w-full px-3 py-2 flex items-center gap-3 hover:bg-gray-800/50 transition-colors text-sm">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-3 text-left flex-1 min-w-0">
          <span className="text-gray-400 font-mono text-xs truncate">{item.id}</span>
          <span className="text-gray-300 truncate max-w-48" title={item.prompt}>{item.prompt}</span>
        </button>
        <span className="text-xs text-gray-600 shrink-0">{timeAgo(item.addedAt)}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onCancel(item.id); }}
          className="text-xs text-red-400/70 hover:text-red-300 shrink-0"
          title="Remove from queue"
        >
          ×
        </button>
        <button onClick={() => setOpen(!open)} className="text-xs text-gray-600 shrink-0">{open ? "−" : "+"}</button>
      </div>
      {open && (
        <div className="px-3 pb-3 animate-[fadeIn_150ms_ease-out]">
          {item.source && (
            <p className="text-[10px] uppercase tracking-wider text-gray-600 font-medium mb-1">
              Source: <span className="text-gray-400 normal-case">{item.source}</span>
            </p>
          )}
          <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Prompt</span>
          <pre className="text-xs text-blue-300 bg-blue-950/30 border border-blue-900/30 rounded p-2 mt-0.5 whitespace-pre-wrap break-words overflow-x-auto">
            {item.prompt}
          </pre>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs font-medium px-3 py-1.5 rounded-t border-b-2 transition-colors ${
        active
          ? "text-gray-200 border-blue-500"
          : "text-gray-500 border-transparent hover:text-gray-400"
      }`}
    >
      {label}{count !== undefined ? ` (${count})` : ""}
    </button>
  );
}

function DetailSkeleton() {
  return (
    <main className="flex-1 overflow-y-auto p-4 space-y-5">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <SkeletonLine width="w-24" />
        </div>
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-14 rounded-lg" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-7 w-24" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </main>
  );
}

export function SessionDetail({ session, onRefresh }: { session: string; onRefresh: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [responses, setResponses] = useState<ResponseItem[]>([]);
  const [stopping, setStopping] = useState(false);
  const [tab, setTab] = useState<Tab>("terminal");
  const toast = useToast();

  const fetchAll = useCallback(async () => {
    try {
      const [s, q, r] = await Promise.all([
        getStatus(session),
        getQueue(session),
        getResponses(session),
      ]);
      setStatus(s);
      setQueue(q.items || []);
      setResponses(r.items || []);
    } catch (e) {
      if (e instanceof AuthError) throw e;
    }
  }, [session]);

  usePolling(fetchAll, 3000, [session]);

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopSession(session);
      toast("Session stopped", "success");
      onRefresh();
    } catch {
      toast("Failed to stop session", "error");
    }
    setStopping(false);
  };

  const handleClearQueue = async () => {
    await clearQueue(session);
    toast("Queue cleared", "success");
    fetchAll();
  };

  const handleCancelQueueItem = async (id: string) => {
    await cancelQueueItem(session, id);
    toast("Removed from queue", "success");
    fetchAll();
  };

  const handleClearResponses = async () => {
    await clearResponses(session);
    toast("Responses cleared", "success");
    fetchAll();
  };

  const handleInterrupt = async () => {
    const res = await interruptSession(session);
    if (res.status === 200) toast("Interrupt sent", "success");
    else toast(res.data?.error || "Interrupt failed", "error");
    fetchAll();
  };

  if (!status) return <DetailSkeleton />;

  return (
    <main className="flex-1 overflow-y-auto p-4 space-y-5">
      {/* Status header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-base font-semibold">{session}</h2>
            <Badge variant={status.status} />
          </div>
          <p className="text-xs text-gray-500">Since {timeAgo(status.since)}</p>
        </div>
        {status.status !== "offline" && (
          <button
            onClick={handleStop}
            disabled={stopping}
            className="text-xs text-red-400 hover:text-red-300 border border-red-400/30 hover:border-red-400/50 rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            {stopping ? "Stopping..." : "Stop Session"}
          </button>
        )}
      </div>

      {/* Waiting / wedged banner */}
      {status.waiting && (
        <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 animate-[fadeIn_200ms_ease-out]">
          <span className="text-amber-400 text-sm shrink-0">⏳ Needs input</span>
          <span className="text-xs text-amber-200/80 truncate flex-1" title={status.waitingMessage}>
            {status.waitingMessage || "Claude is blocked waiting for input"}
          </span>
          <button
            onClick={handleInterrupt}
            className="text-xs text-amber-300 hover:text-amber-200 border border-amber-400/40 hover:border-amber-400/60 rounded px-2 py-1 transition-colors shrink-0"
          >
            Interrupt
          </button>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Queue" value={queue.length} />
        <StatCard label="Responses" value={responses.length} />
        <StatCard label="Uptime" value={timeAgo(status.since).replace(" ago", "")} />
      </div>

      {/* Current prompt */}
      {status.status === "busy" && status.currentPrompt && (
        <div className="animate-[fadeIn_200ms_ease-out]">
          <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Current prompt</span>
          <pre className="text-sm text-blue-300 bg-blue-950/30 border border-blue-900/30 rounded p-3 mt-1 whitespace-pre-wrap break-words overflow-x-auto">
            {status.currentPrompt}
          </pre>
          {status.currentTaskId && (
            <p className="text-xs text-gray-600 font-mono mt-1">{status.currentTaskId}</p>
          )}
        </div>
      )}

      {/* Tabs */}
      <div>
        <div className="flex items-center gap-1 border-b border-gray-800">
          {status.status !== "offline" && (
            <TabButton active={tab === "terminal"} label="Terminal" onClick={() => setTab("terminal")} />
          )}
          <TabButton active={tab === "queue"} label="Queue" count={queue.length} onClick={() => setTab("queue")} />
          <TabButton active={tab === "responses"} label="Responses" count={responses.length} onClick={() => setTab("responses")} />
          <TabButton active={tab === "history"} label="History" onClick={() => setTab("history")} />
          {tab === "queue" && queue.length > 0 && (
            <button onClick={handleClearQueue} className="ml-auto text-xs text-red-400/70 hover:text-red-300 border border-red-400/20 hover:border-red-400/40 rounded px-2 py-0.5 transition-colors">
              Clear Queue
            </button>
          )}
          {tab === "responses" && responses.length > 0 && (
            <button onClick={handleClearResponses} className="ml-auto text-xs text-red-400/70 hover:text-red-300 border border-red-400/20 hover:border-red-400/40 rounded px-2 py-0.5 transition-colors">
              Clear Responses
            </button>
          )}
        </div>

        <div className="mt-2 animate-[fadeIn_150ms_ease-out]">
          {tab === "terminal" && status.status !== "offline" && (
            <TerminalView session={session} />
          )}

          {tab === "queue" && (
            queue.length === 0 ? (
              <EmptyState icon={<InboxIcon size={20} />} title="Queue empty" description="Prompts will queue here when the session is busy" />
            ) : (
              <Card>
                {queue.map((item) => (
                  <ExpandableQueueItem key={item.id} item={item} onCancel={handleCancelQueueItem} />
                ))}
              </Card>
            )
          )}

          {tab === "responses" && (
            responses.length === 0 ? (
              <EmptyState icon={<MessageIcon size={20} />} title="No responses yet" description="Completed prompts will appear here" />
            ) : (
              <Card>
                {[...responses]
                  .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
                  .slice(0, 20)
                  .map((r) => (
                  <ExpandableResponse key={r.id} session={session} id={r.id} completedAt={r.completed_at} />
                ))}
              </Card>
            )
          )}

          {tab === "history" && <HistoryView session={session} />}
        </div>
      </div>

      {/* Trigger */}
      {status.status !== "offline" && <TriggerForm session={session} />}
    </main>
  );
}
