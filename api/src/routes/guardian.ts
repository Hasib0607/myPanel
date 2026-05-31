import { createHash } from "node:crypto";
import tls from "node:tls";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { runGuardianAutoHeal, syncGuardianIncidentsOnly, type GuardianDiagnosis } from "../lib/guardianAutoHeal.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const ipActionSchema = z.object({
  ip: z.string().trim().min(3),
  reason: z.string().trim().min(1).optional(),
  durationMinutes: z.number().int().min(5).max(43_200).optional()
});
const allowlistSchema = z.object({
  cidr: z.string().trim().min(3),
  label: z.string().trim().optional(),
  expiresAt: z.string().datetime().optional()
});

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

function isAllowlisted(ip: string, allowlist: Array<{ cidr: string }>) {
  return allowlist.some((item) => item.cidr === ip);
}

function fileFingerprint(path: string, reason: string) {
  return createHash("sha256").update(`${path}:${reason}`).digest("hex").slice(0, 32);
}

async function syncFileFindings() {
  const scan = await sysagent.guardianFileWatch();
  const activeFingerprints: string[] = [];
  for (const finding of scan.findings) {
    const fingerprint = fileFingerprint(finding.path, finding.reason);
    activeFingerprints.push(fingerprint);
    await prisma.guardianFileFinding.upsert({
      where: { fingerprint },
      update: {
        path: finding.path,
        reason: finding.reason,
        risk: finding.risk,
        status: "OPEN",
        sizeBytes: finding.sizeBytes,
        mode: finding.mode,
        owner: finding.owner,
        modifiedAt: finding.modifiedAt ? new Date(finding.modifiedAt) : null,
        lastSeenAt: new Date()
      },
      create: {
        fingerprint,
        path: finding.path,
        reason: finding.reason,
        risk: finding.risk,
        sizeBytes: finding.sizeBytes,
        mode: finding.mode,
        owner: finding.owner,
        modifiedAt: finding.modifiedAt ? new Date(finding.modifiedAt) : null
      }
    });
  }
  await prisma.guardianFileFinding.updateMany({
    where: { status: "OPEN", fingerprint: { notIn: activeFingerprints } },
    data: { status: "RESOLVED" }
  });
  return scan;
}

export const guardianRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/overview", async () => {
    const [diagnosis, deployments, sslDomains, recentActions, storedIncidents, allowlist, activeBlocks, fileFindings] = await Promise.all([
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
      }),
      prisma.guardianAction.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { incident: { select: { title: true, severity: true, status: true } } }
      }),
      prisma.guardianIncident.findMany({
        where: { status: "OPEN" },
        orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }],
        take: 20
      }),
      prisma.guardianIpAllowlist.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.guardianIpBlock.findMany({ where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.guardianFileFinding.findMany({ where: { status: "OPEN" }, orderBy: [{ risk: "desc" }, { lastSeenAt: "desc" }], take: 50 })
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
      recentActions,
      storedIncidents,
      security: {
        allowlist,
        activeBlocks,
        suspiciousIps: ((diagnosis as any).security?.suspiciousIps ?? []).map((item: any) => ({
          ...item,
          allowlisted: isAllowlisted(item.ip, allowlist),
          blocked: activeBlocks.some((block) => block.ip === item.ip)
        }))
      },
      fileFindings,
      generatedAt: new Date().toISOString()
    };
  });

  app.get("/file-watch/scan", async () => {
    const scan = await syncFileFindings();
    const findings = await prisma.guardianFileFinding.findMany({ where: { status: "OPEN" }, orderBy: [{ risk: "desc" }, { lastSeenAt: "desc" }], take: 50 });
    return { scan, findings };
  });

  app.post("/allowlist", async (request, reply) => {
    const body = allowlistSchema.parse(request.body);
    const item = await prisma.guardianIpAllowlist.upsert({
      where: { cidr: body.cidr },
      update: { label: body.label, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null },
      create: { cidr: body.cidr, label: body.label, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null }
    });
    await audit(request, { action: "APPLY", resource: "guardian_allowlist", resourceId: item.id, description: `Allowlisted ${body.cidr}` });
    return reply.code(201).send(item);
  });

  app.delete("/allowlist/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await prisma.guardianIpAllowlist.delete({ where: { id } });
    return { ok: true };
  });

  app.post("/block-ip", async (request, reply) => {
    const body = ipActionSchema.parse(request.body);
    if (body.ip === request.ip) return reply.code(400).send({ error: "Refusing to block the current admin IP" });
    const allowed = await prisma.guardianIpAllowlist.findFirst({ where: { cidr: body.ip, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
    if (allowed) return reply.code(409).send({ error: "IP is allowlisted" });
    const result = await sysagent.guardianBlockIp({ ip: body.ip, reason: body.reason });
    const block = await prisma.guardianIpBlock.create({
      data: {
        ip: body.ip,
        reason: body.reason ?? "Guardian manual block",
        score: 0,
        expiresAt: body.durationMinutes ? new Date(Date.now() + body.durationMinutes * 60_000) : null,
        result: result as any
      }
    });
    await audit(request, { action: "APPLY", resource: "guardian_ip_block", resourceId: block.id, description: `Blocked ${body.ip}`, metadata: { result } as any });
    return reply.code(202).send({ block, result });
  });

  app.post("/unblock-ip", async (request, reply) => {
    const body = ipActionSchema.parse(request.body);
    const result = await sysagent.guardianUnblockIp({ ip: body.ip, reason: body.reason });
    await prisma.guardianIpBlock.updateMany({ where: { ip: body.ip, status: "ACTIVE" }, data: { status: "REMOVED", removedAt: new Date() } });
    await audit(request, { action: "APPLY", resource: "guardian_ip_block", description: `Unblocked ${body.ip}`, metadata: { result } as any });
    return reply.code(202).send({ ip: body.ip, result });
  });

  app.post("/auto-heal", async (request, reply) => {
    const diagnosis = await sysagent.guardianDiagnosis() as GuardianDiagnosis;
    if (diagnosis.unavailable) return reply.code(503).send({ error: "Guardian diagnosis is unavailable" });
    await syncGuardianIncidentsOnly(diagnosis);
    const result = await runGuardianAutoHeal(diagnosis);
    await audit(request, {
      action: "APPLY",
      resource: "guardian",
      resourceId: "auto-heal",
      description: "Guardian safe auto-heal run",
      metadata: result as any
    });
    return reply.code(202).send({
      accepted: true,
      actions: result.actions,
      generatedAt: new Date().toISOString()
    });
  });
};
