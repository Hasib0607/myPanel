import { createHash } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { env } from "../config/env.js";
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
const fileActionSchema = z.object({ id: z.string().min(1) });
const settingsSchema = z.object({
  autoBlockMode: z.enum(["monitor", "suggest", "auto"]),
  blockDurationMinutes: z.number().int().min(5).max(43_200)
});

const trustedCidrs = env.GUARDIAN_TRUSTED_CIDRS.split(",").map((item) => item.trim()).filter(Boolean);

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
  return [...allowlist.map((item) => item.cidr), ...trustedCidrs].some((cidr) => ipMatchesCidr(ip, cidr));
}

function ipv4ToInt(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv6ToBigInt(ip: string) {
  if (net.isIP(ip) !== 6) return null;
  const [headText, tailText = ""] = ip.split("::");
  const head = headText ? headText.split(":") : [];
  const tail = tailText ? tailText.split(":") : [];
  const fill = new Array(8 - head.length - tail.length).fill("0");
  const parts = [...head, ...fill, ...tail].map((part) => Number.parseInt(part || "0", 16));
  if (parts.length !== 8 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 0xffff)) return null;
  return parts.reduce((acc, part) => (acc << 16n) + BigInt(part), 0n);
}

function ipMatchesCidr(ip: string, cidr: string) {
  if (cidr === ip) return true;
  const [range, bitsText] = cidr.split("/");
  if (!range || !bitsText) return false;
  const bits = Number(bitsText);
  if (net.isIP(ip) === 4 && net.isIP(range) === 4) {
    const ipInt = ipv4ToInt(ip);
    const rangeInt = ipv4ToInt(range);
    if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
  }
  if (net.isIP(ip) === 6 && net.isIP(range) === 6) {
    const ipInt = ipv6ToBigInt(ip);
    const rangeInt = ipv6ToBigInt(range);
    if (ipInt === null || rangeInt === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
    const shift = BigInt(128 - bits);
    return (ipInt >> shift) === (rangeInt >> shift);
  }
  return false;
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

async function loginAnomalies() {
  const since = new Date(Date.now() - 60 * 60_000);
  const rows = await prisma.auditLog.findMany({
    where: { action: "LOGIN", resource: "auth", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 200
  });
  const failuresByIp = new Map<string, number>();
  const usersByIp = new Map<string, Set<string>>();
  for (const row of rows) {
    const metadata = row.metadata as any;
    if (metadata?.success !== false || !row.ipAddress) continue;
    failuresByIp.set(row.ipAddress, (failuresByIp.get(row.ipAddress) ?? 0) + 1);
    const username = typeof metadata.username === "string" ? metadata.username : "2fa";
    usersByIp.set(row.ipAddress, (usersByIp.get(row.ipAddress) ?? new Set()).add(username));
  }
  return [...failuresByIp.entries()]
    .map(([ip, failures]) => ({ ip, failures, usernames: usersByIp.get(ip)?.size ?? 0, risk: failures >= 5 || (usersByIp.get(ip)?.size ?? 0) >= 3 ? "high" : "medium" }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 20);
}

async function syncCloudflareCidrs() {
  const [v4, v6] = await Promise.all([
    fetch("https://www.cloudflare.com/ips-v4").then((response) => response.text()),
    fetch("https://www.cloudflare.com/ips-v6").then((response) => response.text())
  ]);
  const cidrs = [...v4.split(/\s+/), ...v6.split(/\s+/)].map((item) => item.trim()).filter(Boolean);
  for (const cidr of cidrs) {
    await prisma.guardianIpAllowlist.upsert({
      where: { cidr },
      update: { label: "Cloudflare CDN" },
      create: { cidr, label: "Cloudflare CDN" }
    });
  }
  return { count: cidrs.length, cidrs };
}

async function ipContext(ip: string) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(`https://rdap.org/ip/${encodeURIComponent(ip)}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json() as any;
    return {
      name: data.name ?? null,
      country: data.country ?? null,
      handle: data.handle ?? null,
      type: data.type ?? null
    };
  } catch {
    return null;
  }
}

export const guardianRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/overview", async () => {
    const [diagnosis, deployments, sslDomains, recentActions, storedIncidents, allowlist, activeBlocks, fileFindings, anomalies, securitySetting] = await Promise.all([
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
      prisma.guardianFileFinding.findMany({ where: { status: "OPEN" }, orderBy: [{ risk: "desc" }, { lastSeenAt: "desc" }], take: 50 }),
      loginAnomalies(),
      prisma.guardianSetting.findUnique({ where: { key: "security" } })
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
        trustedCidrs,
        activeBlocks,
        loginAnomalies: anomalies,
        settings: (securitySetting?.value as any) ?? { autoBlockMode: "suggest", blockDurationMinutes: 60 },
        suspiciousIps: await Promise.all(((diagnosis as any).security?.suspiciousIps ?? []).map(async (item: any) => ({
          ...item,
          context: await ipContext(item.ip),
          allowlisted: isAllowlisted(item.ip, allowlist),
          blocked: activeBlocks.some((block) => block.ip === item.ip)
        })))
      },
      fileFindings,
      notifications: await prisma.guardianNotification.findMany({ where: { read: false }, orderBy: { createdAt: "desc" }, take: 20 }),
      generatedAt: new Date().toISOString()
    };
  });

  app.post("/settings/security", async (request) => {
    const body = settingsSchema.parse(request.body);
    return prisma.guardianSetting.upsert({
      where: { key: "security" },
      update: { value: body },
      create: { key: "security", value: body }
    });
  });

  app.post("/cloudflare/sync", async (request) => {
    const result = await syncCloudflareCidrs();
    await audit(request, { action: "APPLY", resource: "guardian_allowlist", description: `Synced ${result.count} Cloudflare CIDRs` });
    return result;
  });

  app.get("/ip/:ip/evidence", async (request) => {
    const { ip } = z.object({ ip: z.string() }).parse(request.params);
    return sysagent.guardianIpEvidence(ip);
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
    const allowlist = await prisma.guardianIpAllowlist.findMany({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
    if (isAllowlisted(body.ip, allowlist)) return reply.code(409).send({ error: "IP is allowlisted or trusted" });
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
    await prisma.guardianNotification.create({ data: { level: "WARNING", title: `Blocked ${body.ip}`, message: body.reason ?? "Guardian IP block", metadata: { blockId: block.id } as any } });
    return reply.code(202).send({ block, result });
  });

  app.post("/unblock-ip", async (request, reply) => {
    const body = ipActionSchema.parse(request.body);
    const result = await sysagent.guardianUnblockIp({ ip: body.ip, reason: body.reason });
    await prisma.guardianIpBlock.updateMany({ where: { ip: body.ip, status: "ACTIVE" }, data: { status: "REMOVED", removedAt: new Date() } });
    await audit(request, { action: "APPLY", resource: "guardian_ip_block", description: `Unblocked ${body.ip}`, metadata: { result } as any });
    return reply.code(202).send({ ip: body.ip, result });
  });

  app.post("/file-watch/:id/trust", async (request) => {
    const { id } = fileActionSchema.parse(request.params);
    const finding = await prisma.guardianFileFinding.update({ where: { id }, data: { status: "TRUSTED" } });
    await audit(request, { action: "APPLY", resource: "guardian_file_finding", resourceId: id, description: `Trusted ${finding.path}` });
    return finding;
  });

  app.post("/file-watch/:id/quarantine", async (request, reply) => {
    const { id } = fileActionSchema.parse(request.params);
    const finding = await prisma.guardianFileFinding.findUnique({ where: { id } });
    if (!finding) return reply.notFound("File finding not found");
    const result = await sysagent.guardianQuarantineFile(finding.path);
    const updated = await prisma.guardianFileFinding.update({ where: { id }, data: { status: "RESOLVED", metadata: { quarantine: result } as any } });
    await prisma.guardianNotification.create({ data: { level: "CRITICAL", title: "File quarantined", message: finding.path, metadata: { result } as any } });
    await audit(request, { action: "APPLY", resource: "guardian_file_finding", resourceId: id, description: `Quarantined ${finding.path}`, metadata: { result } as any });
    return reply.code(202).send({ finding: updated, result });
  });

  app.get("/rate-limit/templates", async () => sysagent.guardianRateLimitTemplates());

  app.post("/rate-limit/apply", async (request, reply) => {
    const body = z.object({ mode: z.enum(["balanced", "strict"]) }).parse(request.body);
    const result = await sysagent.guardianApplyRateLimit(body.mode);
    await audit(request, { action: "APPLY", resource: "guardian_rate_limit", resourceId: body.mode, description: `Applied Guardian ${body.mode} rate-limit template`, metadata: { result } as any });
    return reply.code(202).send(result);
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
