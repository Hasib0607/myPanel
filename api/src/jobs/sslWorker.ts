import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

export const sslWorker = new Worker(
  "ssl",
  async (job) => {
    logger.info("ssl job received", { id: job.id, name: job.name, data: job.data });

    if (job.name === "issue") {
      const result = await sysagent.issueCertificate({
        domain: job.data.domain,
        email: job.data.email
      });

      if (job.data.domainId) {
        await prisma.domain.update({
          where: { id: job.data.domainId },
          data: {
            sslEnabled: true,
            sslExpiry: new Date(Date.now() + 90 * 86_400_000)
          }
        });
      }

      return result;
    }

    if (job.name === "renew") {
      const result = await sysagent.renewCertificate(job.data.domain);

      if (job.data.domainId) {
        await prisma.domain.update({
          where: { id: job.data.domainId },
          data: {
            sslEnabled: true,
            sslExpiry: new Date(Date.now() + 90 * 86_400_000)
          }
        });
      }

      return result;
    }

    throw new Error(`Unknown SSL job: ${job.name}`);
  },
  { connection: redis }
);
