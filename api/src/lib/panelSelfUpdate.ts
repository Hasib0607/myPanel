import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

function configuredPanelUpdateScript() {
  const appDir = path.resolve(env.PANEL_UPDATE_WORKDIR);
  const script = path.resolve(env.PANEL_UPDATE_SCRIPT ?? path.join(appDir, "scripts/deploy/update-panel.sh"));
  const relative = path.relative(appDir, script);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Panel update script must live inside PANEL_UPDATE_WORKDIR");
  }
  return { appDir, script };
}

async function writePanelUpdateStatus(status: Record<string, unknown>) {
  await fs.mkdir(path.dirname(env.PANEL_UPDATE_STATUS_FILE), { recursive: true });
  await fs.writeFile(env.PANEL_UPDATE_STATUS_FILE, `${JSON.stringify({
    branch: env.PANEL_UPDATE_BRANCH,
    logFile: env.PANEL_UPDATE_LOG_FILE,
    updatedAt: new Date().toISOString(),
    ...status
  })}\n`);
}

export async function startPanelSelfUpdate(source: string) {
  const { appDir, script } = configuredPanelUpdateScript();
  await fs.access(script);
  await writePanelUpdateStatus({
    state: "queued",
    message: `${source}; starting panel update`
  });
  const child = spawn("bash", [script], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PANEL_UPDATE_WORKDIR: appDir,
      PANEL_UPDATE_BRANCH: env.PANEL_UPDATE_BRANCH
    }
  });
  child.unref();
  await writePanelUpdateStatus({
    state: "running",
    message: `panel update process started with pid ${child.pid ?? "unknown"}`,
    pid: child.pid ?? null
  });
  return { accepted: true, queued: true, pid: child.pid ?? null, script };
}
