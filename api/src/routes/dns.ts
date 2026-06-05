import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { audit } from "../lib/audit.js";
import { sysagent } from "../lib/sysagent.js";
import { env } from "../config/env.js";
import { currentVpsIp } from "../lib/serverIp.js";

const ipv4Regex = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}|::1|::)$/;
const hostnameRegex = /^(\*|@|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?))*\.?$/i;

const dnsRecordBaseSchema = z.object({
  domainId: z.string(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]),
  name: z.string().min(1),
  value: z.string().min(1),
  ttl: z.number().int().min(60).default(3600),
  priority: z.number().int().min(0).nullable().optional()
});

const dnsRecordSchema = dnsRecordBaseSchema.superRefine((record, ctx) => validateRecord(record, ctx));
const dnsRecordPatchSchema = dnsRecordBaseSchema.omit({ domainId: true }).partial();
const nameServerBaseSchema = z.object({
  hostname: z.string().min(1).transform((value) => normalizeHostname(value)),
  ipv4: z.string().trim().optional().nullable(),
  ipv6: z.string().trim().optional().nullable(),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true)
});
const nameServerSchema = nameServerBaseSchema.superRefine((record, ctx) => {
  if (!hostnameRegex.test(record.hostname) || !record.hostname.includes(".")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hostname"], message: "Nameserver hostname must be a valid FQDN, like ns1.example.com" });
  }
  if (record.ipv4 && !ipv4Regex.test(record.ipv4)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ipv4"], message: "IPv4 must be a valid address" });
  }
  if (record.ipv6 && !ipv6Regex.test(record.ipv6)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ipv6"], message: "IPv6 must be a valid address" });
  }
  if (!record.ipv4 && !record.ipv6) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ipv4"], message: "Add at least one IPv4 or IPv6 address" });
  }
});
const nameServerPatchSchema = nameServerBaseSchema.partial();

