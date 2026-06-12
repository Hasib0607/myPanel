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

const sslActionSchema = z.object({
  email: z.string().email().optional(),
  includeWww: z.boolean().default(true)
});

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

async function runSslPreflight(domain: { id: string; name: string; documentRoot?: string | null }, includeWww: boolean) {
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
    const webRoot = path.join(env.FILE_MANAGER_ROOT, domain.name, domain.documentRoot || "public_html");
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
  const webRoot = path.join(env.FILE_MANAGER_ROOT, domain.name, domain.documentRoot || "public_html");
  const httpVhost = await publishDomainHttpVhost(domain.name, webRoot, effectiveIncludeWww);
  const preflight = await sysagent.sslPreflight({ domain: domain.name, webRoot, includeWww: effectiveIncludeWww });

  if (!commandSucceeded(preflight.certbot)) {
    const detail = commandFailureDetail(preflight.certbot);
    throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
  }

  const failedCheck = preflightChallengeChecks(preflight).find((check) => !commandSucceeded(check));
  if (failedCheck) {
    const detail = commandFailureDetail(failedCheck);
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${domain.name}. The panel published the challenge vhost, but the public challenge URL still did not return the token. Keep port 80 open and confirm public DNS points to this VPS.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return { dnsChecks, httpVhost, preflight, webRoot, includeWww: effectiveIncludeWww };
}

async function publishDomainHttpVhost(domainName: string, webRoot: string, includeWww: boolean) {
  const certName = certbotCertificateName(domainName);
  const serverName = includeWww ? `${domainName} www.${domainName}` : domainName;
  const result = await sysagent.writeStaticNginxVhost({
    name: `domain-${nginxResourceName(domainName)}`,
    serverName,
    rootPath: webRoot,
    forceHttps: false,
    sslCertificate: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    sslCertificateKey: `/etc/letsencrypt/live/${certName}/privkey.pem`
  }) as { test?: SysagentCommandResult; reload?: SysagentCommandResult };

  if (result.test && !commandSucceeded(result.test)) {
    const detail = commandFailureDetail(result.test);
    throw Object.assign(new Error(`Could not publish HTTP challenge vhost for ${domainName}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }
  if (result.reload && !commandSucceeded(result.reload)) {
    const detail = commandFailureDetail(result.reload);
    throw Object.assign(new Error(`Could not reload Nginx for ${domainName}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
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
  }) as { test?: SysagentCommandResult; reload?: SysagentCommandResult };

  if (result.test && !commandSucceeded(result.test)) {
    const detail = commandFailureDetail(result.test);
    throw Object.assign(new Error(`Could not publish HTTP vhost for ${target.fqdn}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }
  if (result.reload && !commandSucceeded(result.reload)) {
    const detail = commandFailureDetail(result.reload);
    throw Object.assign(new Error(`Could not reload Nginx for ${target.fqdn}.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return result;
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
  const httpVhost = await publishSubdomainHttpVhost(target);
  const preflight = await sysagent.sslPreflight({ domain: target.fqdn, webRoot: target.webRoot, includeWww: false });

  if (!commandSucceeded(preflight.certbot)) {
    const detail = commandFailureDetail(preflight.certbot);
    throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
  }

  const failedCheck = preflightChallengeChecks(preflight).find((check) => !commandSucceeded(check));
  if (failedCheck) {
    const detail = commandFailureDetail(failedCheck);
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${target.fqdn}. Publish the subdomain first and keep port 80 open.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return { ...target, dnsChecks, httpVhost, preflight, includeWww: false, dnsChallenge: false, certName: certbotCertificateName(target.fqdn) };
}

function preflightChallengeChecks(preflight: { checks: SysagentCommandResult[]; localChecks?: SysagentCommandResult[] }) {
  return preflight.localChecks?.length ? preflight.localChecks : preflight.checks;
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
    const effectiveExpiry = domain.sslEnabled ? domain.sslExpiry : null;
    return {
      domainId: domain.id,
      domain: domain.name,
      sslEnabled: domain.sslEnabled,
      sslExpiry: effectiveExpiry,
      forceSsl: domain.forceSsl,
      activeJobId: await activeSslJobIdForResource({ domainId: domain.id }),
      ...expiryStatus(effectiveExpiry)
    };
  });

  app.get("/subdomains/:subdomainId/status", async (request) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    const target = await subdomainSslTarget(subdomainId);
    const cert = await sysagent.certificateStatus(certbotCertificateName(target.fqdn));
    const expiry = cert.exists && cert.expiry ? new Date(cert.expiry) : null;
    return {
      subdomainId,
      domain: target.fqdn,
      sslEnabled: target.subdomain.sslEnabled && cert.exists,
      sslExpiry: expiry,
      forceSsl: target.subdomain.sslEnabled,
      activeJobId: await activeSslJobIdForResource({ subdomainId }),
      ...expiryStatus(expiry)
    };
  });

  app.post("/domains/:domainId/preflight", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, select: { id: true, name: true, documentRoot: true } });
    return runSslPreflight(domain, body.includeWww);
  });

  app.post("/subdomains/:subdomainId/preflight", async (request) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    return runSubdomainSslPreflight(subdomainId);
  });

  app.post("/domains/:domainId/issue", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, select: { id: true, name: true, forceSsl: true, documentRoot: true } });
    const preflight = await runSslPreflight(domain, body.includeWww);
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

    await prisma.subdomain.update({
      where: { id: subdomainId },
      data: { sslEnabled: false }
    });
    await redis.del("domain_list", `ssl_expiry:${preflight.fqdn}`);

    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.post("/domains/:domainId/renew", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, select: { id: true, name: true, forceSsl: true, documentRoot: true } });
    const preflight = await runSslPreflight(domain, body.includeWww);
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
    const expiresAt = body.expiresAt ?? new Date(Date.now() + 90 * 86_400_000);
    const domain = await prisma.domain.update({
      where: { id: domainId },
      data: {
        sslEnabled: true,
        sslExpiry: expiresAt
      }
    });
    await redis.del("domain_list", `ssl_expiry:${domain.name}`);
    return domain;
  });
};
