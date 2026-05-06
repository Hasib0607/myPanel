import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const createDomainSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
  forceSsl: z.boolean().default(true)
});

const subdomainSchema = z.object({
  name: z.string().trim().toLowerCase(),
  target: z.string().min(1),
  sslEnabled: z.boolean().default(false)
});

const updateDomainSchema = z.object({
  forceSsl: z.boolean().optional(),
  sslEnabled: z.boolean().optional(),
  sslExpiry: z.coerce.date().nullable().optional()
});

function defaultRecords(domainId: string, domain: string) {
  return [
    { domainId, type: "A" as const, name: "@", value: env.VPS_IP },
    { domainId, type: "A" as const, name: "www", value: env.VPS_IP },
    { domainId, type: "MX" as const, name: "@", value: `mail.${domain}`, priority: 10 },
    { domainId, type: "A" as const, name: "mail", value: env.VPS_IP },
    { domainId, type: "TXT" as const, name: "@", value: `v=spf1 ip4:${env.VPS_IP} ~all` },
    { domainId, type: "TXT" as const, name: "_dmarc", value: `v=DMARC1; p=quarantine; rua=mailto:admin@${domain}` }
  ];
}

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (request) => {
    const query = z.object({
      search: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(50)
    }).parse(request.query);

    const where = query.search ? { name: { contains: query.search, mode: "insensitive" as const } } : {};
    const [items, total] = await Promise.all([
      prisma.domain.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { subdomains: true, dnsRecords: true, mailAccounts: true } } }
      }),
      prisma.domain.count({ where })
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  app.post("/", async (request, reply) => {
    const body = createDomainSchema.parse(request.body);
    let domain;
    try {
      domain = await prisma.$transaction(async (tx) => {
        const created = await tx.domain.create({ data: { name: body.name, forceSsl: body.forceSsl } });
        await tx.dnsRecord.createMany({ data: defaultRecords(created.id, created.name) });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "Domain already exists" });
      }
      throw error;
    }

    await redis.del("domain_list");
    await audit(request, { action: "CREATE", resource: "domain", resourceId: domain.id, description: `Created domain ${domain.name}` });
    return reply.code(201).send(domain);
  });

  app.get("/:domainId", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    return prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { subdomains: true, dnsRecords: true, mailAccounts: true, deployments: true }
    });
  });

  app.patch("/:domainId/status", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["ACTIVE", "PENDING", "SUSPENDED"]) }).parse(request.body);
    await redis.del("domain_list");
    return prisma.domain.update({ where: { id: domainId }, data: { status: body.status } });
  });

  app.patch("/:domainId", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = updateDomainSchema.parse(request.body);
    await redis.del("domain_list");
    return prisma.domain.update({ where: { id: domainId }, data: body });
  });

  app.get("/:domainId/health", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: {
        dnsRecords: true,
        mailAccounts: true,
        deployments: true
      }
    });

    const hasA = domain.dnsRecords.some((record) => record.type === "A" && (record.name === "@" || record.name === domain.name));
    const hasMx = domain.dnsRecords.some((record) => record.type === "MX");
    const hasSpf = domain.dnsRecords.some((record) => record.type === "TXT" && record.value.toLowerCase().includes("v=spf1"));
    const hasDmarc = domain.dnsRecords.some((record) => record.type === "TXT" && record.name.toLowerCase() === "_dmarc");

    return {
      domainId: domain.id,
      checks: [
        { key: "dns_a", label: "A record", ok: hasA, detail: hasA ? "Root A record exists" : "Root A record missing" },
        { key: "mail_mx", label: "MX record", ok: hasMx, detail: hasMx ? "Mail exchange configured" : "MX record missing" },
        { key: "mail_spf", label: "SPF record", ok: hasSpf, detail: hasSpf ? "SPF policy present" : "SPF TXT record missing" },
        { key: "mail_dmarc", label: "DMARC record", ok: hasDmarc, detail: hasDmarc ? "DMARC policy present" : "DMARC TXT record missing" },
        { key: "ssl", label: "SSL", ok: domain.sslEnabled, detail: domain.sslEnabled ? "SSL marked enabled" : "SSL not issued yet" },
        {
          key: "deployment",
          label: "Deployment",
          ok: domain.deployments.length > 0,
          detail: domain.deployments.length > 0 ? `Linked to ${domain.deployments[0].name}` : "No deployment linked"
        }
      ]
    };
  });

  app.delete("/:domainId", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ confirmName: z.string() }).parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    if (body.confirmName !== domain.name) {
      throw app.httpErrors.badRequest("Domain deletion requires exact domain name confirmation");
    }
    await prisma.domain.delete({ where: { id: domainId } });
    await redis.del("domain_list");
    await audit(request, { action: "DELETE", resource: "domain", resourceId: domainId, description: `Deleted domain ${domain.name}` });
    return { ok: true };
  });

  app.post("/:domainId/subdomains", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = subdomainSchema.parse(request.body);
    const subdomain = await prisma.subdomain.create({ data: { domainId, ...body } });
    return reply.code(201).send(subdomain);
  });
};
