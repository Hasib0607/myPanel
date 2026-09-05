import { guardianQueue, sslQueue, deployQueue, mailQueue } from "../jobs/queues.js";
import { redis } from "../lib/redis.js";

try {
  const job = await guardianQueue.add("ssl-renew-watch", { source: "system-renewal-scheduler" }, {
    jobId: `guardian-system-ssl-renew-${Math.floor(Date.now() / 3_600_000)}`,
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100
  });
  console.log(JSON.stringify({ queued: job.id, policy: "hosting-nameservers-only" }));
} finally {
  await Promise.all([guardianQueue, sslQueue, deployQueue, mailQueue].map((queue) => queue.close()));
  await redis.quit();
}
