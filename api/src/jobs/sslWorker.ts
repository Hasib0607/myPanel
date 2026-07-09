import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { sslQueue } from "./queues.js";
import { logger } from "../lib/logger.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolvePublicA } from "../lib/publicDns.js";
import { currentVpsIp } from "../lib/serverIp.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";
import { subdomainFolderName } from "../lib/domainFiles.js";
import { certbotCertificateName, isWildcardHostname, nginxResourceName } from "../lib/nginxNames.js";
import {
  deploymentFallbackRootPath,
  deploymentIsRoutable,
  deploymentServerName,
  findDeploymentProxyTarget,
  publishDeploymentProxyNginx,
  publishPublicHtmlNginxVhost
} from "../lib/deploymentDomainSsl.js";

function assertLiveCommandSucceeded(action: string, result: SysagentCommandResult) {
  if (result.dryRun) {
    throw new Error(`${action} did not run live. Set ALLOW_LIVE_SSL=true on vps-panel-sysagent, install certbot, then restart sysagent and workers.`);
  }
  if (result.returncode !== 0) {
    const signal = result.signal ? ` (${result.signal})` : "";
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    const lowerDetail = detail.toLowerCase();
    const wasTerminated = result.returncode === -15 || result.signal === "SIGTERM";
    const certbotRecoveryCrash = lowerDetail.includes("keyauthorizationannotatedchallenge");
    const certbotHint = action.startsWith("Certbot") && (wasTerminated || certbotRecoveryCrash)
      ? " Certbot was interrupted during the ACME challenge/recovery step. Make sure vps-panel-sysagent is not being restarted while SSL jobs are active, repair/reload the sysagent service so child commands are not killed, then retry SSL issuance."
      : "";
    throw new Error(`${action} failed with exit code ${result.returncode}${signal}${detail ? `: ${detail}` : ""}${certbotHint}`);
  }
}

function commandDetail(result: SysagentCommandResult) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

function letsEncryptExactSetRateLimited(result: SysagentCommandResult) {
  const text = commandDetail(result).toLowerCase();
  return text.includes("too many certificates")
    && text.includes("exact set of identifiers")
    && text.includes("last 168h");
}

function rateLimitRetryAfter(result: SysagentCommandResult) {
  const match = commandDetail(result).match(/retry after\s+([^:\n]+?\s+UTC)/i);
  return match?.[1] ?? null;
}

type ReusableCertificate = {
  requested?: string;
  domain: string;
  exists: boolean;
  expiry: string | null;
  names: string[];
  certificate: string;
  privateKey: string;
};

function certificatePaths(domain: string, certificate?: ReusableCertificate | null) {
  if (certificate?.exists) {
    return {
      sslCertificate: certificate.certificate,
      sslCertificateKey: certificate.privateKey
    };
  }
  const certName = certbotCertificateName(domain);
  return {
    sslCertificate: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    sslCertificateKey: `/etc/letsencrypt/live/${certName}/privkey.pem`
  };
}

type NginxPublishResult = {
  test: SysagentCommandResult;
  reload: SysagentCommandResult;
  [key: string]: unknown;
};

function sslServerName(domainName: string, includeWww: boolean) {
  return includeWww ? `${domainName} www.${domainName}` : domainName;
}

type ReusableCertificateLookup = {
  result: SysagentCommandResult;
  certificate: ReusableCertificate;
};

async function reusableCertificateResult(certName: string, reason: string, requiredNames: string[]): Promise<ReusableCertificateLookup | null> {
  const status = await sysagent.certificateFindReusable(certName);
  if (!status.exists) return null;
  const certificateNames = new Set((status.names ?? []).map((name) => name.toLowerCase()));
  if (!requiredNames.every((name) => certificateNames.has(name.toLowerCase()))) return null;
  return {
    certificate: status,
    result: {
      dryRun: false,
      command: ["certbot", "reuse-existing", status.domain],
      stdout: `${reason}. Existing certificate ${status.domain} is present and will be reused for ${certName}.`,
      stderr: "",
      returncode: 0
    } satisfies SysagentCommandResult
  };
}

