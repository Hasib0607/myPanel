import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";
import {
  deploymentFallbackRootPath,
  deploymentServerName,
  findDeploymentProxyTarget,
  publishDeploymentProxyNginx
} from "../lib/deploymentDomainSsl.js";

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

type NginxPublishResult = {
  test: SysagentCommandResult;
  reload: SysagentCommandResult;
  [key: string]: unknown;
};

async function writeHttpsVhost(domainName: string, domainId: string | null | undefined, forceHttps: boolean) {
  const proxyTarget = await findDeploymentProxyTarget(domainName);
  if (proxyTarget) {
    const serverName = deploymentServerName({
      name: domainName,
      includeWww: proxyTarget.includeWww
    }) ?? domainName;
    const bound = {
      id: domainName,
      name: domainName,
      forceSsl: forceHttps,
      sslEnabled: true,
      documentRoot: proxyTarget.domain.documentRoot,
      includeWww: proxyTarget.includeWww
    };
    const result = await publishDeploymentProxyNginx({
      deploymentId: proxyTarget.deployment.id,
      fqdn: serverName,
      upstreamPort: proxyTarget.deployment.port,
      rootPath: proxyTarget.deployment.rootPath,
      framework: proxyTarget.deployment.framework,
      startCommand: proxyTarget.deployment.startCommand,
      publicDirectory: proxyTarget.deployment.publicDirectory,
      outputDirectory: proxyTarget.deployment.outputDirectory,
      fallbackRootPath: deploymentFallbackRootPath(bound),
      forceHttps,
      requireSsl: true
    });
    assertLiveCommandSucceeded("Nginx certificate vhost test", result.test as SysagentCommandResult);
    assertLiveCommandSucceeded("Nginx certificate vhost reload", result.reload as SysagentCommandResult);
    return result;
  }

  const domain = domainId
    ? await prisma.domain.findUnique({
        where: { id: domainId },
        include: {
          deployments: { orderBy: { createdAt: "desc" }, take: 1 },
          deploymentBindings: { include: { deployment: true }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] }
        }
      })
    : null;

  let result: NginxPublishResult;
  if (domain?.hostingMode === "DEPLOYMENT_PROXY") {
    const deployment = domain.hostingDeploymentId
      ? await prisma.deployment.findUnique({ where: { id: domain.hostingDeploymentId } })
      : domain.deploymentBindings[0]?.deployment ?? domain.deployments[0] ?? null;
    if (!deployment) throw new Error(`No deployment selected for ${domainName} HTTPS proxy`);
    result = await publishDeploymentProxyNginx({
      deploymentId: deployment.id,
      fqdn: deploymentServerName({ name: domainName, includeWww: true }) ?? domainName,
      upstreamPort: deployment.port,
      rootPath: deployment.rootPath,
      framework: deployment.framework,
      startCommand: deployment.startCommand,
      publicDirectory: deployment.publicDirectory,
      outputDirectory: deployment.outputDirectory,
      fallbackRootPath: `${env.FILE_MANAGER_ROOT}/${domainName}/${domain.documentRoot || "public_html"}`,
      forceHttps,
      requireSsl: true
    }) as NginxPublishResult;
  } else if (domain?.hostingMode === "REDIRECT") {
    if (!domain.redirectUrl) throw new Error(`No redirect URL selected for ${domainName}`);
    result = await sysagent.writeRedirectNginxVhost({
      name: `domain-${domainName}`,
      serverName: `${domainName} www.${domainName}`,
      redirectUrl: domain.redirectUrl,
      requireSsl: true,
      ...certificatePaths(domainName)
    });
  } else {
    result = await sysagent.writeStaticNginxVhost({
      name: `domain-${domainName}`,
      serverName: `${domainName} www.${domainName}`,
      rootPath: `${env.FILE_MANAGER_ROOT}/${domainName}/${domain?.documentRoot || "public_html"}`,
      forceHttps,
      requireSsl: true,
      ...certificatePaths(domainName)
    });
  }

  assertLiveCommandSucceeded("Nginx certificate vhost test", result.test);
  assertLiveCommandSucceeded("Nginx certificate vhost reload", result.reload);
  return result;
}

async function markSslIssued(job: { data: { domainId?: string | null; subdomainId?: string | null; forceSsl?: boolean } }) {
  if (job.data.subdomainId) {
    await prisma.subdomain.update({
      where: { id: job.data.subdomainId },
      data: { sslEnabled: true }
    });
    return;
  }
  if (job.data.domainId) {
    const domain = await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } });
    await prisma.domain.update({
      where: { id: job.data.domainId },
      data: {
        sslEnabled: true,
        sslExpiry: new Date(Date.now() + 90 * 86_400_000),
        forceSsl: domain?.forceSsl ?? job.data.forceSsl ?? true
      }
    });
  }
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
      const vhost = await writeHttpsVhost(job.data.domain, job.data.domainId, domain?.forceSsl ?? job.data.forceSsl ?? true);
      await markSslIssued(job);

      await redis.del("domain_list", `ssl_expiry:${job.data.domain}`);
      return { certbot: result, nginx: vhost };
    }

    if (job.name === "renew") {
      const result = await sysagent.renewCertificate(job.data.domain);
      assertLiveCommandSucceeded("Certbot renew", result);

      const domain = job.data.domainId
        ? await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } })
        : null;
      const vhost = await writeHttpsVhost(job.data.domain, job.data.domainId, domain?.forceSsl ?? job.data.forceSsl ?? true);
      await markSslIssued(job);

      await redis.del("domain_list", `ssl_expiry:${job.data.domain}`);
      return { certbot: result, nginx: vhost };
    }

    throw new Error(`Unknown SSL job: ${job.name}`);
  },
  { connection: redis }
);
