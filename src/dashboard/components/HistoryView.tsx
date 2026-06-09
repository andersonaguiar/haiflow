import React, { useState, useCallback } from "react";
import { getTasks, getUsageWindow, AuthError } from "../api";
import { Card, EmptyState, InboxIcon } from "./ui";
import { usePolling } from "../hooks";
import { timeAgo } from "../utils";
import type { TaskRow, TaskStep, UsageWindow } from "../types";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtUsd(n: number | null): string {
  if (!n) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const STATUS_COLOR: Record<string, string> = {
  running: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  completed: "text-green-400 bg-green-500/10 border-green-500/30",
  timed_out: "text-amber-400 bg-amber-500/10 border-amber-500/30",
  cancelled: "text-gray-400 bg-gray-500/10 border-gray-500/30",
  failed: "text-red-400 bg-red-500/10 border-red-500/30",
};

function StepRow({ step }: { step: TaskStep }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!step.detail;
  return (
    <div className="border-l-2 pl-2 ml-1 my-1" style={{ borderColor: step.isError ? "rgb(248 113 113 / 0.5)" : "rgb(55 65 81)" }}>
      <button
        onClick={() => hasDetail && setOpen(!open)}
        className={`w-full text-left flex items-center gap-2 text-xs ${hasDetail ? "hover:text-gray-200 cursor-pointer" : "cursor-default"}`}
      >
        <span className={`font-mono px-1.5 py-0.5 rounded text-[10px] ${step.isError ? "bg-red-500/20 text-red-300" : "bg-gray-800 text-gray-400"}`}>
          {step.tool}
        </span>
        <span className="text-gray-400 truncate flex-1">{step.summary}</span>
        {step.isError && <span className="text-red-400 text-[10px] shrink-0">error</span>}
        {hasDetail && <span className="text-gray-600 shrink-0">{open ? "−" : "+"}</span>}
      </button>
      {open && step.detail && (
        <pre className="text-[11px] text-gray-400 bg-gray-900 border border-gray-800 rounded p-2 mt-1 whitespace-pre-wrap break-words overflow-x-auto max-h-64">
          {step.detail}
        </pre>
      )}
    </div>
  );
}

function TaskCard({ session, task }: { session: string; task: TaskRow }) {
  const [open, setOpen] = useState(false);
  const tokens = task.usage?.totalTokens ?? 0;
  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <button onClick={() => setOpen(!open)} className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-800/50 transition-colors text-sm">
        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${STATUS_COLOR[task.status] ?? STATUS_COLOR.completed}`}>{task.status}</span>
        <span className="text-gray-400 font-mono text-xs truncate flex-1">{task.id}</span>
        <span className="text-xs text-gray-600 shrink-0">{task.steps.length} steps</span>
        <span className="text-xs text-gray-600 shrink-0">{fmtTokens(tokens)} tok</span>
        <span className="text-xs text-green-500/70 shrink-0" title="Equivalent API cost avoided">{fmtUsd(task.saved_usd)}</span>
        <span className="text-xs text-gray-600 shrink-0">{fmtDuration(task.duration_ms)}</span>
        <span className="text-xs text-gray-600 shrink-0">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 animate-[fadeIn_150ms_ease-out]">
          {task.prompt && (
            <pre className="text-xs text-blue-300 bg-blue-950/30 border border-blue-900/30 rounded p-2 whitespace-pre-wrap break-words overflow-x-auto max-h-32">{task.prompt}</pre>
          )}
          {task.files_changed.length > 0 && (
            <p className="text-[11px] text-gray-500">Files: <span className="text-gray-300 font-mono">{task.files_changed.join(", ")}</span></p>
          )}
          {task.steps.length === 0 ? (
            <p className="text-xs text-gray-600">No tool calls recorded.</p>
          ) : (
            <div>{task.steps.map((s) => <StepRow key={s.seq} step={s} />)}</div>
          )}
          {task.model && <p className="text-[10px] text-gray-600 font-mono">{task.model}</p>}
        </div>
      )}
    </div>
  );
}

export function HistoryView({ session }: { session: string }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [usage, setUsage] = useState<UsageWindow | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [t, u] = await Promise.all([getTasks(session), getUsageWindow(session)]);
      setTasks(t.tasks || []);
      setUsage(u);
    } catch (e) {
      if (e instanceof AuthError) throw e;
    }
  }, [session]);

  usePolling(fetchAll, 4000, [session]);

  return (
    <div className="space-y-3">
      {usage && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <p className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Last 5h</p>
            <p className="text-sm text-gray-200">{fmtTokens(usage.windows["5h"].totalTokens)} tokens · {usage.windows["5h"].tasks} tasks</p>
            <p className="text-xs text-green-500/80">{fmtUsd(usage.windows["5h"].savedUsd)} API cost avoided</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <p className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Last 7d</p>
            <p className="text-sm text-gray-200">{fmtTokens(usage.windows["7d"].totalTokens)} tokens · {usage.windows["7d"].tasks} tasks</p>
            <p className="text-xs text-green-500/80">{fmtUsd(usage.windows["7d"].savedUsd)} API cost avoided</p>
          </div>
        </div>
      )}
      {usage?.alert && (
        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded p-2">
          Heads up: 5h token usage crossed your HAIFLOW_USAGE_ALERT_TOKENS threshold.
        </div>
      )}
      {tasks.length === 0 ? (
        <EmptyState icon={<InboxIcon size={20} />} title="No task history yet" description="Completed tasks with their tool/command/diff timeline appear here" />
      ) : (
        <Card>
          {tasks.map((t) => <TaskCard key={t.id} session={session} task={t} />)}
        </Card>
      )}
    </div>
  );
}
