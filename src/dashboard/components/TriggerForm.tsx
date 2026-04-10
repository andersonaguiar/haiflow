import React, { useState, useRef, useEffect } from "react";
import { trigger } from "../api";
import { useToast } from "./ui";

export function TriggerForm({ session }: { session: string }) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [prompt]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || loading) return;
    setLoading(true);
    try {
      const data = await trigger(session, prompt.trim());
      setPrompt("");
      if (data.queued) {
        toast(`Prompt queued (#${data.position})`, "info");
      } else {
        toast("Prompt sent", "success");
      }
    } catch {
      toast("Failed to send prompt", "error");
    }
    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Send Prompt</h3>
      <form onSubmit={handleSubmit} className="space-y-2">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter a prompt..."
          rows={1}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-gray-500 resize-none overflow-hidden transition-colors"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-600">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to send
          </span>
          <button
            type="submit"
            disabled={loading || !prompt.trim()}
            className="bg-gray-700 hover:bg-gray-600 rounded px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 shrink-0"
          >
            {loading ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