type DnsRecordInput = z.infer<typeof dnsRecordBaseSchema>;

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function validateRecord(record: Pick<DnsRecordInput, "type" | "name" | "value" | "priority">, ctx: z.RefinementCtx) {
  if (!hostnameRegex.test(record.name)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "Record name must be @, *, or a valid hostname label" });
  }

  if (record.type === "A" && !ipv4Regex.test(record.value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "A records require a valid IPv4 address" });
  }

  if (record.type === "AAAA" && !ipv6Regex.test(record.value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "AAAA records require a valid IPv6 address" });
  }

  if (["CNAME", "MX", "NS"].includes(record.type) && !hostnameRegex.test(record.value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${record.type} value must be a hostname` });
  }

  if (record.type === "MX" && record.priority == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priority"], message: "MX records require priority" });
  }

  if (record.type !== "MX" && record.type !== "SRV" && record.priority != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priority"], message: "Priority is only valid for MX and SRV records" });
  }

  if (record.type === "CAA" && !/^\d+\s+(issue|issuewild|iodef)\s+["']?[^"']+["']?$/i.test(record.value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "CAA value should look like: 0 issue letsencrypt.org" });
  }
}

function fqdn(value: string, domain: string) {
  if (value === "@") return `${domain}.`;
  if (value.endsWith(".")) return value;
  if (value.includes(".")) return `${value}.`;
  return `${value}.${domain}.`;
}

export function renderZone(domain: string, records: Array<{ type: string; name: string; value: string; ttl: number; priority: number | null }>) {
  const serial = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "01";
  const nsRecords = records.filter((record) => record.type === "NS" && record.name === "@");
  const primaryNameServer = nsRecords[0]?.value ? fqdn(nsRecords[0].value, domain) : `ns1.${domain}.`;
  const lines = [
    `$ORIGIN ${domain}.`,
    "$TTL 3600",
    `@ IN SOA ${primaryNameServer} admin.${domain}. (`,
    `  ${serial} ; serial`,
    "  3600       ; refresh",
    "  900        ; retry",
    "  1209600    ; expire",
    "  3600       ; minimum",
    ")"
  ];
  if (nsRecords.length === 0) {
    lines.push(`@ IN NS ${primaryNameServer}`);
  }

  for (const record of records) {
    const name = record.name === "@" ? "@" : record.name;
    const ttl = record.ttl || 3600;
    if (record.type === "MX" || record.type === "SRV") {
      lines.push(`${name} ${ttl} IN ${record.type} ${record.priority ?? 10} ${fqdn(record.value, domain)}`);
    } else if (record.type === "TXT") {
      lines.push(`${name} ${ttl} IN TXT "${record.value.replaceAll("\"", "\\\"")}"`);
    } else if (["CNAME", "NS"].includes(record.type)) {
      lines.push(`${name} ${ttl} IN ${record.type} ${fqdn(record.value, domain)}`);
    } else {
      lines.push(`${name} ${ttl} IN ${record.type} ${record.value}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export const dnsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/nameservers", async () => {
    return prisma.nameServer.findMany({ orderBy: [{ sortOrder: "asc" }, { hostname: "asc" }] });
  });

  app.post("/nameservers/defaults", async (request, reply) => {
    const domain = await prisma.domain.findFirst({ orderBy: { createdAt: "asc" } });
    const baseDomain = domain?.name ?? "example.com";
    const vpsIp = await currentVpsIp();
    const defaults = [
      { hostname: `ns1.${baseDomain}`, ipv4: vpsIp, sortOrder: 10 },
      { hostname: `ns2.${baseDomain}`, ipv4: vpsIp, sortOrder: 20 }
    ];

    const records = [];
    for (const item of defaults) {
      records.push(await prisma.nameServer.upsert({
        where: { hostname: item.hostname },
        update: { ipv4: item.ipv4, sortOrder: item.sortOrder, active: true },
        create: { ...item, active: true }
      }));
    }

    await audit(request, { action: "CREATE", resource: "nameserver", description: "Created default nameservers", metadata: { hostnames: records.map((item) => item.hostname) } });
    return reply.code(201).send(records);
  });

  app.post("/nameservers", async (request, reply) => {
    const body = nameServerSchema.parse(request.body);
    const record = await prisma.nameServer.create({ data: body });
    await audit(request, { action: "CREATE", resource: "nameserver", resourceId: record.id, description: `Created nameserver ${record.hostname}` });
    return reply.code(201).send(record);
  });

  app.patch("/nameservers/:nameServerId", async (request) => {
    const { nameServerId } = z.object({ nameServerId: z.string() }).parse(request.params);
    const existing = await prisma.nameServer.findUniqueOrThrow({ where: { id: nameServerId } });
    const body = nameServerPatchSchema.parse(request.body);
    const merged = nameServerSchema.parse({ ...existing, ...body });
    const record = await prisma.nameServer.update({
      where: { id: nameServerId },
      data: merged
    });
    await audit(request, { action: "UPDATE", resource: "nameserver", resourceId: record.id, description: `Updated nameserver ${record.hostname}` });
    return record;
  });

  app.delete("/nameservers/:nameServerId", async (request) => {
    const { nameServerId } = z.object({ nameServerId: z.string() }).parse(request.params);
    const record = await prisma.nameServer.delete({ where: { id: nameServerId } });
    await audit(request, { action: "DELETE", resource: "nameserver", resourceId: record.id, description: `Deleted nameserver ${record.hostname}` });
    return { ok: true };
  });

  app.post("/nameservers/sync-records", async (request, reply) => {
    const [nameServers, domains] = await Promise.all([
      prisma.nameServer.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { hostname: "asc" }] }),
      prisma.domain.findMany({ select: { id: true, name: true } })
    ]);

    if (nameServers.length === 0) {
      return reply.code(400).send({ error: "Add at least one active nameserver first" });
    }

    let created = 0;
    let updated = 0;

    await prisma.$transaction(async (tx) => {
      for (const domain of domains) {
        for (const nameServer of nameServers) {
          const nsValue = `${nameServer.hostname}.`;
          const existingNs = await tx.dnsRecord.findFirst({
            where: { domainId: domain.id, type: "NS", name: "@", value: nsValue }
          });
          if (!existingNs) {
            await tx.dnsRecord.create({ data: { domainId: domain.id, type: "NS", name: "@", value: nsValue, ttl: 3600 } });
            created += 1;
          }

          if (nameServer.hostname.endsWith(`.${domain.name}`)) {
            const label = nameServer.hostname.slice(0, -(domain.name.length + 1));
            if (nameServer.ipv4) {
              const existingA = await tx.dnsRecord.findFirst({ where: { domainId: domain.id, type: "A", name: label } });
              if (existingA) {
                await tx.dnsRecord.update({ where: { id: existingA.id }, data: { value: nameServer.ipv4, ttl: 3600 } });
                updated += 1;
              } else {
                await tx.dnsRecord.create({ data: { domainId: domain.id, type: "A", name: label, value: nameServer.ipv4, ttl: 3600 } });
                created += 1;
              }
            }
            if (nameServer.ipv6) {
              const existingAaaa = await tx.dnsRecord.findFirst({ where: { domainId: domain.id, type: "AAAA", name: label } });
              if (existingAaaa) {
                await tx.dnsRecord.update({ where: { id: existingAaaa.id }, data: { value: nameServer.ipv6, ttl: 3600 } });
                updated += 1;
              } else {
                await tx.dnsRecord.create({ data: { domainId: domain.id, type: "AAAA", name: label, value: nameServer.ipv6, ttl: 3600 } });
                created += 1;
              }
            }
          }
        }
      }
    });

    await Promise.all(domains.map((domain) => redis.del(`dns_records:${domain.id}`)));
    const domainsWithRecords = await prisma.domain.findMany({
      include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
    });
    const appliedZones = await Promise.all(domainsWithRecords.map(async (domain) => {
      const zone = renderZone(domain.name, domain.dnsRecords);
      const result = await sysagent.applyDnsZone({ domain: domain.name, zone });
      return { domain: domain.name, result };
    }));
    await audit(request, {
      action: "APPLY",
      resource: "nameserver",
      description: "Synced nameservers into domain DNS records",
      metadata: { domains: domains.length, nameServers: nameServers.length, created, updated, applied: appliedZones.length }
    });
    return reply.code(202).send({ domains: domains.length, nameServers: nameServers.length, created, updated, applied: appliedZones.length });
  });

  app.get("/:domainId/records", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    return prisma.dnsRecord.findMany({ where: { domainId }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  });

  app.get("/:domainId/zone", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
    });
    return {
      domain: domain.name,
      serial: new Date().toISOString().slice(0, 10).replace(/-/g, "") + "01",
      zone: renderZone(domain.name, domain.dnsRecords)
    };
  });

  app.post("/:domainId/apply", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
    });
    const zone = renderZone(domain.name, domain.dnsRecords);
    const result = await sysagent.applyDnsZone({ domain: domain.name, zone });
    await audit(request, { action: "APPLY", resource: "dns", resourceId: domain.id, description: `Applied DNS zone for ${domain.name}`, metadata: { dryRunResult: result as any } });
    return reply.code(202).send({ domain: domain.name, zone, result });
  });

  app.post("/records", async (request, reply) => {
    const body = dnsRecordSchema.parse(request.body);
    const record = await prisma.dnsRecord.create({ data: body });
    await redis.del(`dns_records:${body.domainId}`);
    await audit(request, { action: "CREATE", resource: "dns_record", resourceId: record.id, description: `Created ${record.type} record ${record.name}` });
    return reply.code(201).send(record);
  });

  app.patch("/records/:recordId", async (request) => {
    const { recordId } = z.object({ recordId: z.string() }).parse(request.params);
    const existing = await prisma.dnsRecord.findUniqueOrThrow({ where: { id: recordId } });
    const body = dnsRecordPatchSchema.parse(request.body);
    const merged = dnsRecordSchema.parse({ ...existing, ...body });
    const record = await prisma.dnsRecord.update({
      where: { id: recordId },
      data: {
        type: merged.type,
        name: merged.name,
        value: merged.value,
        ttl: merged.ttl,
        priority: merged.priority
      }
    });
    await redis.del(`dns_records:${record.domainId}`);
    await audit(request, { action: "UPDATE", resource: "dns_record", resourceId: record.id, description: `Updated ${record.type} record ${record.name}` });
    return record;
  });

  app.delete("/records/:recordId", async (request) => {
    const { recordId } = z.object({ recordId: z.string() }).parse(request.params);
    const record = await prisma.dnsRecord.delete({ where: { id: recordId } });
    await redis.del(`dns_records:${record.domainId}`);
    await audit(request, { action: "DELETE", resource: "dns_record", resourceId: record.id, description: `Deleted ${record.type} record ${record.name}` });
    return { ok: true };
  });
};
