import React, { useState, useEffect, useCallback } from "react";
import { getStatus, getQueue, getResponses, getResponse, clearQueue, clearResponses, stopSession, AuthError } from "../api";
import { TriggerForm } from "./TriggerForm";
import { TerminalView } from "./TerminalView";

interface Status {
  status: "idle" | "busy" | "offline";
  since: string;
  currentPrompt?: string;
  currentTaskId?: string;
  queueLength: number;
}

interface QueueItem {
  id: string;
  prompt: string;
  addedAt: string;
  source?: string;
}

interface ResponseItem {
  id: string;
  completed_at: string;
}

type Tab = "terminal" | "queue" | "responses";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const statusBadge: Record<string, string> = {
  idle: "bg-green-500/20 text-green-400 border-green-500/30",
  busy: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  offline: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

function ExpandableResponse({ session, id, completedAt }: { session: string; id: string; completedAt: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ prompt?: string; messages?: string[] } | null>(null);

  const load = async () => {
    if (data) { setOpen(!open); return; }
    setOpen(true);
    try {
      const res = await getResponse(session, id);
      setData({ prompt: res.data.prompt, messages: res.data.messages || [] });
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
        <div className="px-3 pb-3 space-y-2">
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

function ExpandableQueueItem({ item }: { item: QueueItem }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <button onClick={() => setOpen(!open)} className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-800/50 transition-colors text-sm">
        <span className="text-gray-400 font-mono text-xs truncate flex-1">{item.id}</span>
        <span className="text-gray-300 truncate max-w-48" title={item.prompt}>{item.prompt}</span>
        <span className="text-xs text-gray-600 shrink-0">{timeAgo(item.addedAt)}</span>
        <span className="text-xs text-gray-600 shrink-0">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3">
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

export function SessionDetail({ session, onRefresh }: { session: string; onRefresh: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [responses, setResponses] = useState<ResponseItem[]>([]);
  const [stopping, setStopping] = useState(false);
  const [tab, setTab] = useState<Tab>("terminal");

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

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 3000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopSession(session);
      onRefresh();
    } catch {}
    setStopping(false);
  };

  const handleClearQueue = async () => {
    await clearQueue(session);
    fetchAll();
  };

  if (!status) {
    return <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">Loading...</div>;
  }

  return (
    <main className="flex-1 overflow-y-auto p-4 space-y-5">
      {/* Status header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-base font-semibold">{session}</h2>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${statusBadge[status.status]}`}>
              {status.status}
            </span>
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

      {/* Current prompt */}
      {status.status === "busy" && status.currentPrompt && (
        <div>
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
          {tab === "queue" && queue.length > 0 && (
            <button onClick={handleClearQueue} className="ml-auto text-xs text-red-400/70 hover:text-red-300 border border-red-400/20 hover:border-red-400/40 rounded px-2 py-0.5 transition-colors">
              Clear Queue
            </button>
          )}
          {tab === "responses" && responses.length > 0 && (
            <button onClick={async () => { await clearResponses(session); fetchAll(); }} className="ml-auto text-xs text-red-400/70 hover:text-red-300 border border-red-400/20 hover:border-red-400/40 rounded px-2 py-0.5 transition-colors">
              Clear Responses
            </button>
          )}
        </div>

        <div className="mt-2">
          {tab === "terminal" && status.status !== "offline" && (
            <TerminalView session={session} />
          )}

          {tab === "queue" && (
            queue.length === 0 ? (
              <p className="text-xs text-gray-600">Empty</p>
            ) : (
              <div className="bg-gray-900 rounded border border-gray-800">
                {queue.map((item) => (
                  <ExpandableQueueItem key={item.id} item={item} />
                ))}
              </div>
            )
          )}

          {tab === "responses" && (
            responses.length === 0 ? (
              <p className="text-xs text-gray-600">None yet</p>
            ) : (
              <div className="bg-gray-900 rounded border border-gray-800">
                {[...responses]
                  .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
                  .slice(0, 20)
                  .map((r) => (
                  <ExpandableResponse key={r.id} session={session} id={r.id} completedAt={r.completed_at} />
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Trigger */}
      {status.status !== "offline" && <TriggerForm session={session} />}
    </main>
  );
}
