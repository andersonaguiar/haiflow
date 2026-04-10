import React, { useState, useCallback } from "react";
import { getSessions, AuthError } from "../api";
import { TerminalView } from "./TerminalView";
import { StatusDot, EmptyState, TerminalIcon } from "./ui";
import { usePolling } from "../hooks";
import type { Session } from "../types";

export function TerminalWall({ onBack }: { onBack: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await getSessions();
      setSessions(data.filter((s: Session) => s.status !== "offline"));
    } catch (e) {
      if (e instanceof AuthError) onBack();
    }
  }, [onBack]);

  usePolling(fetchSessions, 10_000);

  const count = sessions.length;

  const gridCols =
    count <= 1 ? "grid-cols-1" :
    count <= 2 ? "grid-cols-2" :
    count <= 4 ? "grid-cols-2" :
    count <= 6 ? "grid-cols-3" :
    "grid-cols-4";

  return (
    <div className="h-screen flex flex-col bg-gray-950">
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            &larr; Dashboard
          </button>
          <h1 className="text-sm font-semibold tracking-tight text-gray-400">Terminal Wall</h1>
        </div>
        <span className="text-xs text-gray-600">{count} active</span>
      </header>

      {count === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<TerminalIcon size={24} />}
            title="No active sessions"
            description="Start a session from the dashboard to see terminals here"
          />
        </div>
      ) : (
        <div className={`flex-1 grid ${gridCols} gap-px bg-gray-800 overflow-hidden`}>
          {sessions.map((s) => (
            <div key={s.session} className="flex flex-col bg-gray-950 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 shrink-0">
                <StatusDot status={s.status} />
                <span className="text-xs font-medium text-gray-300 truncate">{s.session}</span>
                <span className="text-[10px] text-gray-600">{s.status}</span>
              </div>
              <div className="flex-1 min-h-0">
                <TerminalView
                  session={s.session}
                  className="w-full h-full overflow-hidden"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
