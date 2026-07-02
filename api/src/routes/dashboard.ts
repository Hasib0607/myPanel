import type { FastifyPluginAsync } from "fastify";
import path from "node:path";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { normalizeDeploymentResourcePolicy } from "../lib/deploymentResourcePolicy.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { sysagent } from "../lib/sysagent.js";

const manageableServices: Record<string, { key: "nginx" | "bind9" | "postfix" | "dovecot" }> = {
  Nginx: { key: "nginx" },
  BIND9: { key: "bind9" },
  Postfix: { key: "postfix" },
  Dovecot: { key: "dovecot" }
};

type DashboardService = {
  key?: string;
  name: string;
  port: number;
  status: "healthy" | "down" | "pending";
  detail: string;
  installed?: boolean;
  manageable?: boolean;
  availableActions?: string[];
};

type DashboardResourceUser = {
  id: string;
  slug: string;
  name: string;
  status: string;
  framework: string;
  priorityTier: string;
  memoryMaxMb: number;
  cpuQuotaPercent: number;
  memoryBytes: number;
  cpuPercent: number;
  processCount: number;
};

function normalizeService(service: DashboardService): DashboardService {
  const manageable = manageableServices[service.name];
  if (!manageable) return service;
  const installed = service.installed ?? !/not active|not found|unavailable|inactive/i.test(service.detail);
  return {
    ...service,
    key: service.key ?? manageable.key,
    installed,
    manageable: service.manageable ?? true,
    availableActions: service.availableActions ?? (installed ? ["start", "stop", "restart", "enable", "disable"] : ["install"])
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function topDeploymentResourceUsers(): Promise<DashboardResourceUser[]> {
  const deployments = await prisma.deployment.findMany({
    where: { status: { in: ["RUNNING", "DEPLOYING", "BUILDING"] } },
    orderBy: { updatedAt: "desc" },
    take: 6
  });
  const rows = await Promise.all(deployments.map(async (deployment) => {
    const policy = normalizeDeploymentResourcePolicy(deployment.processConfig);
    const appPath = path.resolve(deployment.rootPath, deployment.rootDirectory || ".");
    const metrics = await withTimeout(
      sysagent.deploymentMetrics({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        port: deployment.port,
        framework: deployment.framework,
        processManager: deployment.processManager,
        dbType: deployment.dbType,
        dbName: deployment.dbName,
        serverNames: [],
        logLines: 10,
        processOnly: true
      }).catch(() => null) as Promise<any>,
      2500,
      null
    );
    return {
      id: deployment.id,
      slug: deployment.slug,
      name: deployment.name,
      status: deployment.status,
      framework: deployment.framework,
      priorityTier: policy.priorityTier,
      memoryMaxMb: policy.memoryMaxMb,
      cpuQuotaPercent: policy.cpuQuotaPercent,
      memoryBytes: Number(metrics?.process?.memoryBytes ?? 0),
      cpuPercent: Number(metrics?.process?.cpuPercent ?? 0),
      processCount: Number(metrics?.process?.processCount ?? 0)
    };
  }));
  return rows
    .sort((a, b) => (b.memoryBytes + b.cpuPercent * 10_000_000) - (a.memoryBytes + a.cpuPercent * 10_000_000))
    .slice(0, 3);
}

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireAuth }, async () => {
    const [domains, activeDomains, suspendedDomains, dnsRecords, nameServers, mailboxes, deployments, deploymentStatus, firewallRules] = await Promise.all([
      prisma.domain.count(),
      prisma.domain.count({ where: { status: "ACTIVE" } }),
      prisma.domain.count({ where: { status: "SUSPENDED" } }),
      prisma.dnsRecord.count(),
      prisma.nameServer.count(),
      prisma.mailAccount.count(),
      prisma.deployment.count(),
      prisma.deployment.groupBy({ by: ["status"], _count: true }),
      prisma.firewallRule.count()
    ]);

    let systemStats = null;
    let sysagentHealthy = false;
    let productionServices: DashboardService[] = [];
    try {
      const [stats, serviceStatus] = await Promise.all([
        sysagent.stats(),
        sysagent.services().catch(() => ({ items: [] }))
      ]);
      systemStats = stats;
      productionServices = serviceStatus.items.map(normalizeService);
      sysagentHealthy = true;
    } catch {
      systemStats = { unavailable: true };
    }
    const services = [];

    try {
      await prisma.$queryRaw`SELECT 1`;
      services.push({ name: "PostgreSQL", port: 5433, status: "healthy", detail: "panel_main reachable" });
    } catch {
      services.push({ name: "PostgreSQL", port: 5433, status: "down", detail: "database query failed" });
    }

    try {
      await redis.ping();
      services.push({ name: "Redis", port: 6379, status: "healthy", detail: "cache and queues reachable" });
    } catch {
      services.push({ name: "Redis", port: 6379, status: "down", detail: "redis ping failed" });
    }

    services.push(
      { name: "System Agent", port: 5000, status: sysagentHealthy ? "healthy" : "down", detail: sysagentHealthy ? "localhost API reachable" : "sysagent unavailable" },
      ...(productionServices.length > 0 ? productionServices : [
        normalizeService({ name: "Nginx", port: 80, status: "down" as const, detail: "sysagent service check unavailable", installed: false }),
        normalizeService({ name: "BIND9", port: 53, status: "down" as const, detail: "sysagent service check unavailable", installed: false }),
        normalizeService({ name: "Postfix", port: 25, status: "down" as const, detail: "sysagent service check unavailable", installed: false }),
        normalizeService({ name: "Dovecot", port: 993, status: "down" as const, detail: "sysagent service check unavailable", installed: false })
      ])
    );

    return {
      counts: {
        domains,
        activeDomains,
        suspendedDomains,
        dnsRecords,
        nameServers,
        mailboxes,
        deployments,
        firewallRules
      },
      deploymentStatus: deploymentStatus.map((item) => ({ status: item.status, count: item._count })),
      systemStats,
      services,
      generatedAt: new Date().toISOString()
    };
  });

  app.get("/top-resource-users", { preHandler: app.requireAuth }, async () => {
    return {
      items: await topDeploymentResourceUsers().catch(() => []),
      generatedAt: new Date().toISOString()
    };
  });

  app.get("/largest-files", { preHandler: app.requireAuth }, async () => {
    return sysagent.largestFiles({ limit: 40, minBytes: 10 * 1024 * 1024 });
  });

  app.delete("/largest-files", { preHandler: app.requireAuth }, async (request) => {
    const body = z.object({
      path: z.string().min(1)
    }).parse(request.body);
    const result = await sysagent.deleteLargeFile(body);
    await audit(request, {
      action: "DELETE",
      resource: "large_file",
      resourceId: body.path,
      description: `Deleted large file ${body.path}`,
      metadata: { result: result as any }
    });
    return result;
  });

  app.post("/services/:serviceKey/:action", { preHandler: app.requireAuth }, async (request, reply) => {
    const { serviceKey, action } = z.object({
      serviceKey: z.enum(["nginx", "bind9", "postfix", "dovecot"]),
      action: z.enum(["install", "start", "stop", "restart", "enable", "disable"])
    }).parse(request.params);
    const result = await sysagent.serviceAction(serviceKey, action);
    await audit(request, {
      action: action === "stop" ? "STOP" : action === "restart" ? "RESTART" : "APPLY",
      resource: "system_service",
      resourceId: serviceKey,
      description: `${action} requested for ${serviceKey}`,
      metadata: { result: result as any }
    });
    return reply.code(202).send({ serviceKey, action, result });
  });
};
