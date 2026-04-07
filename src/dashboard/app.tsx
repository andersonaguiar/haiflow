import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { getSessions, getApiKey, setApiKey, clearApiKey, AuthError } from "./api";
import { SessionList } from "./components/SessionList";
import { SessionDetail } from "./components/SessionDetail";
import { TerminalWall } from "./components/TerminalWall";

interface Session {
  session: string;
  status: "idle" | "busy" | "offline";
  tmux: string;
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
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:border-gray-500"
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

function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [authed, setAuthed] = useState(!!getApiKey());
  const [view, setView] = useState<"dashboard" | "wall">(() =>
    location.hash === "#wall" ? "wall" : "dashboard"
  );

  useEffect(() => {
    const onHash = () => setView(location.hash === "#wall" ? "wall" : "dashboard");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await getSessions();
      setSessions(data);
    } catch (e) {
      if (e instanceof AuthError) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    fetchSessions();
    const id = setInterval(fetchSessions, 3000);
    return () => clearInterval(id);
  }, [authed, fetchSessions]);

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  if (view === "wall") {
    return <TerminalWall onBack={() => { location.hash = ""; setView("dashboard"); }} />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h1 className="text-lg font-semibold tracking-tight">haiflow</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => { location.hash = "#wall"; setView("wall"); }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Terminal Wall
          </button>
          <button
            onClick={() => { clearApiKey(); setAuthed(false); }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Logout
          </button>
        </div>
      </header>
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
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a session
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Dashboard />);
