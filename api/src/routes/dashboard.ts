import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { sysagent } from "../lib/sysagent.js";

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
    let productionServices: Array<{ name: string; port: number; status: "healthy" | "down" | "pending"; detail: string }> = [];
    try {
      const [stats, serviceStatus] = await Promise.all([
        sysagent.stats(),
        sysagent.services().catch(() => ({ items: [] }))
      ]);
      systemStats = stats;
      productionServices = serviceStatus.items;
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
        { name: "Nginx", port: 80, status: "down" as const, detail: "sysagent service check unavailable" },
        { name: "BIND9", port: 53, status: "down" as const, detail: "sysagent service check unavailable" },
        { name: "Postfix", port: 25, status: "down" as const, detail: "sysagent service check unavailable" },
        { name: "Dovecot", port: 993, status: "down" as const, detail: "sysagent service check unavailable" }
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
};
