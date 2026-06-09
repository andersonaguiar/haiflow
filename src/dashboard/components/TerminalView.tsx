import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getApiKey } from "../api";

export function TerminalView({ session, className }: { session: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [control, setControl] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#030712",
        foreground: "#d1d5db",
        cursor: "#d1d5db",
        selectionBackground: "#374151",
      },
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      cursorBlink: control,
      disableStdin: !control,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    term.write("\x1b[90mConnecting...\x1b[0m\r\n");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const key = encodeURIComponent(getApiKey() ?? "");
    const mode = control ? "&mode=control" : "";
    const ws = new WebSocket(
      `${protocol}//${location.host}/terminal?session=${encodeURIComponent(session)}&key=${key}${mode}`
    );
    ws.binaryType = "arraybuffer";

    ws.onopen = () => { term.clear(); };
    ws.onmessage = (e) => { term.write(new Uint8Array(e.data)); };
    ws.onclose = () => { term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n"); };
    ws.onerror = () => { term.write("\r\n\x1b[31m[connection error]\x1b[0m\r\n"); };

    // Forward keystrokes only when the human has taken the wheel.
    const dataDisposable = control
      ? term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); })
      : null;

    const onResize = () => fitAddon.fit();
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      dataDisposable?.dispose();
      ws.close();
      term.dispose();
    };
  }, [session, control]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className={`text-[11px] ${control ? "text-amber-400" : "text-gray-600"}`}>
          {control ? "⌨ You are typing into the live session" : "Read-only view"}
        </span>
        <button
          onClick={() => setControl((v) => !v)}
          className={`text-xs rounded px-2 py-0.5 border transition-colors ${
            control
              ? "text-amber-300 border-amber-400/50 hover:border-amber-400"
              : "text-gray-400 border-gray-700 hover:text-gray-200 hover:border-gray-500"
          }`}
        >
          {control ? "Release control" : "Take control"}
        </button>
      </div>
      <div
        ref={containerRef}
        className={className ?? `w-full rounded border overflow-hidden h-[420px] ${control ? "border-amber-500/40" : "border-gray-800"}`}
      />
    </div>
  );
}
