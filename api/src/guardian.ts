import { logger } from "./lib/logger.js";
import { guardianQueue } from "./jobs/queues.js";

const intervalMs = Number(process.env.GUARDIAN_INTERVAL_MS ?? 60_000);
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
    logger.info("guardian repeat job scheduled", {
      name,
      autoHealEnabled,
      intervalMs
    });
  } catch (error) {
    logger.warn("guardian repeat schedule failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

await scheduleGuardian();
