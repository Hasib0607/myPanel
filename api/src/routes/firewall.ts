import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const ruleSchema = z.object({
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  direction: z.enum(["IN", "OUT"]).default("IN"),
  action: z.enum(["ALLOW", "DENY", "LIMIT"]),
  sourceIp: z.string().trim().min(1).optional(),
  note: z.string().optional()
});

const sshHardeningSchema = z.object({
  port: z.number().int().min(1).max(65535),
  permitRootLogin: z.boolean(),
  passwordAuthentication: z.boolean()
});

const presets = [
  { key: "http", port: 80, protocol: "tcp", action: "ALLOW", direction: "IN", note: "HTTP preset" },
  { key: "https", port: 443, protocol: "tcp", action: "ALLOW", direction: "IN", note: "HTTPS preset" },
  { key: "ssh-limit", port: 22, protocol: "tcp", action: "LIMIT", direction: "IN", note: "SSH rate limit preset" },
  { key: "smtp", port: 25, protocol: "tcp", action: "ALLOW", direction: "IN", note: "SMTP preset" },
  { key: "submission", port: 587, protocol: "tcp", action: "ALLOW", direction: "IN", note: "SMTP submission preset" },
  { key: "imaps", port: 993, protocol: "tcp", action: "ALLOW", direction: "IN", note: "IMAPS preset" },
  { key: "dns-tcp", port: 53, protocol: "tcp", action: "ALLOW", direction: "IN", note: "DNS TCP preset" },
  { key: "dns-udp", port: 53, protocol: "udp", action: "ALLOW", direction: "IN", note: "DNS UDP preset" }
] as const;

async function trySysagent<T>(fallback: T, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export const firewallRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/rules", async () => {
    const localRules = await prisma.firewallRule.findMany({ orderBy: { createdAt: "desc" } });
    const liveRules = await trySysagent({ unavailable: true }, () => sysagent.firewallRules());
    return { localRules, liveRules };
  });

  app.get("/overview", async () => {
    const localRules = await prisma.firewallRule.findMany({ orderBy: { createdAt: "desc" } });
    const [liveRules, status, security] = await Promise.all([
      trySysagent({ unavailable: true }, () => sysagent.firewallRules()),
      trySysagent({ unavailable: true }, () => sysagent.firewallStatus()),
      trySysagent({ unavailable: true }, () => sysagent.firewallSecurity())
    ]);
    return { localRules, liveRules, status, security, presets };
  });

  app.post("/rules", async (request, reply) => {
    const body = ruleSchema.parse(request.body);
    const rule = await prisma.firewallRule.create({ data: body });
    try {
      await sysagent.applyFirewallRule(body);
    } catch {
      app.log.warn("sysagent unavailable; rule saved but not applied live");
    }
    return reply.code(201).send(rule);
  });

  app.post("/presets/:key", async (request, reply) => {
    const { key } = z.object({ key: z.string() }).parse(request.params);
    const preset = presets.find((item) => item.key === key);
    if (!preset) return reply.notFound("Unknown firewall preset");
    const rule = await prisma.firewallRule.create({
      data: {
        port: preset.port,
        protocol: preset.protocol,
        direction: preset.direction,
        action: preset.action,
        note: preset.note
      }
    });
    try {
      await sysagent.applyFirewallRule(rule);
    } catch {
      app.log.warn("sysagent unavailable; preset saved but not applied live");
    }
    return reply.code(201).send(rule);
  });

  app.delete("/rules/:ruleId", async (request) => {
    const { ruleId } = z.object({ ruleId: z.string() }).parse(request.params);
    await prisma.firewallRule.delete({ where: { id: ruleId } });
    return { ok: true };
  });

  app.post("/enable", async (request, reply) => {
    const result = await trySysagent({ unavailable: true }, () => sysagent.enableFirewall());
    return reply.code(202).send(result);
  });

  app.post("/disable", async (request, reply) => {
    const result = await trySysagent({ unavailable: true }, () => sysagent.disableFirewall());
    return reply.code(202).send(result);
  });

  app.post("/ssh-hardening", async (request, reply) => {
    const body = sshHardeningSchema.parse(request.body);
    const result = await trySysagent({ unavailable: true }, () => sysagent.applySshHardening(body));
    return reply.code(202).send(result);
  });
};
