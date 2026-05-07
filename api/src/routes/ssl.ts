import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { sslQueue } from "../jobs/queues.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const sslActionSchema = z.object({
  email: z.string().email().optional()
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

  app.post("/domains/:domainId/issue", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslActionSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const job = await sslQueue.add("issue", {
      domainId,
      domain: domain.name,
      email: body.email ?? `admin@${domain.name}`,
      webRoot: path.join(env.FILE_MANAGER_ROOT, domain.name, "public_html"),
      includeWww: true,
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
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
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