async function writeHttpsVhost(domainName: string, domainId: string | null | undefined, forceHttps: boolean, includeWww: boolean, webRoot?: string | null, certificate?: ReusableCertificate | null) {
  const proxyTarget = await findDeploymentProxyTarget(domainName);
  if (proxyTarget) {
    const serverName = deploymentServerName({
      name: domainName,
      includeWww: includeWww && proxyTarget.includeWww !== false
    }) ?? domainName;
    const bound = {
      id: domainName,
      name: domainName,
      forceSsl: forceHttps,
      sslEnabled: true,
      documentRoot: proxyTarget.domain.documentRoot,
      publicRootPath: proxyTarget.subdomainId
        ? `${env.FILE_MANAGER_ROOT}/${proxyTarget.domain.name}/subdomains/${subdomainFolderName(domainName.replace(new RegExp(`\\.${proxyTarget.domain.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), ""))}`
        : undefined,
      includeWww: includeWww && proxyTarget.includeWww !== false
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
      requireSsl: true,
      ...certificatePaths(domainName, certificate)
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
    if (deployment && deploymentIsRoutable(deployment)) {
      result = await publishDeploymentProxyNginx({
        deploymentId: deployment.id,
        fqdn: sslServerName(domainName, includeWww),
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        framework: deployment.framework,
        startCommand: deployment.startCommand,
        publicDirectory: deployment.publicDirectory,
        outputDirectory: deployment.outputDirectory,
        fallbackRootPath: deploymentFallbackRootPath({
          id: domain.id,
          name: domain.name,
          forceSsl: forceHttps,
          sslEnabled: domain.sslEnabled,
          documentRoot: domain.documentRoot,
          includeWww
        }),
        forceHttps,
        requireSsl: true,
        ...certificatePaths(domainName, certificate)
      }) as NginxPublishResult;
    } else {
      result = await publishPublicHtmlNginxVhost({
        id: domain.id,
        name: domain.name,
        forceSsl: forceHttps,
        sslEnabled: true,
        documentRoot: domain.documentRoot,
        includeWww
      }) as NginxPublishResult;
    }
  } else if (domain?.hostingMode === "REDIRECT") {
    if (!domain.redirectUrl) throw new Error(`No redirect URL selected for ${domainName}`);
    result = await sysagent.writeRedirectNginxVhost({
      name: `domain-${nginxResourceName(domainName)}`,
      serverName: sslServerName(domainName, includeWww),
      redirectUrl: domain.redirectUrl,
      requireSsl: true,
      ...certificatePaths(domainName, certificate)
    });
  } else {
    result = await sysagent.writeStaticNginxVhost({
      name: `domain-${nginxResourceName(domainName)}`,
      serverName: sslServerName(domainName, includeWww),
      rootPath: webRoot ?? `${env.FILE_MANAGER_ROOT}/${domainName}/${domain?.documentRoot || "public_html"}`,
      forceHttps,
      requireSsl: true,
      ...certificatePaths(domainName, certificate)
    });
  }

  assertLiveCommandSucceeded("Nginx certificate vhost test", result.test);
  assertLiveCommandSucceeded("Nginx certificate vhost reload", result.reload);
  return result;
}

async function markSslIssued(job: { data: { domain: string; domainId?: string | null; subdomainId?: string | null; forceSsl?: boolean } }, certificate?: ReusableCertificate | null) {
  if (job.data.subdomainId) {
    await prisma.subdomain.update({
      where: { id: job.data.subdomainId },
      data: { sslEnabled: true }
    });
    return;
  }
  if (job.data.domainId) {
    const domain = await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } });
    const status = certificate ?? await sysagent.certificateStatus(certbotCertificateName(job.data.domain));
    await prisma.domain.update({
      where: { id: job.data.domainId },
      data: {
        sslEnabled: true,
        sslExpiry: status.expiry ? new Date(status.expiry) : new Date(Date.now() + 90 * 86_400_000),
        forceSsl: domain?.forceSsl ?? job.data.forceSsl ?? true
      }
    });
  }
}

async function publishHttpChallengeVhost(domainName: string, domainId: string | null | undefined, includeWww: boolean, webRoot?: string | null) {
  if (!webRoot) return;
  const result = await sysagent.writeStaticNginxVhost({
    name: `domain-${nginxResourceName(domainName)}`,
    serverName: sslServerName(domainName, includeWww),
    rootPath: webRoot,
    forceHttps: false
  });
  assertLiveCommandSucceeded("Nginx HTTP challenge vhost test", result.test as SysagentCommandResult);
  assertLiveCommandSucceeded("Nginx HTTP challenge vhost reload", result.reload as SysagentCommandResult);
  if (domainId) {
    await redis.del("domain_list", `domain:${domainId}`);
  }
}

function firstFailedPreflightChallenge(preflight: { checks?: SysagentCommandResult[]; localChecks?: SysagentCommandResult[]; publicChecks?: SysagentCommandResult[] }) {
  const publicChecks = preflight.publicChecks?.length ? preflight.publicChecks : preflight.checks ?? [];
  const checks = [...(preflight.localChecks ?? []), ...publicChecks];
  return checks.find((check) => check.returncode !== 0 || check.dryRun);
}

async function assertHttpChallengeReachable(domainName: string, includeWww: boolean, webRoot: string) {
  const preflight = await sysagent.sslPreflight({ domain: domainName, webRoot, includeWww });
  assertLiveCommandSucceeded("Certbot readiness check", preflight.certbot);
  const failed = firstFailedPreflightChallenge(preflight);
  if (failed) {
    const detail = commandDetail(failed);
    throw new Error(`SSL auto retry waiting for HTTP challenge route: ${domainName} returned an invalid ACME challenge response.${detail ? ` ${detail}` : ""}`);
  }
}

async function assertHttpSslDnsReady(domainName: string, includeWww: boolean) {
  const vpsIp = await currentVpsIp();
  const hostnames = [domainName, ...(includeWww && !domainName.startsWith("*.") ? [`www.${domainName}`] : [])];
  for (const hostname of hostnames) {
    let records: string[] = [];
    try {
      records = await resolvePublicA(hostname);
    } catch (error) {
      throw new Error(`SSL auto retry waiting for DNS: ${hostname} has no public A record yet. ${error instanceof Error ? error.message : ""}`.trim());
    }
    if (!records.includes(vpsIp)) {
      throw new Error(`SSL auto retry waiting for DNS: ${hostname} resolves to ${records.join(", ") || "no A record"}, but this VPS is ${vpsIp}.`);
    }
  }
}

async function rescheduleAccountAutoSslForDns(job: any, error: unknown) {
  if (job.data?.source !== "account-auto-domain-ssl") return null;
  if (job.data?.domainId) {
    const domain = await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { sslEnabled: true } });
    if (domain?.sslEnabled) {
      return { pendingDns: false, skipped: true, reason: "SSL is already enabled" };
    }
  }

  const nextRetry = Number(job.data?.autoRetryCount ?? 0) + 1;
  if (nextRetry > env.ACCOUNT_DOMAIN_AUTO_SSL_ATTEMPTS) return null;

  const retry = await sslQueue.add("issue", {
    ...job.data,
    autoRetryCount: nextRetry
  }, {
    delay: env.ACCOUNT_DOMAIN_AUTO_SSL_RETRY_DELAY_MS,
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500
  });

  const message = error instanceof Error ? error.message : String(error);
  logger.warn("account auto SSL waiting for DNS; retry scheduled", {
    domain: job.data.domain,
    retry: nextRetry,
    retryJobId: retry.id,
    message
  });
  return {
    pendingDns: true,
    retryJobId: retry.id,
    retryInMs: env.ACCOUNT_DOMAIN_AUTO_SSL_RETRY_DELAY_MS,
    retry: nextRetry,
    message
  };
}

export const sslWorker = new Worker(
  "ssl",
  async (job) => {
    logger.info("ssl job received", { id: job.id, name: job.name, data: job.data });

    if (job.name === "issue") {
      const includeWww = job.data.includeWww ?? true;
      const certName = job.data.certName ?? certbotCertificateName(job.data.domain);
      const requiredNames = [job.data.domain, ...(includeWww && !isWildcardHostname(job.data.domain) ? [`www.${job.data.domain}`] : [])];
      let reusableCertificate: ReusableCertificate | null = null;
      const existingCertificate = await reusableCertificateResult(certName, "Certbot issue skipped", requiredNames);
      let result: SysagentCommandResult | null = existingCertificate?.result ?? null;
      reusableCertificate = existingCertificate?.certificate ?? null;
      if (!result) {
        const dnsChallenge = isWildcardHostname(job.data.domain) || job.data.dnsChallenge;
        if (!dnsChallenge) {
          const webRoot = job.data.webRoot ?? `${env.FILE_MANAGER_ROOT}/${job.data.domain}/public_html`;
          try {
            await assertHttpSslDnsReady(job.data.domain, includeWww);
            await publishHttpChallengeVhost(
              job.data.domain,
              job.data.domainId,
              includeWww,
              webRoot
            );
            await assertHttpChallengeReachable(job.data.domain, includeWww, webRoot);
          } catch (error) {
            const scheduled = await rescheduleAccountAutoSslForDns(job, error);
            if (scheduled) return scheduled;
            throw error;
          }
        }
        result = dnsChallenge
          ? await sysagent.issueDnsCertificate({
            domain: job.data.domain,
            parentDomain: job.data.parentDomain ?? job.data.domain.replace(/^\*\./, ""),
            email: job.data.email,
            certName,
            propagationSeconds: 300
          })
          : await sysagent.issueCertificate({
            domain: job.data.domain,
            email: job.data.email,
            webRoot: job.data.webRoot ?? `${env.FILE_MANAGER_ROOT}/${job.data.domain}/public_html`,
            includeWww,
            certName
          });
      }
      if (letsEncryptExactSetRateLimited(result)) {
        const reusable = await reusableCertificateResult(certName, "Let's Encrypt exact-set rate limit hit", requiredNames);
        if (reusable) {
          result = reusable.result;
          reusableCertificate = reusable.certificate;
        } else {
          const retryAfter = rateLimitRetryAfter(result);
          throw new Error(`Let's Encrypt rate limit hit for ${job.data.domain}. Too many certificates were requested for the same exact identifier set in the last 7 days.${retryAfter ? ` Retry after ${retryAfter}.` : ""} No reusable certificate matching ${certName} or ${certName}-0001 style Certbot lineages was found on disk, so Nginx cannot be switched to HTTPS yet.`);
        }
      }
      if (!result) throw new Error(`Certbot issue did not return a result for ${job.data.domain}`);
      assertLiveCommandSucceeded("Certbot issue", result);
      const verifiedCertificate = await reusableCertificateResult(certName, "Certbot certificate SAN verified", requiredNames);
      if (!verifiedCertificate) {
        throw new Error(`Certbot completed, but the installed certificate does not cover ${requiredNames.join(", ")}. Nginx was not switched to the incomplete certificate.`);
      }
      reusableCertificate = verifiedCertificate.certificate;

      const domain = job.data.domainId
        ? await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } })
        : null;
      const vhost = await writeHttpsVhost(job.data.domain, job.data.domainId, domain?.forceSsl ?? job.data.forceSsl ?? true, includeWww, job.data.webRoot, reusableCertificate);
      await markSslIssued(job, reusableCertificate);

      await redis.del("domain_list", `ssl_expiry:${job.data.domain}`);
      return { certbot: result, nginx: vhost };
    }

    if (job.name === "renew") {
      const certName = job.data.certName ?? certbotCertificateName(job.data.domain);
      const includeWww = job.data.includeWww ?? true;
      const requiredNames = [job.data.domain, ...(includeWww && !isWildcardHostname(job.data.domain) ? [`www.${job.data.domain}`] : [])];
      let reusableCertificate: ReusableCertificate | null = null;
      let result = isWildcardHostname(job.data.domain) || job.data.dnsChallenge
        ? await sysagent.issueDnsCertificate({
            domain: job.data.domain,
            parentDomain: job.data.parentDomain ?? job.data.domain.replace(/^\*\./, ""),
            email: job.data.email ?? `admin@${job.data.parentDomain ?? job.data.domain.replace(/^\*\./, "")}`,
            certName,
            propagationSeconds: 300
          })
        : await sysagent.renewCertificate(certName);
      if (letsEncryptExactSetRateLimited(result)) {
        const reusable = await reusableCertificateResult(certName, "Let's Encrypt exact-set rate limit hit during renew", requiredNames);
        if (reusable) {
          result = reusable.result;
          reusableCertificate = reusable.certificate;
        }
      }
      assertLiveCommandSucceeded("Certbot renew", result);
      const verifiedCertificate = await reusableCertificateResult(certName, "Renewed certificate SAN verified", requiredNames);
      if (!verifiedCertificate) {
        throw new Error(`Certbot renewal completed, but the installed certificate does not cover ${requiredNames.join(", ")}. Nginx was not switched to the incomplete certificate.`);
      }
      reusableCertificate = verifiedCertificate.certificate;

      const domain = job.data.domainId
        ? await prisma.domain.findUnique({ where: { id: job.data.domainId }, select: { forceSsl: true } })
        : null;
      const vhost = await writeHttpsVhost(job.data.domain, job.data.domainId, domain?.forceSsl ?? job.data.forceSsl ?? true, includeWww, job.data.webRoot, reusableCertificate);
      await markSslIssued(job, reusableCertificate);

      await redis.del("domain_list", `ssl_expiry:${job.data.domain}`);
      return { certbot: result, nginx: vhost };
    }

    throw new Error(`Unknown SSL job: ${job.name}`);
  },
  { connection: redis, concurrency: 1 }
);
