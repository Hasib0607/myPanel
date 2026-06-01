import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../config/env.js";

const execFileAsync = promisify(execFile);
const panelUpdateService = "vps-panel-self-update";

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

  try {
    await execFileAsync("sudo", ["-n", "systemctl", "start", panelUpdateService], {
      cwd: appDir,
      timeout: 5000,
      env: {
        ...process.env,
        PANEL_UPDATE_WORKDIR: appDir,
        PANEL_UPDATE_BRANCH: env.PANEL_UPDATE_BRANCH
      }
    });
    await writePanelUpdateStatus({
      state: "running",
      message: `panel update service ${panelUpdateService} started`
    });
    return { accepted: true, queued: true, service: panelUpdateService, pid: null, script };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start panel self-update service";
    await writePanelUpdateStatus({
      state: "failed",
      message: `panel update service ${panelUpdateService} failed to start: ${message}`
    });
    throw new Error(`Could not start ${panelUpdateService}. Run the installer to write the service and sudoers policy.`);
  }
}
