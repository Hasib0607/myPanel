import path from "node:path";
import { env } from "../config/env.js";
import { sslQueue } from "../jobs/queues.js";
import { certificateNamesCoverHost, certificateNamesCoverServerName, deploymentServerName } from "./deploymentDomainSsl.js";
import { ensureSubdomainFileStructure } from "./domainFiles.js";
import { managedDomainHostnames, refreshDomainHostDns, refreshDomainHostSsl, refreshSubdomainHostDns, refreshSubdomainHostSsl, subdomainHostName, syncDomainHostRows, syncSubdomainHostRow } from "./domainHosts.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { currentVpsIp } from "./serverIp.js";
import { sysagent } from "./sysagent.js";

type SyncOptions = {
  limit?: number;
  includeDns?: boolean;
  queueRepair?: boolean;
};

function domainWebRoot(domain: { name: string; documentRoot: string; account?: { homeRoot: string | null } | null }) {
  if (domain.account?.homeRoot) {
    return path.join(domain.account.homeRoot, domain.name, domain.documentRoot || "public_html");
  }
  return path.join(env.FILE_MANAGER_ROOT, domain.name, domain.documentRoot || "public_html");
}

async function subdomainWebRoot(subdomain: { name: string; domain: { name: string; account?: { homeRoot: string | null } | null } }) {
  if (subdomain.domain.account?.homeRoot) {
    return path.join(subdomain.domain.account.homeRoot, "public_html");
  }
  const scaffold = await ensureSubdomainFileStructure(subdomain.domain.name, subdomain.name);
  return path.join(env.FILE_MANAGER_ROOT, scaffold.relativeRoot);
}

async function queueDomainRepair(domain: { id: string; name: string; documentRoot: string; forceSsl: boolean; account?: { homeRoot: string | null } | null }, reason: string) {
  if (!domain.forceSsl) return null;
  const job = await sslQueue.add("issue", {
    domainId: domain.id,
    domain: domain.name,
    email: `admin@${domain.name}`,
    webRoot: domainWebRoot(domain),
    includeWww: true,
    forceSsl: true,
    source: "guardian-domain-host-sync",
    reason
  }, {
    jobId: `guardian-domain-host-sync:${domain.id}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
  return { type: "domain" as const, domain: domain.name, jobId: job.id, reason };
}

async function queueSubdomainRepair(subdomain: { id: string; name: string; domain: { id: string; name: string; account?: { homeRoot: string | null } | null } }, reason: string) {
  const fqdn = subdomainHostName(subdomain);
  const job = await sslQueue.add("issue", {
    subdomainId: subdomain.id,
    domain: fqdn,
    parentDomain: subdomain.domain.name,
    email: `admin@${subdomain.domain.name}`,
    webRoot: await subdomainWebRoot(subdomain),
    includeWww: false,
    forceSsl: true,
    source: "guardian-subdomain-host-sync",
    reason
  }, {
    jobId: `guardian-subdomain-host-sync:${subdomain.id}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
  return { type: "subdomain" as const, domain: fqdn, jobId: job.id, reason };
}

async function servedHostFailures(hostnames: string[]) {
  const failures = [];
  for (const hostname of hostnames) {
    const served = await sysagent.servedCertificate({ domain: hostname }).catch((error) => ({
      exists: false,
      matches: false,
      names: [],
      error: error instanceof Error ? error.message : String(error)
    }));
    if (!served.exists || !certificateNamesCoverHost(hostname, served.names ?? [])) {
      failures.push({
        host: hostname,
        reason: served.exists ? "served certificate SAN mismatch" : served.error ?? "served certificate missing"
      });
    }
  }
  return failures;
}

export async function runDomainHostSync(options: SyncOptions = {}) {
  const configuredLimit = Number(process.env.GUARDIAN_DOMAIN_HOST_SYNC_LIMIT ?? 5000);
  const limit = Math.min(Math.max(options.limit ?? configuredLimit, 1), 10_000);
  const includeDns = options.includeDns ?? true;
  const queueRepair = options.queueRepair ?? true;
  const expectedIp = includeDns ? await currentVpsIp().catch(() => null) : null;
  const domains = await prisma.domain.findMany({
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      name: true,
      forceSsl: true,
      sslEnabled: true,
      sslExpiry: true,
      documentRoot: true,
      account: { select: { homeRoot: true } }
    }
  });
  const subdomains = await prisma.subdomain.findMany({
    orderBy: { id: "asc" },
    take: limit,
    include: { domain: { select: { id: true, name: true, account: { select: { homeRoot: true } } } } }
  });

  const updated = [];
  const stale = [];
  const repairQueued = [];
  const errors = [];

  for (const domain of domains) {
    try {
      await syncDomainHostRows(domain);
      if (expectedIp) await refreshDomainHostDns(domain, expectedIp);
      const cert = await sysagent.certificateFindReusable(domain.name).catch(() => null);
      const serverName = deploymentServerName({ name: domain.name, includeWww: true }) ?? domain.name;
      const serverHosts = serverName.split(/\s+/).filter(Boolean);
      const fileMatches = Boolean(cert?.exists && cert.expiry && certificateNamesCoverServerName(serverName, cert.names ?? []));
      const servedFailures = fileMatches ? await servedHostFailures(serverHosts) : [];
      const matches = fileMatches && servedFailures.length === 0;
      const hosts = await refreshDomainHostSsl(domain, matches ? cert : null);
      if (matches) {
        updated.push({ type: "domain", domain: domain.name, hosts });
      } else {
        const reason = !cert?.exists ? "certificate missing" : !fileMatches ? "certificate SAN mismatch" : "served certificate mismatch";
        stale.push({ type: "domain", domain: domain.name, reason, servedFailures });
        if (queueRepair) {
          const queued = await queueDomainRepair(domain, reason);
          if (queued) repairQueued.push(queued);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ type: "domain", domain: domain.name, error: message });
      logger.warn("domain host sync failed", { domain: domain.name, error: message });
    }
  }

  for (const subdomain of subdomains) {
    const fqdn = subdomainHostName(subdomain);
    const wantsSsl = subdomain.sslEnabled;
    try {
      await syncSubdomainHostRow(subdomain);
      if (expectedIp) await refreshSubdomainHostDns(subdomain, expectedIp);
      const cert = await sysagent.certificateFindReusable(fqdn).catch(() => null);
      const fileMatches = Boolean(cert?.exists && cert.expiry && certificateNamesCoverHost(fqdn, cert.names ?? []));
      const servedFailures = fileMatches ? await servedHostFailures([fqdn]) : [];
      const matches = fileMatches && servedFailures.length === 0;
      const host = await refreshSubdomainHostSsl(subdomain, matches ? cert : null);
      if (matches) {
        updated.push({ type: "subdomain", domain: fqdn, hosts: [host] });
      } else {
        const reason = !cert?.exists ? "certificate missing" : !fileMatches ? "certificate SAN mismatch" : "served certificate mismatch";
        stale.push({ type: "subdomain", domain: fqdn, reason, servedFailures });
        if (queueRepair && wantsSsl) repairQueued.push(await queueSubdomainRepair(subdomain, reason));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ type: "subdomain", domain: fqdn, error: message });
      logger.warn("subdomain host sync failed", { domain: fqdn, error: message });
    }
  }

  return {
    checked: { domains: domains.length, subdomains: subdomains.length },
    updated,
    stale,
    repairQueued,
    errors,
    generatedAt: new Date().toISOString()
  };
}
