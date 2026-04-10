import React, { useState, useMemo } from "react";
import { removeSession } from "../api";
import { StartSession } from "./StartSession";
import { StatusDot, EmptyState, SearchIcon, Badge, InboxIcon } from "./ui";
import type { Session, SessionStatus } from "../types";

const statusOrder: SessionStatus[] = ["busy", "idle", "offline"];

export function SessionList({
  sessions,
  selected,
  onSelect,
  onRefresh,
}: {
  sessions: Session[];
  selected: string | null;
  onSelect: (s: string | null) => void;
  onRefresh: () => void;
}) {
  const [showStart, setShowStart] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SessionStatus | null>(null);

  const counts = useMemo(() => {
    const c = { idle: 0, busy: 0, offline: 0 };
    for (const s of sessions) c[s.status]++;
    return c;
  }, [sessions]);

  const filtered = useMemo(() => {
    let list = sessions;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s) => s.session.toLowerCase().includes(q));
    }
    if (statusFilter) {
      list = list.filter((s) => s.status === statusFilter);
    }
    return list.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
  }, [sessions, search, statusFilter]);

  return (
    <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-gray-800 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-gray-800">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
          Sessions
          <span className="ml-1.5 text-gray-600 normal-case">({sessions.length})</span>
        </div>

        {/* Search */}
        <div className="relative mb-2">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600">
            <SearchIcon size={12} />
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter sessions..."
            className="w-full bg-gray-800/50 border border-gray-700/50 rounded pl-6 pr-2 py-1 text-xs focus:outline-none focus:border-gray-600 placeholder:text-gray-600 transition-colors"
          />
        </div>

        {/* Status filter */}
        <div className="flex gap-1.5">
          {statusOrder.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-all ${
                statusFilter === s
                  ? s === "busy" ? "border-amber-500/50 bg-amber-500/20 text-amber-400"
                  : s === "idle" ? "border-green-500/50 bg-green-500/20 text-green-400"
                  : "border-gray-500/50 bg-gray-500/20 text-gray-400"
                  : "border-gray-700/50 text-gray-600 hover:text-gray-400"
              }`}
            >
              {counts[s]} {s}
            </button>
          ))}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <EmptyState
            icon={<InboxIcon size={20} />}
            title={search || statusFilter ? "No matching sessions" : "No sessions"}
            description={search || statusFilter ? "Try adjusting your filter" : "Start a new session below"}
          />
        )}
        {filtered.map((s) => (
          <div
            key={s.session}
            className={`flex items-center gap-2 px-3 py-2 hover:bg-gray-900/80 transition-all cursor-pointer border-l-2 ${
              s.session === selected
                ? "bg-gray-900/80 border-blue-500"
                : "border-transparent"
            }`}
          >
            <button
              onClick={() => onSelect(s.session === selected ? null : s.session)}
              className="flex items-center gap-2 text-sm text-left flex-1 min-w-0"
            >
              <StatusDot status={s.status} />
              <span className="truncate flex-1 text-gray-300">{s.session}</span>
              <span className="text-[10px] text-gray-600">{s.status}</span>
            </button>
            {s.status === "offline" && (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  await removeSession(s.session);
                  if (selected === s.session) onSelect(null);
                  onRefresh();
                }}
                className="text-xs text-gray-600 hover:text-red-400 transition-colors shrink-0"
                title="Remove session"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Start session */}
      <div className="p-2 border-t border-gray-800">
        {showStart ? (
          <StartSession
            onDone={() => { setShowStart(false); onRefresh(); }}
            onCancel={() => setShowStart(false)}
          />
        ) : (
          <button
            onClick={() => setShowStart(true)}
            className="w-full text-xs text-gray-400 hover:text-gray-200 bg-gray-900 hover:bg-gray-800 rounded px-2 py-1.5 transition-colors"
          >
            + Start Session
          </button>
        )}
      </div>
    </aside>
  );
}
