import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

type TerminalScope = {
  cwd: string;
  username?: string;
  domain?: string;
};

type AccountTerminalDomain = {
  name: string;
  documentRoot: string | null;
  status: string;
  subdomains: Array<{ name: string }>;
};

function insideRoot(target: string, root: string) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureLinkOrDirectory(linkPath: string, targetPath: string) {
  await fs.mkdir(targetPath, { recursive: true });
  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const current = await fs.readlink(linkPath);
      if (path.resolve(path.dirname(linkPath), current) === targetPath) return;
      await fs.unlink(linkPath);
    } else {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.symlink(targetPath, linkPath, "dir");
  } catch {
    await fs.mkdir(linkPath, { recursive: true });
  }
}

function accountHomePath(root: string, username: string, storedHomeRoot: string) {
  const stored = path.resolve(storedHomeRoot);
  if (insideRoot(stored, root) && stored !== root) return stored;
  return path.resolve(root, "accounts", username);
}

function accountDocumentPath(root: string, homeRoot: string, documentRoot: string | null | undefined) {
  const value = (documentRoot ?? "public_html").replace(/^\/+/, "");
  if (path.isAbsolute(documentRoot ?? "")) return path.resolve(documentRoot ?? "");
  if (value === "." || value.startsWith("accounts/")) return path.resolve(root, value);
  return path.resolve(homeRoot, value);
}

function subdomainFolderName(subdomain: string) {
  return subdomain.trim().toLowerCase() === "*" ? "_wildcard" : subdomain.trim().toLowerCase();
}

async function scaffoldAccountTerminalHome(root: string, homeRoot: string, domains: AccountTerminalDomain[]) {
  await fs.mkdir(homeRoot, { recursive: true });
  await fs.mkdir(path.join(homeRoot, "public_html"), { recursive: true });
  await fs.mkdir(path.join(homeRoot, "subdomains"), { recursive: true });

  for (const domain of domains) {
    const domainTarget = accountDocumentPath(root, homeRoot, domain.documentRoot);
    if (!insideRoot(domainTarget, root)) continue;
    await ensureLinkOrDirectory(path.join(homeRoot, domain.name), domainTarget);
    for (const subdomain of domain.subdomains) {
      const folderName = subdomainFolderName(subdomain.name);
      const fqdn = `${subdomain.name}.${domain.name}`;
      const subdomainTarget = path.join(homeRoot, "subdomains", folderName);
      await ensureLinkOrDirectory(path.join(homeRoot, fqdn), subdomainTarget);
    }
  }
}

async function terminalCwd(accountId?: string) {
  if (!accountId) return { cwd: os.homedir() };
  const account = await prisma.account.findFirstOrThrow({
    where: { OR: [{ id: accountId }, { username: accountId }] },
    select: {
      homeRoot: true,
      username: true,
      domains: {
        orderBy: [{ status: "asc" }, { createdAt: "asc" }],
        take: 20,
        select: {
          name: true,
          documentRoot: true,
          status: true,
          subdomains: { select: { name: true } }
        }
      }
    }
  });
  const root = path.resolve(env.FILE_MANAGER_ROOT);
  const homeRoot = accountHomePath(root, account.username, account.homeRoot);
  if (!insideRoot(homeRoot, root)) {
    throw Object.assign(new Error(`Account ${account.username} home root is outside the file manager root.`), { statusCode: 400 });
  }
  const primaryDomain = account.domains.find((domain) => domain.status === "ACTIVE") ?? account.domains[0];
  await scaffoldAccountTerminalHome(root, homeRoot, account.domains);
  const cwd = homeRoot;
  if (!(await pathExists(homeRoot))) await fs.mkdir(homeRoot, { recursive: true });
  return { cwd, username: account.username, domain: primaryDomain?.name };
}

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  function openTerminal(socket: WebSocket, scope: TerminalScope) {
    const shell = process.env.SHELL ?? (os.platform() === "win32" ? "cmd.exe" : "/bin/bash");

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: scope.cwd,
      env: {
        ...(process.env as Record<string, string>),
        HOME: scope.cwd,
        PWD: scope.cwd,
        USER: scope.username ?? process.env.USER ?? "panel",
        LOGNAME: scope.username ?? process.env.LOGNAME ?? "panel",
        PS1: scope.domain ? `[${scope.username ?? "account"}@${scope.domain} \\W]$ ` : "\\u@\\h:\\w\\$ "
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
  }

  app.get("/ws", { websocket: true, preHandler: app.requireAuth }, async (socket: WebSocket, request: any) => {
    const query = request.query as { accountId?: string };
    let scope: TerminalScope;
    try {
      scope = await terminalCwd(query.accountId);
    } catch (error) {
      if (socket.readyState === 1) socket.send(`\r\nTerminal unavailable: ${error instanceof Error ? error.message : "Could not open account home."}\r\n`);
      try { socket.close(); } catch { /* already closed */ }
      return;
    }

    openTerminal(socket, scope);
  });

  app.get("/account/ws", { websocket: true, preHandler: app.requireAccount }, async (socket: WebSocket, request: any) => {
    try {
      const scope = await terminalCwd(request.user.accountId);
      openTerminal(socket, scope);
    } catch (error) {
      if (socket.readyState === 1) socket.send(`\r\nTerminal unavailable: ${error instanceof Error ? error.message : "Could not open account home."}\r\n`);
      try { socket.close(); } catch { /* already closed */ }
    }
  });
};
