import { logger } from "./lib/logger.js";
import { sysagent } from "./lib/sysagent.js";

const intervalMs = Number(process.env.GUARDIAN_INTERVAL_MS ?? 60_000);

async function runDiagnosis() {
  try {
    const diagnosis = await sysagent.guardianDiagnosis() as { incidents?: unknown[]; generatedAt?: string };
    logger.info("guardian diagnosis completed", {
      generatedAt: diagnosis.generatedAt,
      incidents: diagnosis.incidents?.length ?? 0
    });
  } catch (error) {
    logger.warn("guardian diagnosis failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

await runDiagnosis();
setInterval(runDiagnosis, intervalMs);
