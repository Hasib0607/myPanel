import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";

function assertLiveCommandSucceeded(action: string, result: SysagentCommandResult) {
  if (result.dryRun) {
    throw new Error(`${action} did not run live. Set ALLOW_LIVE_SSL=true on vps-panel-sysagent, install certbot, then restart sysagent and workers.`);
  }
  if (result.returncode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${action} failed with exit code ${result.returncode}${detail ? `: ${detail}` : ""}`);
  }
}

function certificatePaths(domain: string) {
  return {
    sslCertificate: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
    sslCertificateKey: `/etc/letsencrypt/live/${domain}/privkey.pem`
  };
}

async function writeHttpsVhost(domain: string, forceHttps: boolean) {
  const result = await sysagent.writeStaticNginxVhost({
    name: domain,
    serverName: `${domain} www.${domain}`,
    rootPath: `${env.FILE_MANAGER_ROOT}/${domain}/public_html`,
    forceHttps,
    requireSsl: true,
    ...certificatePaths(domain)
  });

  assertLiveCommandSucceeded("Nginx certificate vhost test", result.test);
  assertLiveCommandSucceeded("Nginx certificate vhost reload", result.reload);
  return result;
}

export const sslWorker = new Worker(
  "ssl",
  async (job) => {
    logger.info("ssl job received", { id: job.id, name: job.name, data: job.data });

    if (job.name === "issue") {
      const result = await sysagent.issueCertificate({
        domain: job.data.domain,
        email: job.data.email,
        webRoot: job.data.webRoot ?? `${env.FILE_MANAGER_ROOT}/${job.data.domain}/public_html`,
        includeWww: job.data.includeWww ?? true
      });
      assertLiveCommandSucceeded("Certbot issue", result);

      const domain = job.data.domainId
        ? await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } })
        : null;
      const vhost = await writeHttpsVhost(job.data.domain, domain?.forceSsl ?? job.data.forceSsl ?? true);

      if (job.data.domainId) {
        await prisma.domain.update({
          where: { id: job.data.domainId },
          data: {
            sslEnabled: true,
            sslExpiry: new Date(Date.now() + 90 * 86_400_000),
            forceSsl: domain?.forceSsl ?? job.data.forceSsl ?? true
          }
        });
      }

      await redis.del("domain_list", `ssl_expiry:${job.data.domain}`);
      return { certbot: result, nginx: vhost };
    }

    if (job.name === "renew") {
      const result = await sysagent.renewCertificate(job.data.domain);
      assertLiveCommandSucceeded("Certbot renew", result);

      const domain = job.data.domainId
        ? await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } })
        : null;
      const vhost = await writeHttpsVhost(job.data.domain, domain?.forceSsl ?? job.data.forceSsl ?? true);

      if (job.data.domainId) {
        await prisma.domain.update({
          where: { id: job.data.domainId },
          data: {
            sslEnabled: true,
            sslExpiry: new Date(Date.now() + 90 * 86_400_000)
          }
        });
      }

      await redis.del("domain_list", `ssl_expiry:${job.data.domain}`);
      return { certbot: result, nginx: vhost };
    }

    throw new Error(`Unknown SSL job: ${job.name}`);
  },
  { connection: redis }
);
