import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { env } from "../config/env.js";
import { startPanelSelfUpdate } from "./panelSelfUpdate.js";

function execGit(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: env.PANEL_UPDATE_WORKDIR,
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0"
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

async function panelUpdateIsRunning() {
  const status = await fs.readFile(env.PANEL_UPDATE_STATUS_FILE, "utf8")
    .then((content) => JSON.parse(content) as { state?: string; updatedAt?: string })
    .catch(() => null);
  if (!status || (status.state !== "running" && status.state !== "queued")) return false;
  const updatedAt = status.updatedAt ? new Date(status.updatedAt).getTime() : 0;
  if (!updatedAt) return true;
  return Date.now() - updatedAt < env.PANEL_UPDATE_STALE_AFTER_SECONDS * 1000;
}

export async function checkPanelRemoteUpdate() {
  if (!env.PANEL_UPDATE_POLL_ENABLED) {
    return { checked: false, reason: "panel update polling disabled" };
  }
  if (await panelUpdateIsRunning()) {
    return { checked: true, queued: false, reason: "panel update already running" };
  }

  const branchRef = `refs/heads/${env.PANEL_UPDATE_BRANCH}`;
  const localHead = await execGit(["rev-parse", "HEAD"]);
  const remoteRaw = await execGit(["ls-remote", env.PANEL_UPDATE_POLL_REMOTE, branchRef]);
  const remoteHead = remoteRaw.split(/\s+/)[0] ?? "";
  if (!remoteHead) {
    return { checked: true, queued: false, reason: `remote branch ${branchRef} not found` };
  }
  if (localHead === remoteHead) {
    return { checked: true, queued: false, localHead, remoteHead, upToDate: true };
  }

  const result = await startPanelSelfUpdate(`Guardian detected remote ${env.PANEL_UPDATE_BRANCH} update`);
  return {
    checked: true,
    queued: true,
    localHead: localHead.slice(0, 12),
    remoteHead: remoteHead.slice(0, 12),
    pid: result.pid
  };
}
