import tls from "node:tls";
import type { FastifyPluginAsync } from "fastify";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const safeRestartServices = new Set(["nginx", "panel-api", "panel-frontend", "panel-workers"]);

async function trySysagent<T>(fallback: T, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function daysUntil(date: Date) {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function probeSsl(domain: string) {
  return new Promise<{ ok: boolean; issuer?: string; validFrom?: string; validTo?: string; daysRemaining?: number; error?: string }>((resolve) => {
    const socket = tls.connect({
      host: domain,
      port: 443,
      servername: domain,
      timeout: 5000,
      rejectUnauthorized: false
    }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) {
        resolve({ ok: false, error: "No certificate returned" });
        return;
      }
      const expiresAt = new Date(cert.valid_to);
      resolve({
        ok: true,
        issuer: typeof cert.issuer?.O === "string" ? cert.issuer.O : undefined,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        daysRemaining: Number.isNaN(expiresAt.getTime()) ? undefined : daysUntil(expiresAt)
      });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, error: "TLS probe timed out" });
    });
    socket.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
  });
}

type GuardianDiagnosis = {
  unavailable?: true;
  incidents?: Array<{ category?: string; title?: string; detail?: string }>;
  services?: Array<{ key: string; name: string; status: string; optional?: boolean }>;
  pm2?: { items?: Array<{ name: string; pmId?: number; status: string; healthy: boolean }> };
  logs?: { nginxErrors?: number; badHttpResponses?: number };
};

async function runSafeAutoHeal(diagnosis: GuardianDiagnosis) {
  const actions: Array<{ action: string; target: string; result: unknown; skipped?: boolean; reason?: string }> = [];

  for (const service of diagnosis.services ?? []) {
    if (service.status !== "down" || service.optional) continue;
    if (!safeRestartServices.has(service.key)) {
      actions.push({ action: "restart-service", target: service.key, skipped: true, reason: "not in safe restart allowlist", result: null });
      continue;
    }
    const result = await sysagent.guardianRestartService(service.key);
    actions.push({ action: "restart-service", target: service.key, result });
  }

  for (const app of diagnosis.pm2?.items ?? []) {
    if (app.healthy) continue;
    const result = await sysagent.guardianRestartPm2(app.pmId !== undefined ? { pmId: app.pmId } : { name: app.name });
    actions.push({ action: "restart-pm2", target: app.pmId !== undefined ? String(app.pmId) : app.name, result });
  }

  if ((diagnosis.logs?.nginxErrors ?? 0) > 0 || (diagnosis.logs?.badHttpResponses ?? 0) > 10) {
    const result = await sysagent.guardianReloadNginx();
    actions.push({ action: "reload-nginx", target: "nginx", result });
  }

  const cleanup = await sysagent.guardianCleanupLogs(1);
  actions.push({ action: "cleanup-logs", target: "deployment-logs", result: cleanup });

  return actions;
}

export const guardianRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/overview", async () => {
    const [diagnosis, deployments, sslDomains] = await Promise.all([
      trySysagent({ unavailable: true, incidents: [], services: [], ports: [] }, () => sysagent.guardianDiagnosis()),
      prisma.deployment.findMany({
        orderBy: { updatedAt: "desc" },
        take: 12,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          healthStatus: true,
          port: true,
          lastHealthCheckAt: true,
          updatedAt: true
        }
      }),
      prisma.domain.findMany({
        where: { sslEnabled: true },
        orderBy: { sslExpiry: "asc" },
        take: 12,
        select: { id: true, name: true, sslEnabled: true, sslExpiry: true }
      })
    ]);

    const sslProbes = await Promise.all(
      sslDomains.map(async (domain) => ({
        domainId: domain.id,
        name: domain.name,
        probe: await probeSsl(domain.name)
      }))
    );
    const sslProbeByDomain = new Map(sslProbes.map((item) => [item.domainId, item.probe]));

    const sslIncidents = sslDomains
      .map((domain) => ({ domain, liveDays: sslProbeByDomain.get(domain.id)?.daysRemaining }))
      .filter(({ domain, liveDays }) => (liveDays ?? (domain.sslExpiry ? daysUntil(domain.sslExpiry) : 9999)) <= 14)
      .map(({ domain, liveDays }) => ({
        severity: (liveDays ?? daysUntil(domain.sslExpiry!)) <= 3 ? "critical" : "warning",
        category: "ssl",
        title: `${domain.name} SSL expires soon`,
        detail: `${liveDays ?? daysUntil(domain.sslExpiry!)} days remaining${liveDays === undefined ? " from DB" : " from live probe"}`
      }));

    const deploymentIncidents = deployments
      .filter((deployment) => ["FAILED", "STOPPED"].includes(deployment.status) || deployment.healthStatus === "DOWN")
      .map((deployment) => ({
        severity: deployment.status === "FAILED" || deployment.healthStatus === "DOWN" ? "critical" : "warning",
        category: "deployment",
        title: `${deployment.name} needs attention`,
        detail: `status=${deployment.status}, health=${deployment.healthStatus}, port=${deployment.port}`
      }));

    const incidents = [
      ...((diagnosis as any).incidents ?? []),
      ...sslIncidents,
      ...deploymentIncidents
    ];

    return {
      diagnosis,
      incidents,
      deployments,
      sslDomains: sslDomains.map((domain) => ({
        ...domain,
        daysRemaining: domain.sslExpiry ? daysUntil(domain.sslExpiry) : null,
        liveSsl: sslProbeByDomain.get(domain.id) ?? null
      })),
      generatedAt: new Date().toISOString()
    };
  });

  app.post("/auto-heal", async (request, reply) => {
    const diagnosis = await sysagent.guardianDiagnosis() as GuardianDiagnosis;
    if (diagnosis.unavailable) return reply.code(503).send({ error: "Guardian diagnosis is unavailable" });
    const actions = await runSafeAutoHeal(diagnosis);
    await audit(request, {
      action: "APPLY",
      resource: "guardian",
      resourceId: "auto-heal",
      description: "Guardian safe auto-heal run",
      metadata: { actions } as any
    });
    return reply.code(202).send({
      accepted: true,
      actions,
      generatedAt: new Date().toISOString()
    });
  });
};
