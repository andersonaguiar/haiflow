import React, { useState } from "react";
import { startSession } from "../api";
import { useToast } from "./ui";

export function StartSession({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd.trim()) { setError("cwd is required"); return; }
    setLoading(true);
    setError("");
    try {
      const { status, data } = await startSession(name.trim() || "default", cwd.trim());
      if (status >= 400) {
        setError(data.error || "Failed to start");
      } else {
        toast("Session started", "success");
        onDone();
      }
    } catch {
      setError("Request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-1.5">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Session name (default)"
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-gray-500 transition-colors"
      />
      <input
        type="text"
        value={cwd}
        onChange={(e) => { setCwd(e.target.value); setError(""); }}
        placeholder="Working directory (required)"
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-gray-500 transition-colors"
        autoFocus
      />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex gap-1">
        <button
          type="submit"
          disabled={loading}
          className="flex-1 bg-gray-700 hover:bg-gray-600 rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50"
        >
          {loading ? "Starting..." : "Start"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
