import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

async function terminalCwd(accountId?: string) {
  if (!accountId) return os.homedir();
  const account = await prisma.account.findFirstOrThrow({
    where: { OR: [{ id: accountId }, { username: accountId }] },
    select: { homeRoot: true, username: true }
  });
  const root = path.resolve(env.FILE_MANAGER_ROOT);
  const homeRoot = path.resolve(account.homeRoot);
  if (homeRoot !== root && !homeRoot.startsWith(`${root}${path.sep}`)) {
    throw Object.assign(new Error(`Account ${account.username} home root is outside the file manager root.`), { statusCode: 400 });
  }
  await fs.mkdir(homeRoot, { recursive: true });
  return homeRoot;
}

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws", { websocket: true, preHandler: app.requireAuth }, async (socket: WebSocket, request: any) => {
    const query = request.query as { accountId?: string };
    const shell = process.env.SHELL ?? (os.platform() === "win32" ? "cmd.exe" : "/bin/bash");
    let cwd: string;
    try {
      cwd = await terminalCwd(query.accountId);
    } catch (error) {
      if (socket.readyState === 1) socket.send(`\r\nTerminal unavailable: ${error instanceof Error ? error.message : "Could not open account home."}\r\n`);
      try { socket.close(); } catch { /* already closed */ }
      return;
    }

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...(process.env as Record<string, string>),
        HOME: cwd,
        PWD: cwd
      }
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
