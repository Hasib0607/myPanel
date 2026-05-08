import path from "node:path";
import dns from "node:dns/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { sslQueue } from "../jobs/queues.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";

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

function commandSucceeded(result: SysagentCommandResult) {
  return result.returncode === 0 && !result.dryRun;
}

function commandFailureDetail(result: SysagentCommandResult) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
}

async function resolvePublicA(hostname: string) {
  const resolvers = env.DOMAIN_NAMESERVER_RESOLVERS.split(",").map((resolver) => resolver.trim()).filter(Boolean);
  const errors: string[] = [];
  for (const resolverAddress of resolvers) {
    const resolver = new dns.Resolver();
    resolver.setServers([resolverAddress]);
    try {
      const records = await resolver.resolve4(hostname);
      if (records.length > 0) return records;
    } catch (error) {
      errors.push(`${resolverAddress}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  }
  try {
    return await dns.resolve4(hostname);
  } catch (error) {
    errors.push(`system: ${error instanceof Error ? error.message : "lookup failed"}`);
  }
  throw Object.assign(new Error(`No public A record found for ${hostname}. Resolver checks: ${errors.join("; ")}`), { statusCode: 400 });
}

async function assertARecordPointsToVps(hostname: string) {
  const records = await resolvePublicA(hostname);
  if (!records.includes(env.VPS_IP)) {
    throw Object.assign(new Error(`${hostname} A record must point to this VPS (${env.VPS_IP}). Current A records: ${records.join(", ") || "none"}`), { statusCode: 400 });
  }
  return records;
}

async function runSslPreflight(domain: { name: string }, includeWww: boolean) {
  const hosts = [domain.name, ...(includeWww ? [`www.${domain.name}`] : [])];
  const dnsChecks = await Promise.all(hosts.map(async (host) => ({ host, records: await assertARecordPointsToVps(host) })));
  const webRoot = path.join(env.FILE_MANAGER_ROOT, domain.name, "public_html");
  const preflight = await sysagent.sslPreflight({ domain: domain.name, webRoot, includeWww });

  if (!commandSucceeded(preflight.certbot)) {
    const detail = commandFailureDetail(preflight.certbot);
    throw Object.assign(new Error(`Certbot is not ready. Install certbot and enable ALLOW_LIVE_SSL. ${detail}`.trim()), { statusCode: 400 });
  }

  const failedCheck = preflight.checks.find((check) => !commandSucceeded(check));
  if (failedCheck) {
    const detail = commandFailureDetail(failedCheck);
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${domain.name}. Publish the domain first and keep port 80 open.${detail ? ` ${detail}` : ""}`), { statusCode: 400 });
  }

  return { dnsChecks, preflight, webRoot };
}

export const sslRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/jobs/:jobId", async (request) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    return sslJobStatus(jobId);
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
      ...expiryStatus(effectiveExpiry)
    };
  });

  app.post("/domains/:domainId/preflight", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, select: { name: true } });
    return runSslPreflight(domain, body.includeWww);
  });

  app.post("/domains/:domainId/issue", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const preflight = await runSslPreflight(domain, body.includeWww);
    const job = await sslQueue.add("issue", {
      domainId,
      domain: domain.name,
      email: body.email ?? `admin@${domain.name}`,
      webRoot: preflight.webRoot,
      includeWww: body.includeWww,
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

  app.post("/domains/:domainId/renew", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    await runSslPreflight(domain, body.includeWww);
    const job = await sslQueue.add("renew", {
      domainId,
      domain: domain.name,
      forceSsl: domain.forceSsl
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
