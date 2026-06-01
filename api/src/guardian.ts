import { logger } from "./lib/logger.js";
import { guardianQueue } from "./jobs/queues.js";

const intervalMs = Number(process.env.GUARDIAN_INTERVAL_MS ?? 60_000);
const deploymentDoctorIntervalMs = Number(process.env.GUARDIAN_DEPLOYMENT_DOCTOR_INTERVAL_MS ?? 5 * 60_000);
const panelUpdatePollIntervalMs = Number(process.env.PANEL_UPDATE_POLL_INTERVAL_MS ?? 60_000);
const autoHealEnabled = process.env.GUARDIAN_AUTO_HEAL === "true";
const panelUpdatePollEnabled = process.env.PANEL_UPDATE_POLL_ENABLED !== "false";

async function scheduleGuardian() {
  try {
    const name = autoHealEnabled ? "auto-heal" : "diagnose";
    await guardianQueue.add(name, {}, {
      jobId: `guardian-${name}`,
      repeat: { every: intervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    await guardianQueue.add("deployment-watch", {}, {
      jobId: "guardian-deployment-watch",
      repeat: { every: deploymentDoctorIntervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    if (panelUpdatePollEnabled) {
      await guardianQueue.add("panel-update-watch", {}, {
        jobId: "guardian-panel-update-watch",
        repeat: { every: panelUpdatePollIntervalMs },
        removeOnComplete: 100,
        removeOnFail: 100
      });
    }
    logger.info("guardian repeat job scheduled", {
      name,
      autoHealEnabled,
      intervalMs,
      deploymentDoctorIntervalMs,
      panelUpdatePollEnabled,
      panelUpdatePollIntervalMs
    });
  } catch (error) {
    logger.warn("guardian repeat schedule failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

await scheduleGuardian();
