"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiBase } from "@/lib/api";

function wsUrl(): string {
  const base = apiBase.startsWith("/")
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${apiBase}`
    : apiBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${base}/terminal/ws`;
}

export function TerminalClient() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "Menlo, 'DejaVu Sans Mono', Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: "#0f172a",
        foreground: "#e2e8f0",
        cursor: "#94a3b8",
        black: "#1e293b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#34d399",
        white: "#e2e8f0",
        brightBlack: "#475569",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#6ee7b7",
        brightWhite: "#f8fafc"
      }
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    const sendResize = (ws: WebSocket) => {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    const ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      fitAddon.fit();
      sendResize(ws);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        term.write(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[2mConnection closed. Refresh to reconnect.\x1b[0m");
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31mWebSocket connection failed.\x1b[0m");
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (ws.readyState === WebSocket.OPEN) sendResize(ws);
      else fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
