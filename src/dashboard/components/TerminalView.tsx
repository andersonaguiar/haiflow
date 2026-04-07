import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getApiKey } from "../api";

export function TerminalView({ session, className }: { session: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

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
      cursorBlink: false,
      disableStdin: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    term.write("\x1b[90mConnecting...\x1b[0m\r\n");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const key = encodeURIComponent(getApiKey() ?? "");
    const ws = new WebSocket(
      `${protocol}//${location.host}/terminal?session=${encodeURIComponent(session)}&key=${key}`
    );
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term.clear();
    };

    ws.onmessage = (e) => {
      term.write(new Uint8Array(e.data));
    };

    ws.onclose = () => {
      term.write("\r\n\x1b[90m[disconnected]\x1b[0m\r\n");
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m[connection error]\x1b[0m\r\n");
    };

    const onResize = () => fitAddon.fit();
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  }, [session]);

  return (
    <div
      ref={containerRef}
      className={className ?? "w-full rounded border border-gray-800 overflow-hidden h-[420px]"}
    />
  );
}
