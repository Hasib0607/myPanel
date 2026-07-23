import path from "node:path";
import { env } from "../config/env.js";
import { sslQueue } from "../jobs/queues.js";
import { accountDomainWebRootPath, certificateNamesCoverHost, normalizeStoredDocumentRoot } from "./deploymentDomainSsl.js";
import { ensureSubdomainFileStructure } from "./domainFiles.js";
import { managedDomainHostnames, refreshDomainHostDns, refreshDomainHostSsl, refreshSubdomainHostDns, refreshSubdomainHostSsl, subdomainHostName, syncDomainHostRows, syncSubdomainHostRow } from "./domainHosts.js";
import { logger } from "./logger.js";
import { isWildcardHostname } from "./nginxNames.js";
import { prisma } from "./prisma.js";
import { currentVpsIp } from "./serverIp.js";
import { sysagent } from "./sysagent.js";

type SyncOptions = {
  limit?: number;
  includeDns?: boolean;
  queueRepair?: boolean;
  domainNames?: string[];
};

function domainWebRoot(domain: { name: string; documentRoot: string; account?: { homeRoot: string | null } | null }) {
  if (domain.account?.homeRoot) {
    return accountDomainWebRootPath({ homeRoot: domain.account.homeRoot }, domain);
  }
  return path.join(env.FILE_MANAGER_ROOT, domain.name, normalizeStoredDocumentRoot(domain.documentRoot));
}

async function subdomainWebRoot(subdomain: { name: string; domain: { name: string; account?: { homeRoot: string | null } | null } }) {
  if (subdomain.domain.account?.homeRoot) {
    return path.join(subdomain.domain.account.homeRoot, "public_html");
  }
  const scaffold = await ensureSubdomainFileStructure(subdomain.domain.name, subdomain.name);
  return path.join(env.FILE_MANAGER_ROOT, scaffold.relativeRoot);
}

