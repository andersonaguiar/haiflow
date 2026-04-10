import React, { useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { getSessions, getApiKey, setApiKey, clearApiKey, AuthError } from "./api";
import { SessionList } from "./components/SessionList";
import { SessionDetail } from "./components/SessionDetail";
import { TerminalWall } from "./components/TerminalWall";
import { PipelineView } from "./components/PipelineView";
import { ToastProvider, EmptyState, Kbd, MonitorIcon, NetworkIcon, GridIcon, TerminalIcon } from "./components/ui";
import { useHash, useKeyboard, usePolling } from "./hooks";
import type { Session } from "./types";

type View = "sessions" | "pipeline" | "wall";

function viewFromHash(h: string): View {
  if (h === "pipeline") return "pipeline";
  if (h === "wall") return "wall";
  return "sessions";
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setApiKey(key.trim());
    try {
      await getSessions();
      onLogin();
    } catch {
      clearApiKey();
      setError("Invalid API key");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={handleSubmit} className="bg-gray-900 rounded-lg p-8 w-full max-w-sm border border-gray-800">
        <h1 className="text-xl font-semibold mb-1">haiflow</h1>
        <p className="text-gray-400 text-sm mb-6">Enter your API key to continue</p>
        <input
          type="password"
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(""); }}
          placeholder="HAIFLOW_API_KEY"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-gray-500 transition-colors"
          autoFocus
        />
        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
        <button type="submit" className="w-full bg-gray-700 hover:bg-gray-600 rounded px-3 py-2 text-sm font-medium transition-colors">
          Connect
        </button>
      </form>
    </div>
  );
}

function NavTab({ active, label, icon, count, kbd, onClick }: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  count?: number;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors group ${
        active
          ? "text-gray-200 border-blue-500"
          : "text-gray-500 border-transparent hover:text-gray-300"
      }`}
    >
      <span className="opacity-70">{icon}</span>
      <span>{label}</span>
      {count !== undefined && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
          active ? "bg-blue-500/20 text-blue-400" : "bg-gray-800 text-gray-500"
        }`}>
          {count}
        </span>
      )}
      <span className="hidden group-hover:inline-flex ml-0.5">
        <Kbd>{kbd}</Kbd>
      </span>
    </button>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ["1", "Sessions view"],
    ["2", "Pipeline view"],
    ["3", "Terminal Wall"],
    ["?", "Toggle this help"],
  ];

  return (
    <div className="fixed bottom-4 left-4 z-40 bg-gray-900 border border-gray-700 rounded-lg p-4 shadow-xl animate-[slideIn_200ms_ease-out] w-56">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-300">Keyboard Shortcuts</span>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-400 text-xs">×</button>
      </div>
      <div className="space-y-1.5">
        {shortcuts.map(([key, desc]) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-xs text-gray-400">{desc}</span>
            <Kbd>{key}</Kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

function OnboardingEmptyState() {
  return (
    <EmptyState
      icon={<TerminalIcon size={32} />}
      title="No sessions running"
      description="Start your first session from the sidebar, or via the API"
    >
      <pre className="text-xs text-gray-400 bg-gray-800 border border-gray-700 rounded p-3 mt-2 text-left font-mono">
{`curl -X POST localhost:3333/session/start \\
  -H "Authorization: Bearer \$KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"session":"my-agent","cwd":"/path"}'`}
      </pre>
    </EmptyState>
  );
}

function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [authed, setAuthed] = useState(!!getApiKey());
  const [hash, setHash] = useHash();
  const [showHelp, setShowHelp] = useState(false);

  const view = viewFromHash(hash);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await getSessions();
      setSessions(data);
    } catch (e) {
      if (e instanceof AuthError) setAuthed(false);
    }
  }, []);

  usePolling(fetchSessions, 3000, [authed]);

  useKeyboard({
    "1": () => setHash(""),
    "2": () => setHash("pipeline"),
    "3": () => setHash("wall"),
    "?": () => setShowHelp((v) => !v),
  });

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  if (view === "wall") {
    return <TerminalWall onBack={() => setHash("")} />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 border-b border-gray-800 shrink-0">
        <div className="flex items-center">
          <h1 className="text-lg font-semibold tracking-tight mr-6">haiflow</h1>
          <nav className="flex items-center">
            <NavTab
              active={view === "sessions"}
              label="Sessions"
              icon={<MonitorIcon size={14} />}
              count={sessions.length}
              kbd="1"
              onClick={() => setHash("")}
            />
            <NavTab
              active={view === "pipeline"}
              label="Pipeline"
              icon={<NetworkIcon size={14} />}
              kbd="2"
              onClick={() => setHash("pipeline")}
            />
            <NavTab
              active={hash === "wall"}
              label="Terminal Wall"
              icon={<GridIcon size={14} />}
              kbd="3"
              onClick={() => setHash("wall")}
            />
          </nav>
        </div>
        <button
          onClick={() => { clearApiKey(); setAuthed(false); }}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Logout
        </button>
      </header>

      {view === "pipeline" ? (
        <PipelineView />
      ) : (
        <div className="flex flex-1 flex-col md:flex-row overflow-hidden">
          <SessionList
            sessions={sessions}
            selected={selected}
            onSelect={setSelected}
            onRefresh={fetchSessions}
          />
          {selected ? (
            <SessionDetail session={selected} onRefresh={fetchSessions} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              {sessions.length === 0 ? (
                <OnboardingEmptyState />
              ) : (
                <p className="text-gray-600 text-sm">Select a session</p>
              )}
            </div>
          )}
        </div>
      )}

      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <Dashboard />
  </ToastProvider>
);
