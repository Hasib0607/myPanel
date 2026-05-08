import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import os from "node:os";
import * as pty from "node-pty";

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws", { websocket: true, preHandler: app.requireAuth }, (socket: WebSocket, _request) => {
    const shell = process.env.SHELL ?? (os.platform() === "win32" ? "cmd.exe" : "/bin/bash");

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>
    });

    ptyProcess.onData((data) => {
      if (socket.readyState === 1) socket.send(data);
    });

    ptyProcess.onExit(() => {
      try { socket.close(); } catch { /* already closed */ }
    });

    socket.on("message", (raw: Buffer | string) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        const msg = JSON.parse(text) as { type: string; data?: string; cols?: number; rows?: number };
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          ptyProcess.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
        } else if (msg.type === "input" && typeof msg.data === "string") {
          ptyProcess.write(msg.data);
        }
      } catch {
        ptyProcess.write(text);
      }
    });

    socket.on("close", () => {
      try { ptyProcess.kill(); } catch { /* already dead */ }
    });
  });
};
