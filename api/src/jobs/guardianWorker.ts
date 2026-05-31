import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { runGuardianAutoHeal, syncGuardianIncidentsOnly, type GuardianDiagnosis } from "../lib/guardianAutoHeal.js";
import { sysagent } from "../lib/sysagent.js";

export const guardianWorker = new Worker(
  "guardian",
  async (job) => {
    logger.info("guardian job received", { id: job.id, name: job.name });
    const diagnosis = await sysagent.guardianDiagnosis() as GuardianDiagnosis;
    if (diagnosis.unavailable) throw new Error("Guardian diagnosis is unavailable");

    if (job.name === "diagnose") {
      await syncGuardianIncidentsOnly(diagnosis);
      return { incidents: diagnosis.incidents?.length ?? 0 };
    }

    if (job.name === "auto-heal") {
      return runGuardianAutoHeal(diagnosis);
    }

    throw new Error(`Unknown guardian job: ${job.name}`);
  },
  { connection: redis }
);
