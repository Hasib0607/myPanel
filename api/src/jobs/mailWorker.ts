import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

export const mailWorker = new Worker(
  "mail",
  async (job) => {
    if (job.name === "send") {
      const payload = job.data as { from: string; to: string; subject: string; html: string; text?: string };
      logger.info("mail send job accepted in dry-run mode", {
        id: job.id,
        from: payload.from,
        to: payload.to,
        subject: payload.subject
      });

      return {
        dryRun: true,
        accepted: true,
        transport: "postfix-submission-pending"
      };
    }

    logger.info("mail job received", { id: job.id, name: job.name });
    return { queued: true };
  },
  { connection: redis }
);
