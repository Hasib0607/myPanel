import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { ensureSubdomainFileStructure } from "../lib/domainFiles.js";
import { publishDomainDnsZone } from "../lib/domainDnsPublish.js";
import { assertPublicARecordPointsTo, defaultVanityNameServerHostnames, resolvePublicA, resolvePublicNameServers } from "../lib/publicDns.js";
import { sslQueue } from "../jobs/queues.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";
import { certbotCertificateName, isWildcardHostname, nginxResourceName } from "../lib/nginxNames.js";
import { currentVpsIp } from "../lib/serverIp.js";
import { certificateNamesCoverHost, certificateNamesCoverServerName, deploymentServerName } from "../lib/deploymentDomainSsl.js";
import { refreshDomainHostSsl, syncDomainHostRows } from "../lib/domainHosts.js";

const sslActionSchema = z.object({
  email: z.string().email().optional(),
  includeWww: z.boolean().default(true)
});

type SslDomain = {
  id: string;
  name: string;
  forceSsl?: boolean;
  documentRoot?: string | null;
  account?: { homeRoot?: string | null } | null;
};

function normalizeDocumentRoot(value?: string | null) {
  const root = (value || "public_html").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!root || root.includes("..") || path.isAbsolute(root)) {
    const error = new Error("Document root must be a folder inside the domain.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return root;
}

function domainWebRoot(domain: SslDomain) {
  const documentRoot = normalizeDocumentRoot(domain.documentRoot);
  if (domain.account?.homeRoot) {
    if (documentRoot === domain.name || documentRoot.startsWith(`${domain.name}/`)) {
      return path.join(domain.account.homeRoot, documentRoot);
    }
    return path.join(domain.account.homeRoot, domain.name, documentRoot);
  }
  return path.join(env.FILE_MANAGER_ROOT, domain.name, documentRoot);
}

function expiryStatus(expiry: Date | null) {
  if (!expiry) return { state: "missing", daysRemaining: null, alert: false };
  const diffMs = expiry.getTime() - Date.now();
  const daysRemaining = Math.ceil(diffMs / 86_400_000);
  return {
    state: daysRemaining < 0 ? "expired" : daysRemaining < 14 ? "expiring" : "valid",
    daysRemaining,
    alert: daysRemaining < 14
  };
}

function sslHostStatus(host: string, cert: { exists?: boolean; expiry?: string | null; names?: string[] } | null) {
  const certificateMatches = Boolean(cert?.exists && certificateNamesCoverHost(host, cert.names ?? []));
  const expiry = certificateMatches && cert?.expiry ? new Date(cert.expiry) : null;
  return {
    host,
    sslEnabled: certificateMatches,
    sslExpiry: expiry,
    ...expiryStatus(expiry)
  };
}

async function sslJobStatus(jobId: string) {
  const job = await sslQueue.getJob(jobId);
  if (!job) {
    throw Object.assign(new Error("SSL job not found. It may have already been cleaned up."), { statusCode: 404 });
  }

  const state = await job.getState();
  return {
    id: job.id,
    name: job.name,
    state,
    progress: job.progress,
    failedReason: job.failedReason,
    stacktrace: job.stacktrace,
    returnvalue: job.returnvalue,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    data: {
      domainId: job.data.domainId,
      domain: job.data.domain,
      source: job.data.source
    }
  };
}

async function killSslJob(jobId: string) {
  const job = await sslQueue.getJob(jobId);
  if (!job) {
    throw Object.assign(new Error("SSL job not found. It may have already been cleaned up."), { statusCode: 404 });
  }

  const state = await job.getState();
  const terminal = state === "completed" || state === "failed";
  let processKill: Awaited<ReturnType<typeof sysagent.killSslProcess>> | null = null;
  if (!terminal && job.data?.domain) {
    processKill = await sysagent.killSslProcess({
      domain: job.data.domain,
      certName: job.data.certName ?? certbotCertificateName(job.data.domain)
    }).catch((error) => ({
      returncode: 1,
      stderr: error instanceof Error ? error.message : "Could not kill SSL process"
    }));
  }

  let removed = false;
  if (!terminal) {
    try {
      await job.remove();
      removed = true;
    } catch {
      removed = false;
    }
  }

  return {
    killed: true,
    jobId,
    state,
    removed,
    processKill
  };
}

async function activeSslJobIdForResource(resource: { domainId?: string | null; subdomainId?: string | null }) {
  const jobs = await sslQueue.getJobs(["waiting", "active", "delayed", "paused", "prioritized", "waiting-children"], 0, 100, true);
  const job = jobs.find((item) => {
    if (resource.domainId && item.data?.domainId === resource.domainId) return true;
    if (resource.subdomainId && item.data?.subdomainId === resource.subdomainId) return true;
    return false;
  });
  return job?.id ? String(job.id) : null;
}

function commandSucceeded(result: SysagentCommandResult) {
  return result.returncode === 0 && !result.dryRun;
}

function commandFailureDetail(result: SysagentCommandResult) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

type PreflightChallengeCheck = {
  scope: "local" | "public";
  check: SysagentCommandResult;
};

async function panelVanityNameServers(domainId: string, domainName: string) {
  const [dnsRecords, configuredNameServers] = await Promise.all([
    prisma.dnsRecord.findMany({ where: { domainId, type: "NS", name: "@" }, select: { value: true } }),
    prisma.nameServer.findMany({ where: { active: true }, select: { hostname: true } })
  ]);

  const hostnames = [...new Set([
    ...dnsRecords.map((record) => record.value.replace(/\.$/, "").toLowerCase()),
    ...configuredNameServers.map((record) => record.hostname.toLowerCase()),
    ...defaultVanityNameServerHostnames(domainName)
  ])];

  return hostnames.filter((hostname) => hostname.endsWith(`.${domainName}`));
}

async function assertDnsChallengeDelegated(domainId: string, domainName: string, reason: unknown) {
  const [publicLookup, configuredNameServers] = await Promise.all([
    resolvePublicNameServers(domainName),
    panelVanityNameServers(domainId, domainName)
  ]);
  const publicNameServers = publicLookup.nameServers;
  const expectedNameServers = configuredNameServers.map((hostname) => hostname.toLowerCase().replace(/\.$/, ""));
  const matched = publicNameServers.filter((hostname) => expectedNameServers.includes(hostname));

  if (matched.length > 0) return { publicNameServers, expectedNameServers };

  const detail = reason instanceof Error ? reason.message : "HTTP A record is not ready";
  const expected = expectedNameServers.length ? expectedNameServers.join(", ") : `ns1.${domainName}, ns2.${domainName}`;
  const actual = publicNameServers.length ? publicNameServers.join(", ") : "none";
  const checks = publicLookup.errors.length ? ` Resolver checks: ${publicLookup.errors.join("; ")}` : "";
  throw Object.assign(
    new Error(`Cannot issue DNS SSL for ${domainName} yet. Public nameservers are ${actual}, but this panel can only create DNS-01 TXT records when the registrar delegates the domain to ${expected}. ${detail}${checks}`),
    { statusCode: 400 }
  );
}

async function assertARecordPointsToVps(hostname: string, domainId: string, domainName: string) {
  const knownVanityNameServers = await panelVanityNameServers(domainId, domainName);
  return assertPublicARecordPointsTo(hostname, await currentVpsIp(), { knownVanityNameServers });
}

async function optionalARecordPointsToVps(hostname: string, domainId: string, domainName: string) {
  try {
    const vpsIp = await currentVpsIp();
    const records = await resolvePublicA(hostname);
    const ok = records.includes(vpsIp);
    return { host: hostname, records, ok, skipped: !ok };
  } catch {
    return { host: hostname, records: [] as string[], ok: false, skipped: true };
  }
}

async function runSslPreflight(domain: SslDomain, includeWww: boolean) {
  await publishDomainDnsZone(domain.id);
  let apexRecords: string[];
  try {
    apexRecords = await assertARecordPointsToVps(domain.name, domain.id, domain.name);
  } catch (error) {
    const delegation = await assertDnsChallengeDelegated(domain.id, domain.name, error);
    const certbot = await sysagent.certbotStatus();
    if (!commandSucceeded(certbot)) {
      const detail = commandFailureDetail(certbot);
      throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
    }
    const webRoot = domainWebRoot(domain);
    return {
      dnsChecks: [{
        host: `_acme-challenge.${domain.name}`,
        records: delegation.publicNameServers,
        ok: true,
        skipped: false,
        dns01: true,
        reason: error instanceof Error ? error.message : "HTTP A record is not ready"
      }],
      preflight: { certbot, write: certbot, checks: [] as SysagentCommandResult[], webRoot },
      webRoot,
      includeWww: false,
      dnsChallenge: true,
      parentDomain: domain.name,
      certName: certbotCertificateName(domain.name)
    };
  }
  const apexCheck = { host: domain.name, records: apexRecords, ok: true, skipped: false };
  const wwwCheck = includeWww ? await optionalARecordPointsToVps(`www.${domain.name}`, domain.id, domain.name) : null;
  const effectiveIncludeWww = Boolean(wwwCheck?.ok);
  const dnsChecks = [apexCheck, ...(wwwCheck ? [wwwCheck] : [])];
  const webRoot = domainWebRoot(domain);
  const httpVhost = await publishDomainHttpVhost(domain.name, webRoot, effectiveIncludeWww);
  const preflight = await sysagent.sslPreflight({ domain: domain.name, webRoot, includeWww: effectiveIncludeWww });

  if (!commandSucceeded(preflight.certbot)) {
    const detail = commandFailureDetail(preflight.certbot);
    throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
  }

  const failedCheck = preflightChallengeChecks(preflight).find(({ check }) => !commandSucceeded(check));
  if (failedCheck) {
    const detail = commandFailureDetail(failedCheck.check);
    const hint = failedCheck.scope === "local"
      ? "The local Nginx challenge vhost did not return the token. Check the generated vhost and document root."
      : "The public challenge URL did not return the token. Keep port 80 open and confirm public DNS points to this VPS.";
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${domain.name}. ${hint}${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return { dnsChecks, httpVhost, preflight, webRoot, includeWww: effectiveIncludeWww };
}

async function publishDomainHttpVhost(domainName: string, webRoot: string, includeWww: boolean) {
  const serverName = includeWww ? `${domainName} www.${domainName}` : domainName;
  const result = await sysagent.writeStaticNginxVhost({
    name: `domain-${nginxResourceName(domainName)}`,
    serverName,
    rootPath: webRoot,
    forceHttps: false
  }) as { test?: SysagentCommandResult; reload?: SysagentCommandResult; postReloadCheck?: SysagentCommandResult };

  if (result.test && !commandSucceeded(result.test)) {
    const detail = commandFailureDetail(result.test);
    throw Object.assign(new Error(`Could not publish HTTP challenge vhost for ${domainName}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }
  if (result.reload && !commandSucceeded(result.reload)) {
    const detail = commandFailureDetail(result.reload);
    throw Object.assign(new Error(`Could not reload Nginx for ${domainName}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }
  if (result.postReloadCheck && !commandSucceeded(result.postReloadCheck)) {
    const detail = commandFailureDetail(result.postReloadCheck);
    throw Object.assign(new Error(`Could not verify HTTP challenge vhost for ${domainName}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return result;
}

async function subdomainSslTarget(subdomainId: string) {
  const subdomain = await prisma.subdomain.findUniqueOrThrow({
    where: { id: subdomainId },
    include: { domain: { select: { id: true, name: true } } }
  });
  const fqdn = `${subdomain.name}.${subdomain.domain.name}`;
  const scaffold = await ensureSubdomainFileStructure(subdomain.domain.name, subdomain.name);
  return {
    subdomain,
    parentDomain: subdomain.domain,
    fqdn,
    webRoot: path.join(env.FILE_MANAGER_ROOT, scaffold.relativeRoot)
  };
}

async function publishSubdomainHttpVhost(target: Awaited<ReturnType<typeof subdomainSslTarget>>) {
  const result = await sysagent.writeStaticNginxVhost({
    name: `domain-${nginxResourceName(target.fqdn)}`,
    serverName: target.fqdn,
    rootPath: target.webRoot,
    forceHttps: false
  }) as { test?: SysagentCommandResult; reload?: SysagentCommandResult; postReloadCheck?: SysagentCommandResult };

  if (result.test && !commandSucceeded(result.test)) {
    const detail = commandFailureDetail(result.test);
    throw Object.assign(new Error(`Could not publish HTTP vhost for ${target.fqdn}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }
  if (result.reload && !commandSucceeded(result.reload)) {
    const detail = commandFailureDetail(result.reload);
    throw Object.assign(new Error(`Could not reload Nginx for ${target.fqdn}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }
  if (result.postReloadCheck && !commandSucceeded(result.postReloadCheck)) {
    const detail = commandFailureDetail(result.postReloadCheck);
    throw Object.assign(new Error(`Could not verify HTTP challenge vhost for ${target.fqdn}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return result;
}

async function subdomainHasDeploymentBinding(subdomainId: string) {
  const binding = await prisma.deploymentDomain.findFirst({
    where: { subdomainId },
    select: { id: true }
  });
  return Boolean(binding);
}

async function runSubdomainSslPreflight(subdomainId: string) {
  const target = await subdomainSslTarget(subdomainId);
  if (isWildcardHostname(target.fqdn)) {
    await publishDomainDnsZone(target.parentDomain.id);
    const certbot = await sysagent.certbotStatus();
    if (!commandSucceeded(certbot)) {
      const detail = commandFailureDetail(certbot);
      throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
    }
    return {
      ...target,
      dnsChecks: [{ host: `_acme-challenge.${target.parentDomain.name}`, records: [] as string[], ok: true, skipped: false, dns01: true }],
      httpVhost: null,
      preflight: { certbot, write: certbot, checks: [] as SysagentCommandResult[], webRoot: target.webRoot },
      includeWww: false,
      dnsChallenge: true,
      certName: certbotCertificateName(target.fqdn)
    };
  }
  await publishDomainDnsZone(target.parentDomain.id);
  const records = await assertARecordPointsToVps(target.fqdn, target.parentDomain.id, target.parentDomain.name);
  const dnsChecks = [{ host: target.fqdn, records, ok: true, skipped: false }];
  const deploymentBound = await subdomainHasDeploymentBinding(subdomainId);
  const httpVhost = deploymentBound
    ? { skipped: true, reason: "Subdomain is bound to a deployment; static HTTP challenge vhost was not published." }
    : await publishSubdomainHttpVhost(target);
  const preflight = await sysagent.sslPreflight({ domain: target.fqdn, webRoot: target.webRoot, includeWww: false });

  if (!commandSucceeded(preflight.certbot)) {
    const detail = commandFailureDetail(preflight.certbot);
    throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
  }

  const failedCheck = preflightChallengeChecks(preflight).find(({ check }) => !commandSucceeded(check));
  if (failedCheck) {
    const detail = commandFailureDetail(failedCheck.check);
    const hint = failedCheck.scope === "local"
      ? deploymentBound
        ? "The deployment proxy vhost did not return the ACME token. Redeploy or run Deployment Doctor so the proxy route includes the ACME webroot location."
        : "The local Nginx challenge vhost did not return the token. Check the generated vhost and document root."
      : "Publish the subdomain first, keep port 80 open, and confirm public DNS points to this VPS.";
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${target.fqdn}. ${hint}${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return { ...target, dnsChecks, httpVhost, preflight, includeWww: false, dnsChallenge: false, certName: certbotCertificateName(target.fqdn) };
}

function preflightChallengeChecks(preflight: { checks?: SysagentCommandResult[]; localChecks?: SysagentCommandResult[]; publicChecks?: SysagentCommandResult[] }): PreflightChallengeCheck[] {
  const publicChecks = preflight.publicChecks?.length ? preflight.publicChecks : preflight.checks ?? [];
  return [
    ...(preflight.localChecks ?? []).map((check) => ({ scope: "local" as const, check })),
    ...publicChecks.map((check) => ({ scope: "public" as const, check }))
  ];
}

export const sslRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/jobs/:jobId", async (request) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    return sslJobStatus(jobId);
  });

  app.post("/jobs/:jobId/kill", async (request) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    return killSslJob(jobId);
  });

  app.get("/domains/:domainId/status", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const cert = await sysagent.certificateFindReusable(domain.name).catch(() => null);
    const serverName = deploymentServerName({ name: domain.name, includeWww: true }) ?? domain.name;
    const certificateMatches = Boolean(cert?.exists && certificateNamesCoverServerName(serverName, cert.names ?? []));
    const serverHosts = serverName.split(/\s+/).filter(Boolean);
    const servedCertificates = await Promise.all(serverHosts.map((host) => sysagent.servedCertificate({ domain: host }).catch(() => null)));
    const servedMatches = servedCertificates.every((served) => served?.matches);
    const effectiveExpiry = domain.sslEnabled && certificateMatches && servedMatches && cert?.expiry ? new Date(cert.expiry) : null;
    const hosts = serverHosts.map((host, index) => sslHostStatus(host, servedCertificates[index]?.matches ? cert : null));
    if (cert) await refreshDomainHostSsl(domain, certificateMatches && servedMatches ? cert : null);
    return {
      domainId: domain.id,
      domain: domain.name,
      sslEnabled: domain.sslEnabled && certificateMatches,
      sslExpiry: effectiveExpiry,
      hosts,
      servedCertificate: servedCertificates,
      forceSsl: domain.forceSsl,
      activeJobId: await activeSslJobIdForResource({ domainId: domain.id }),
      ...expiryStatus(effectiveExpiry)
    };
  });

  app.get("/subdomains/:subdomainId/status", async (request) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    const target = await subdomainSslTarget(subdomainId);
    const cert = await sysagent.certificateFindReusable(target.fqdn);
    const certificateMatches = Boolean(cert.exists && certificateNamesCoverHost(target.fqdn, cert.names ?? []));
    const expiry = certificateMatches && cert.expiry ? new Date(cert.expiry) : null;
    const hosts = [sslHostStatus(target.fqdn, cert)];
    return {
      subdomainId,
      domain: target.fqdn,
      sslEnabled: target.subdomain.sslEnabled && certificateMatches,
      sslExpiry: expiry,
      hosts,
      forceSsl: target.subdomain.sslEnabled,
      activeJobId: await activeSslJobIdForResource({ subdomainId }),
      ...expiryStatus(expiry)
    };
  });

  app.post("/domains/:domainId/preflight", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      select: { id: true, name: true, documentRoot: true, account: { select: { homeRoot: true } } }
    });
    return runSslPreflight(domain, body.includeWww);
  });

  app.post("/subdomains/:subdomainId/preflight", async (request) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    return runSubdomainSslPreflight(subdomainId);
  });

  app.post("/domains/:domainId/issue", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      select: { id: true, name: true, forceSsl: true, documentRoot: true, account: { select: { homeRoot: true } } }
    });
    const preflight = await runSslPreflight(domain, body.includeWww);
    await syncDomainHostRows(domain, { includeWww: preflight.includeWww });
    const job = await sslQueue.add("issue", {
      domainId,
      domain: domain.name,
      email: body.email ?? `admin@${domain.name}`,
      webRoot: preflight.webRoot,
      includeWww: preflight.includeWww,
      dnsChallenge: preflight.dnsChallenge ?? false,
      parentDomain: preflight.parentDomain,
      certName: preflight.certName,
      forceSsl: domain.forceSsl
    });

    await prisma.domain.update({
      where: { id: domainId },
      data: {
        sslEnabled: false,
        sslExpiry: null
      }
    });
    await refreshDomainHostSsl({ ...domain, forceSsl: true }, null);
    await redis.del("domain_list", `ssl_expiry:${domain.name}`);

    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.post("/subdomains/:subdomainId/issue", async (request, reply) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    const preflight = await runSubdomainSslPreflight(subdomainId);
    const job = await sslQueue.add("issue", {
      domainId: null,
      subdomainId,
      domain: preflight.fqdn,
      email: `admin@${preflight.parentDomain.name}`,
      webRoot: preflight.webRoot,
      includeWww: false,
      forceSsl: true,
      dnsChallenge: preflight.dnsChallenge ?? false,
      parentDomain: preflight.parentDomain.name,
      certName: preflight.certName ?? certbotCertificateName(preflight.fqdn),
      source: "subdomain-ssl"
    });

    if (!(await subdomainHasDeploymentBinding(subdomainId))) {
      await prisma.subdomain.update({
        where: { id: subdomainId },
        data: { sslEnabled: false }
      });
    }
    await redis.del("domain_list", `ssl_expiry:${preflight.fqdn}`);

    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.post("/domains/:domainId/renew", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      select: { id: true, name: true, forceSsl: true, documentRoot: true, account: { select: { homeRoot: true } } }
    });
    const preflight = await runSslPreflight(domain, body.includeWww);
    await syncDomainHostRows(domain, { includeWww: preflight.includeWww });
    const job = await sslQueue.add("renew", {
      domainId,
      domain: domain.name,
      webRoot: preflight.webRoot,
      includeWww: preflight.includeWww,
      dnsChallenge: preflight.dnsChallenge ?? false,
      parentDomain: preflight.parentDomain,
      certName: preflight.certName,
      forceSsl: domain.forceSsl
    });

    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.post("/subdomains/:subdomainId/renew", async (request, reply) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    const target = await subdomainSslTarget(subdomainId);
    const preflight = await runSubdomainSslPreflight(subdomainId);
    const job = await sslQueue.add("renew", {
      domainId: null,
      subdomainId,
      domain: target.fqdn,
      webRoot: preflight.webRoot,
      includeWww: false,
      forceSsl: true,
      dnsChallenge: preflight.dnsChallenge ?? false,
      parentDomain: preflight.parentDomain.name,
      certName: preflight.certName ?? certbotCertificateName(preflight.fqdn),
      source: "subdomain-ssl"
    });

    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.post("/domains/:domainId/mark-issued", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ expiresAt: z.coerce.date().optional() }).parse(request.body ?? {});
    const existing = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const cert = await sysagent.certificateFindReusable(existing.name);
    const serverName = deploymentServerName({ name: existing.name, includeWww: true }) ?? existing.name;
    if (!cert.exists || !certificateNamesCoverServerName(serverName, cert.names ?? [])) {
      throw Object.assign(
        new Error(`Cannot mark SSL issued for ${existing.name}; no matching certificate covers ${serverName}.`),
        { statusCode: 400 }
      );
    }
    const expiresAt = cert.expiry ? new Date(cert.expiry) : body.expiresAt;
    if (!expiresAt) {
      throw Object.assign(new Error(`Cannot mark SSL issued for ${existing.name}; matching certificate has no expiry date.`), { statusCode: 400 });
    }
    const domain = await prisma.domain.update({
      where: { id: domainId },
      data: {
        sslEnabled: true,
        sslExpiry: expiresAt
      }
    });
    await refreshDomainHostSsl({ id: domain.id, name: domain.name, forceSsl: domain.forceSsl }, cert);
    await redis.del("domain_list", `ssl_expiry:${domain.name}`);
    return domain;
  });
};
