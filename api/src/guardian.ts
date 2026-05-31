import { logger } from "./lib/logger.js";
import { guardianQueue } from "./jobs/queues.js";

const intervalMs = Number(process.env.GUARDIAN_INTERVAL_MS ?? 60_000);
const deploymentDoctorIntervalMs = Number(process.env.GUARDIAN_DEPLOYMENT_DOCTOR_INTERVAL_MS ?? 5 * 60_000);
const autoHealEnabled = process.env.GUARDIAN_AUTO_HEAL === "true";

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
    logger.info("guardian repeat job scheduled", {
      name,
      autoHealEnabled,
      intervalMs,
      deploymentDoctorIntervalMs
    });
  } catch (error) {
    logger.warn("guardian repeat schedule failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

await scheduleGuardian();