function hourlyRepairJobId(prefix: string, id: string) {
  return `${prefix}:${id}:${Math.floor(Date.now() / 3_600_000)}`;
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function candidateDomainNames(hostnames: string[]) {
  const names = new Set<string>();
  for (const hostname of hostnames.map(normalizeHostname).filter(Boolean)) {
    names.add(hostname);
    if (hostname.startsWith("www.")) names.add(hostname.slice(4));
    if (hostname.startsWith("*.")) names.add(hostname.slice(2));
  }
  return [...names];
}

function candidateParentDomainNames(hostnames: string[]) {
  const names = new Set<string>();
  for (const hostname of hostnames.map(normalizeHostname).filter(Boolean)) {
    const clean = hostname.startsWith("*.") ? hostname.slice(2) : hostname;
    const labels = clean.split(".").filter(Boolean);
    if (labels.length > 2) names.add(labels.slice(1).join("."));
  }
  return [...names];
}

function hostDnsReady(hostname: string, dnsResults: Array<{ hostname: string; dnsStatus: string }> | null, includeDns: boolean) {
  if (!includeDns) return true;
  if (isWildcardHostname(hostname)) return true;
  return Boolean(dnsResults?.find((row) => normalizeHostname(row.hostname) === normalizeHostname(hostname) && row.dnsStatus === "READY"));
}

function repairAction(reason: string) {
  if (/dns|CAA/i.test(reason)) return "Update DNS/CAA, then Guardian will retry SSL.";
  if (/served certificate/i.test(reason)) return "Republish HTTPS vhost and verify the served certificate.";
  if (/SAN mismatch/i.test(reason)) return "Issue a certificate covering every hostname.";
  return "Queue SSL repair when DNS is ready.";
}

async function queueDomainRepair(
  domain: { id: string; name: string; documentRoot: string; forceSsl: boolean; account?: { homeRoot: string | null } | null },
  reason: string,
  includeWww: boolean
) {
  if (!domain.forceSsl) return null;
  const job = await sslQueue.add("issue", {
    domainId: domain.id,
    domain: domain.name,
    email: `admin@${domain.name}`,
    webRoot: domainWebRoot(domain),
    includeWww,
    forceSsl: true,
    source: "guardian-domain-host-sync",
    reason
  }, {
    jobId: hourlyRepairJobId("guardian-domain-host-sync", domain.id),
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
    jobId: hourlyRepairJobId("guardian-subdomain-host-sync", subdomain.id),
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
        reason: served.exists ? "served certificate SAN mismatch" : served.error ?? "served certificate missing",
        subject: (served as { subject?: string | null }).subject ?? null,
        issuer: (served as { issuer?: string | null }).issuer ?? null,
        expiry: (served as { expiry?: string | null }).expiry ?? null,
        names: served.names ?? []
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
  const filterNames = options.domainNames?.map(normalizeHostname).filter(Boolean) ?? [];
  const domainNameFilter = filterNames.length > 0 ? candidateDomainNames(filterNames) : null;
  const subdomainParentFilter = filterNames.length > 0 ? candidateParentDomainNames(filterNames) : null;
  const expectedIp = includeDns ? await currentVpsIp().catch(() => null) : null;
  const domains = await prisma.domain.findMany({
    ...(domainNameFilter ? { where: { name: { in: domainNameFilter } } } : {}),
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
    ...(subdomainParentFilter ? { where: { domain: { name: { in: subdomainParentFilter } } } } : {}),
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
      const dnsResults = expectedIp ? await refreshDomainHostDns(domain, expectedIp) : null;
      const includeWww = !isWildcardHostname(domain.name);
      const desiredHosts = managedDomainHostnames(domain.name, includeWww);
      const desiredHostnames = desiredHosts.map((host) => host.hostname);
      const cert = await sysagent.certificateFindReusable(domain.name).catch(() => null);
      const fileCoveredHosts = desiredHostnames.filter((hostname) =>
        Boolean(cert?.exists && cert.expiry && certificateNamesCoverHost(hostname, cert.names ?? []))
      );
      const servedFailures = fileCoveredHosts.length > 0 ? await servedHostFailures(fileCoveredHosts) : [];
      const servedFailureHosts = new Set(servedFailures.map((failure) => normalizeHostname(failure.host)));
      const matchingHosts = fileCoveredHosts.filter((hostname) => !servedFailureHosts.has(normalizeHostname(hostname)));
      const hosts = await refreshDomainHostSsl(domain, cert?.exists ? cert : null);
      if (servedFailures.length > 0) {
        const now = new Date();
        await Promise.all(servedFailures.map((failure) =>
          prisma.domainHost.update({
            where: { domainId_hostname: { domainId: domain.id, hostname: failure.host } },
            data: {
              sslEnabled: false,
              sslStatus: "MISMATCH",
              lastCheckedAt: now,
              lastError: `${failure.reason}${failure.subject ? `; served subject: ${failure.subject}` : ""}`
            }
          })
        ));
        await prisma.domain.update({ where: { id: domain.id }, data: { sslEnabled: false } });
      }
      const matches = desiredHostnames.length > 0 && desiredHostnames.every((hostname) =>
        matchingHosts.some((match) => normalizeHostname(match) === normalizeHostname(hostname))
      );
      if (matches) {
        updated.push({ type: "domain", domain: domain.name, hosts });
      } else {
        const reason = !cert?.exists ? "certificate missing" : fileCoveredHosts.length < desiredHostnames.length ? "certificate SAN mismatch" : "served certificate mismatch";
        const apexReady = hostDnsReady(domain.name, dnsResults, includeDns);
        const wwwHost = `www.${normalizeHostname(domain.name)}`;
        const wwwWanted = desiredHostnames.includes(wwwHost);
        const wwwReady = wwwWanted && hostDnsReady(wwwHost, dnsResults, includeDns);
        stale.push({ type: "domain", domain: domain.name, reason, action: repairAction(reason), servedFailures, dnsReady: { apex: apexReady, www: wwwWanted ? wwwReady : null } });
        if (queueRepair) {
          const needsRepair = desiredHostnames.some((hostname) =>
            hostDnsReady(hostname, dnsResults, includeDns)
            && !matchingHosts.some((match) => normalizeHostname(match) === normalizeHostname(hostname))
          );
          const queued = needsRepair && apexReady ? await queueDomainRepair(domain, reason, wwwReady) : null;
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
      const dnsResult = expectedIp ? await refreshSubdomainHostDns(subdomain, expectedIp) : null;
      const cert = await sysagent.certificateFindReusable(fqdn).catch(() => null);
      const fileMatches = Boolean(cert?.exists && cert.expiry && certificateNamesCoverHost(fqdn, cert.names ?? []));
      const servedFailures = fileMatches ? await servedHostFailures([fqdn]) : [];
      const matches = fileMatches && servedFailures.length === 0;
      const host = await refreshSubdomainHostSsl(subdomain, matches ? cert : null);
      if (matches) {
        updated.push({ type: "subdomain", domain: fqdn, hosts: [host] });
      } else {
        const reason = !cert?.exists ? "certificate missing" : !fileMatches ? "certificate SAN mismatch" : "served certificate mismatch";
        const dnsReady = hostDnsReady(fqdn, dnsResult ? [dnsResult] : null, includeDns);
        stale.push({ type: "subdomain", domain: fqdn, reason, action: repairAction(reason), servedFailures, dnsReady });
        if (queueRepair && wantsSsl && dnsReady) repairQueued.push(await queueSubdomainRepair(subdomain, reason));
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
