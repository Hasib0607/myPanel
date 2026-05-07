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

export const sslRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/domains/:domainId/status", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    return {
      domainId: domain.id,
      domain: domain.name,
      sslEnabled: domain.sslEnabled,
      sslExpiry: domain.sslExpiry,
      forceSsl: domain.forceSsl,
      ...expiryStatus(domain.sslExpiry)
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
        sslEnabled: false
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
