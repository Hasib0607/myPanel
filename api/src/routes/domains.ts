import dns from "node:dns/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { ensureDomainFileStructure, ensureSubdomainFileStructure, subdomainFolderName } from "../lib/domainFiles.js";
import { buildDeploymentNginxRequest, deploymentIsRoutable, publishPublicHtmlNginxVhost } from "../lib/deploymentDomainSsl.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { sysagent } from "../lib/sysagent.js";
import { renderZone } from "./dns.js";

export function normalizeDomainName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0]
    .replace(/\.$/, "");
}

const domainNameSchema = z.string().transform((value) => normalizeDomainName(value)).superRefine((value, ctx) => {
  const labels = value.split(".");
  const validLabels = labels.every((label, index) =>
    label === "*" && index === 0
      ? true
      : /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  );

  if (labels.length < 2 || value.length > 253 || !validLabels || !/^[a-z]{2,63}$/.test(labels[labels.length - 1] ?? "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid root domain, like example.com, or a wildcard subdomain like *.example.com" });
  }
});

const hostingModeSchema = z.enum(["PUBLIC_HTML", "DEPLOYMENT_PROXY", "REDIRECT"]);

const createDomainSchema = z.object({
  name: domainNameSchema,
  forceSsl: z.boolean().default(true),
  hostingMode: hostingModeSchema.default("PUBLIC_HTML"),
  documentRoot: z.string().trim().default("public_html"),
  redirectUrl: z.string().url().nullable().optional(),
  hostingDeploymentId: z.string().nullable().optional()
});

const bulkCreateDomainSchema = createDomainSchema.omit({ name: true }).extend({
  domains: z.array(domainNameSchema).min(1).max(250),
  skipExisting: z.boolean().default(true),
  publish: z.boolean().default(true)
});

const subdomainSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^(\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$/, "Enter a valid subdomain name, or * for a wildcard"),
  target: z.string().min(1),
  sslEnabled: z.boolean().default(false)
});

const updateDomainSchema = z.object({
  forceSsl: z.boolean().optional(),
  sslEnabled: z.boolean().optional(),
  sslExpiry: z.coerce.date().nullable().optional(),
  hostingMode: hostingModeSchema.optional(),
  documentRoot: z.string().trim().optional(),
  redirectUrl: z.string().url().nullable().optional(),
  hostingDeploymentId: z.string().nullable().optional()
});

type ActiveNameServer = {
  hostname: string;
  ipv4: string | null;
  ipv6: string | null;
};

function normalizeNameServer(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function nameserverMismatchMessage(domain: string, expected: string[], actual: string[]) {
  const expectedText = expected.length > 0 ? expected.join(", ") : "no active nameservers configured";
  const actualText = actual.length > 0 ? actual.join(", ") : "no public nameservers found";
  return `Before adding ${domain}, change its nameservers to this hosting nameserver: ${expectedText}. Current nameservers: ${actualText}.`;
}

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

async function resolveNameServersWithDoh(domain: string, errors: string[]) {
  const urls = env.DOMAIN_NAMESERVER_DOH_URLS.split(",").map((url) => url.trim()).filter(Boolean);

  for (const baseUrl of urls) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("name", domain);
      url.searchParams.set("type", "NS");
      const response = await fetch(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000)
      });
      const body = await response.json() as DnsJsonResponse;
      const records = (body.Answer ?? [])
        .filter((answer) => answer.type === 2 && answer.data)
        .map((answer) => normalizeNameServer(answer.data ?? ""));
      if (records.length > 0) return records.sort();
      errors.push(`${baseUrl}: status ${body.Status ?? response.status}`);
    } catch (error) {
      errors.push(`${baseUrl}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  }

  return [];
}

async function resolvePublicAddress(hostname: string, recordType: "A" | "AAAA") {
  const resolvers = env.DOMAIN_NAMESERVER_RESOLVERS.split(",").map((resolver) => resolver.trim()).filter(Boolean);

  for (const resolverAddress of resolvers) {
    const resolver = new dns.Resolver();
    resolver.setServers([resolverAddress]);
    try {
      const records = recordType === "A" ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname);
      if (records.length > 0) return records;
    } catch {
      // Try the next resolver.
    }
  }

  try {
    return recordType === "A" ? await dns.resolve4(hostname) : await dns.resolve6(hostname);
  } catch {
    return [];
  }
}

async function vanityNameserverGlueMatches(domain: string, nameServers: ActiveNameServer[]) {
  if (!env.ALLOW_VANITY_NAMESERVER_GLUE_FALLBACK) return false;

  const vanityNameServers = nameServers.filter((nameServer) => normalizeNameServer(nameServer.hostname).endsWith(`.${domain}`));
  if (vanityNameServers.length === 0) return false;

  for (const nameServer of vanityNameServers) {
    const hostname = normalizeNameServer(nameServer.hostname);
    if (nameServer.ipv4) {
      const records = await resolvePublicAddress(hostname, "A");
      if (!records.includes(nameServer.ipv4)) return false;
    }
    if (nameServer.ipv6) {
      const records = await resolvePublicAddress(hostname, "AAAA");
      if (!records.includes(nameServer.ipv6)) return false;
    }
  }

  return true;
}

function hasExpectedVanityNameServers(domain: string, nameServers: ActiveNameServer[]) {
  if (!env.ALLOW_PENDING_VANITY_NAMESERVER_DOMAINS) return false;
  const vanityNameServers = nameServers
    .map((nameServer) => normalizeNameServer(nameServer.hostname))
    .filter((hostname) => hostname.endsWith(`.${domain}`));
  return vanityNameServers.length > 0 && vanityNameServers.length === nameServers.length;
}

async function resolvePublicNameServers(domain: string) {
  const resolvers = env.DOMAIN_NAMESERVER_RESOLVERS.split(",").map((resolver) => resolver.trim()).filter(Boolean);
  const errors: string[] = [];

  for (const resolverAddress of resolvers) {
    const resolver = new dns.Resolver();
    resolver.setServers([resolverAddress]);
    try {
      const records = await resolver.resolveNs(domain);
      if (records.length > 0) {
        return records.map((nameServer) => normalizeNameServer(nameServer)).sort();
      }
    } catch (error) {
      errors.push(`${resolverAddress}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  }

  const dohRecords = await resolveNameServersWithDoh(domain, errors);
  if (dohRecords.length > 0) return dohRecords;

  try {
    const records = await dns.resolveNs(domain);
    if (records.length > 0) {
      return records.map((nameServer) => normalizeNameServer(nameServer)).sort();
    }
  } catch (error) {
    errors.push(`system: ${error instanceof Error ? error.message : "lookup failed"}`);
  }

  throw Object.assign(new Error(`No public nameservers found. Resolver checks: ${errors.join("; ") || "none"}`), { statusCode: 400 });
}

async function assertDomainUsesHostingNameServers(domain: string, nameServers: ActiveNameServer[]) {
  if (!env.REQUIRE_DOMAIN_NAMESERVER_MATCH) return;

  const expected = nameServers.map((nameServer) => normalizeNameServer(nameServer.hostname)).filter(Boolean);
  if (expected.length === 0) {
    throw Object.assign(new Error("Add at least one active hosting nameserver before adding domains."), { statusCode: 400 });
  }

  let actual: string[];
  try {
    actual = await resolvePublicNameServers(domain);
  } catch (error) {
    if (await vanityNameserverGlueMatches(domain, nameServers)) return;
    if (hasExpectedVanityNameServers(domain, nameServers)) return;
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw Object.assign(new Error(`${nameserverMismatchMessage(domain, expected, [])}${detail}`), { statusCode: 400 });
  }

  const actualSet = new Set(actual);
  const allExpectedPresent = expected.every((nameServer) => actualSet.has(nameServer));
  if (!allExpectedPresent && !(await vanityNameserverGlueMatches(domain, nameServers))) {
    throw Object.assign(new Error(nameserverMismatchMessage(domain, expected, actual)), { statusCode: 400 });
  }
}

async function domainNameserverPendingReason(domain: string, nameServers: ActiveNameServer[]) {
  try {
    await assertDomainUsesHostingNameServers(domain, nameServers);
    return null;
  } catch (error) {
    if (!env.ALLOW_PENDING_DOMAIN_NAMESERVER_MISMATCH) throw error;
    if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 400) {
      return error instanceof Error ? error.message : "Domain nameservers are not pointing to this server yet.";
    }
    throw error;
  }
}

export function defaultRecords(domainId: string, domain: string, nameServers: ActiveNameServer[] = []) {
  const records: Prisma.DnsRecordCreateManyInput[] = [
    { domainId, type: "A" as const, name: "@", value: env.VPS_IP },
    { domainId, type: "A" as const, name: "www", value: env.VPS_IP },
    { domainId, type: "MX" as const, name: "@", value: `mail.${domain}`, priority: 10 },
    { domainId, type: "A" as const, name: "mail", value: env.VPS_IP },
    { domainId, type: "TXT" as const, name: "@", value: `v=spf1 ip4:${env.VPS_IP} ~all` },
    { domainId, type: "TXT" as const, name: "_dmarc", value: `v=DMARC1; p=quarantine; rua=mailto:admin@${domain}` }
  ];

  for (const nameServer of nameServers) {
    const hostname = nameServer.hostname.replace(/\.$/, "");
    records.push({ domainId, type: "NS" as const, name: "@", value: `${hostname}.` });

    if (hostname.endsWith(`.${domain}`)) {
      const label = hostname.slice(0, -(domain.length + 1));
      if (label && nameServer.ipv4) {
        records.push({ domainId, type: "A" as const, name: label, value: nameServer.ipv4 });
      }
      if (label && nameServer.ipv6) {
        records.push({ domainId, type: "AAAA" as const, name: label, value: nameServer.ipv6 });
      }
    }
  }

  return records;
}

function domainInclude() {
  return {
    _count: { select: { subdomains: true, dnsRecords: true, mailAccounts: true } }
  };
}

function clearDomainCaches(domainId?: string) {
  const keys = ["domain_list"];
  if (domainId) keys.push(`dns_records:${domainId}`);
  return redis.del(...keys);
}

function zodIssueMessage(error: z.ZodError) {
  return error.issues[0]?.message ?? "Validation failed";
}

function normalizeDocumentRoot(value?: string | null) {
  const root = (value || "public_html").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!root || root.includes("..") || path.isAbsolute(root)) {
    throw Object.assign(new Error("Document root must be a folder inside the domain root."), { statusCode: 400 });
  }
  return root;
}

function normalizeRedirectUrl(value?: string | null) {
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

async function validateHostingSettings(input: {
  hostingMode?: "PUBLIC_HTML" | "DEPLOYMENT_PROXY" | "REDIRECT";
  hostingDeploymentId?: string | null;
  redirectUrl?: string | null;
}) {
  if (input.hostingMode === "DEPLOYMENT_PROXY") {
    if (!input.hostingDeploymentId) {
      throw Object.assign(new Error("Select a deployment before using deployment proxy hosting."), { statusCode: 400 });
    }
    await prisma.deployment.findUniqueOrThrow({ where: { id: input.hostingDeploymentId } });
  }

  if (input.hostingMode === "REDIRECT" && !input.redirectUrl) {
    throw Object.assign(new Error("Set a redirect URL before using redirect hosting."), { statusCode: 400 });
  }
}

function parseCreateDomain(body: unknown) {
  try {
    return createDomainSchema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw Object.assign(new Error(zodIssueMessage(error)), { statusCode: 400 });
    }
    throw error;
  }
}

function parseBulkCreateDomains(body: unknown) {
  try {
    return bulkCreateDomainSchema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw Object.assign(new Error(zodIssueMessage(error)), { statusCode: 400 });
    }
    throw error;
  }
}

async function publishDomainHosting(domainId: string) {
  const domain = await prisma.domain.findUniqueOrThrow({
    where: { id: domainId },
    include: {
      dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] },
      subdomains: { orderBy: { name: "asc" } }
    }
  });
  const fileScaffold = await ensureDomainFileStructure(domain.name);
  const zone = renderZone(domain.name, domain.dnsRecords);
  const dnsResult = await sysagent.applyDnsZone({ domain: domain.name, zone });

  let nginxResult;
  if (domain.hostingMode === "DEPLOYMENT_PROXY") {
    const deployment = domain.hostingDeploymentId
      ? await prisma.deployment.findUnique({ where: { id: domain.hostingDeploymentId } })
      : await prisma.deployment.findFirst({
          where: {
            OR: [
              { domainId: domain.id },
              { domainBindings: { some: { domainId: domain.id } } }
            ]
          },
          orderBy: { createdAt: "desc" }
        });
    if (deployment && deploymentIsRoutable(deployment)) {
      nginxResult = await sysagent.deploymentNginx(
        buildDeploymentNginxRequest({
          deploymentId: deployment.id,
          fqdn: `${domain.name} www.${domain.name}`,
          upstreamPort: deployment.port,
          rootPath: deployment.rootPath,
          framework: deployment.framework,
          startCommand: deployment.startCommand,
          publicDirectory: deployment.publicDirectory,
          outputDirectory: deployment.outputDirectory,
          fallbackRootPath: path.join(env.FILE_MANAGER_ROOT, domain.name, normalizeDocumentRoot(domain.documentRoot)),
          forceSsl: domain.forceSsl && domain.sslEnabled
        })
      );
    } else {
      nginxResult = await publishPublicHtmlNginxVhost({
        id: domain.id,
        name: domain.name,
        forceSsl: domain.forceSsl,
        sslEnabled: domain.sslEnabled,
        documentRoot: domain.documentRoot
      });
    }
  } else if (domain.hostingMode === "REDIRECT") {
    if (!domain.redirectUrl) throw Object.assign(new Error("Set a redirect URL before publishing redirect hosting."), { statusCode: 400 });
    nginxResult = await sysagent.writeRedirectNginxVhost({
      name: `domain-${domain.name}`,
      serverName: `${domain.name} www.${domain.name}`,
      redirectUrl: normalizeRedirectUrl(domain.redirectUrl)
    });
  } else {
    const documentRoot = normalizeDocumentRoot(domain.documentRoot);
    nginxResult = await sysagent.writeStaticNginxVhost({
      name: `domain-${domain.name}`,
      serverName: `${domain.name} www.${domain.name}`,
      rootPath: path.join(env.FILE_MANAGER_ROOT, domain.name, documentRoot),
      forceHttps: domain.forceSsl && domain.sslEnabled,
      ...(domain.sslEnabled
        ? {
            sslCertificate: `/etc/letsencrypt/live/${domain.name}/fullchain.pem`,
            sslCertificateKey: `/etc/letsencrypt/live/${domain.name}/privkey.pem`
          }
        : {})
    });
  }
  const subdomainVhosts: Array<{ fqdn: string; result: unknown } | { fqdn: string; error: string }> = [];
  for (const subdomain of domain.subdomains) {
    const fqdn = `${subdomain.name}.${domain.name}`;
    const targetIsLocal = subdomain.target === env.VPS_IP || subdomain.target === domain.name || subdomain.target === fqdn;
    if (!targetIsLocal) continue;
    const scaffold = await ensureSubdomainFileStructure(domain.name, subdomain.name);
    try {
      const result = await sysagent.writeStaticNginxVhost({
        name: `domain-${nginxResourceName(fqdn)}`,
        serverName: fqdn,
        rootPath: path.join(env.FILE_MANAGER_ROOT, scaffold.relativeRoot),
        forceHttps: false
      });
      subdomainVhosts.push({ fqdn, result });
    } catch (error) {
      subdomainVhosts.push({ fqdn, error: error instanceof Error ? error.message : "Subdomain web root publish failed" });
    }
  }

  return { domain, fileScaffold, zone, dnsResult, nginxResult, subdomainVhosts };
}

type CreateDomainInput = z.infer<typeof createDomainSchema>;

async function createDomainWithDefaults(input: CreateDomainInput, nameServers: ActiveNameServer[]) {
  const documentRoot = normalizeDocumentRoot(input.documentRoot);
  const redirectUrl = normalizeRedirectUrl(input.redirectUrl);
  await validateHostingSettings({ ...input, redirectUrl });
  const pendingReason = await domainNameserverPendingReason(input.name, nameServers);

  return prisma.$transaction(async (tx) => {
    const created = await tx.domain.create({
      data: {
        name: input.name,
        status: pendingReason ? "PENDING" : "ACTIVE",
        forceSsl: input.forceSsl,
        hostingMode: input.hostingMode,
        documentRoot,
        redirectUrl,
        hostingDeploymentId: input.hostingDeploymentId ?? null
      }
    });
    await tx.dnsRecord.createMany({ data: defaultRecords(created.id, created.name, nameServers), skipDuplicates: true });
    return tx.domain.findUniqueOrThrow({ where: { id: created.id }, include: domainInclude() });
  });
}

async function getActiveNameServers() {
  return prisma.nameServer.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { hostname: "asc" }],
    select: { hostname: true, ipv4: true, ipv6: true }
  });
}

async function findManagedParentDomain(name: string) {
  const labels = name.split(".");
  if (labels.length <= 2) return null;

  for (let index = 1; index < labels.length - 1; index += 1) {
    const parentName = labels.slice(index).join(".");
    const parent = await prisma.domain.findUnique({ where: { name: parentName }, include: domainInclude() });
    if (parent) {
      return {
        parent,
        subdomainName: labels.slice(0, index).join(".")
      };
    }
  }

  return null;
}

function dnsRecordTypeForTarget(target: string) {
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(target)) return "A" as const;
  if (target.includes(":")) return "AAAA" as const;
  return "CNAME" as const;
}

function nginxResourceName(value: string) {
  return value.replace(/^\*\./, "wildcard.").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function createSubdomainForDomain(input: {
  domainId: string;
  name: string;
  target: string;
  sslEnabled?: boolean;
}) {
  const recordType = dnsRecordTypeForTarget(input.target);
  const subdomain = await prisma.subdomain.create({
    data: {
      domainId: input.domainId,
      name: input.name,
      target: input.target,
      sslEnabled: input.sslEnabled ?? false
    }
  });

  const existingRecord = await prisma.dnsRecord.findFirst({
    where: {
      domainId: input.domainId,
      type: recordType,
      name: input.name,
      value: input.target
    }
  });
  if (!existingRecord) {
    await prisma.dnsRecord.create({
      data: {
        domainId: input.domainId,
        type: recordType,
        name: input.name,
        value: input.target
      }
    });
  }

  const parentDomain = await prisma.domain.findUniqueOrThrow({ where: { id: input.domainId } });
  const fileScaffold = await ensureSubdomainFileStructure(parentDomain.name, input.name);
  let nginxResult = null;
  let nginxWarning: string | undefined;
  try {
    if (input.target === env.VPS_IP || input.target === parentDomain.name || input.target === `${input.name}.${parentDomain.name}`) {
      const fqdn = `${input.name}.${parentDomain.name}`;
      nginxResult = await sysagent.writeStaticNginxVhost({
        name: `domain-${nginxResourceName(fqdn)}`,
        serverName: fqdn,
        rootPath: path.join(env.FILE_MANAGER_ROOT, fileScaffold.relativeRoot),
        forceHttps: false
      });
    }
  } catch (error) {
    nginxWarning = error instanceof Error ? error.message : "Subdomain web root publish failed";
  }

  let publishResult: Awaited<ReturnType<typeof publishDomainHosting>> | null = null;
  let publishWarning: string | undefined;
  try {
    publishResult = await publishDomainHosting(input.domainId);
  } catch (error) {
    publishWarning = error instanceof Error ? error.message : "Subdomain DNS publish failed";
  }
  await clearDomainCaches(input.domainId);

  return {
    subdomain,
    dnsRecord: {
      type: recordType,
      name: input.name,
      value: input.target
    },
    fileScaffold,
    nginxResult,
    nginxWarning,
    publishResult,
    publishWarning
  };
}

async function createSubdomainShortcut(fqdnName: string) {
  const managedParent = await findManagedParentDomain(fqdnName);
  if (!managedParent) return null;

  const created = await createSubdomainForDomain({
    domainId: managedParent.parent.id,
    name: managedParent.subdomainName,
    target: env.VPS_IP,
    sslEnabled: false
  });

  return {
    kind: "subdomain" as const,
    name: fqdnName,
    parentDomain: managedParent.parent,
    subdomain: created.subdomain,
    dnsRecord: created.dnsRecord,
    publishResult: created.publishResult,
    publishWarning: created.publishWarning
  };
}

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (request) => {
    const query = z.object({
      search: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(50)
    }).parse(request.query);

    const subdomainSearch = query.search?.split(".")[0];
    const where = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" as const } },
            ...(subdomainSearch ? [{ subdomains: { some: { name: { contains: subdomainSearch, mode: "insensitive" as const } } } }] : [])
          ]
        }
      : {};
    const [items, total] = await Promise.all([
      prisma.domain.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          _count: { select: { subdomains: true, dnsRecords: true, mailAccounts: true } },
          subdomains: { orderBy: { name: "asc" } }
        }
      }),
      prisma.domain.count({ where })
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  app.post("/", async (request, reply) => {
    const body = parseCreateDomain(request.body);
    const subdomainShortcut = await createSubdomainShortcut(body.name).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw Object.assign(new Error("Subdomain already exists"), { statusCode: 409 });
      }
      throw error;
    });
    if (!subdomainShortcut && body.name.startsWith("*.")) {
      throw Object.assign(new Error(`Add the parent domain ${body.name.slice(2)} before creating wildcard subdomain ${body.name}.`), { statusCode: 400 });
    }
    if (subdomainShortcut) {
      await audit(request, {
        action: "CREATE",
        resource: "subdomain",
        resourceId: subdomainShortcut.subdomain.id,
        description: `Created subdomain ${subdomainShortcut.name}`,
          metadata: JSON.parse(JSON.stringify({
            parentDomainId: subdomainShortcut.parentDomain.id,
            dnsRecord: subdomainShortcut.dnsRecord,
            publishWarning: subdomainShortcut.publishWarning
          })) as Prisma.InputJsonValue
        });
      return reply.code(201).send(subdomainShortcut);
    }

    let domain;
    try {
      domain = await createDomainWithDefaults(body, await getActiveNameServers());
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "Domain already exists" });
      }
      throw error;
    }

    const fileScaffold = await ensureDomainFileStructure(domain.name);
    let publishResult: Awaited<ReturnType<typeof publishDomainHosting>> | null = null;
    try {
      publishResult = await publishDomainHosting(domain.id);
    } catch (error) {
      app.log.warn({ error, domain: domain.name }, "domain hosting publish failed");
    }

    await clearDomainCaches(domain.id);
    await audit(request, {
      action: "CREATE",
      resource: "domain",
      resourceId: domain.id,
      description: `Created domain ${domain.name}`,
      metadata: JSON.parse(JSON.stringify({ fileScaffold, publish: publishResult })) as Prisma.InputJsonValue
    });
    return reply.code(201).send(domain);
  });

  app.post("/bulk", async (request, reply) => {
    const body = parseBulkCreateDomains(request.body);
    const uniqueDomains = [...new Set(body.domains)];
    const nameServers = await getActiveNameServers();
    const results: Array<{
      input: string;
      name: string;
      status: "created" | "skipped" | "failed";
      kind?: "domain" | "subdomain";
      domain?: Awaited<ReturnType<typeof createDomainWithDefaults>>;
      subdomain?: Awaited<ReturnType<typeof createSubdomainShortcut>>;
      error?: string;
      publishWarning?: string;
    }> = [];

    for (const name of uniqueDomains) {
      try {
        const subdomainShortcut = await createSubdomainShortcut(name);
        if (subdomainShortcut) {
          await audit(request, {
            action: "CREATE",
            resource: "subdomain",
            resourceId: subdomainShortcut.subdomain.id,
            description: `Created subdomain ${subdomainShortcut.name} from bulk add`,
            metadata: JSON.parse(JSON.stringify({
              parentDomainId: subdomainShortcut.parentDomain.id,
              dnsRecord: subdomainShortcut.dnsRecord,
              publishWarning: subdomainShortcut.publishWarning
            })) as Prisma.InputJsonValue
          });
          results.push({ input: name, name: subdomainShortcut.name, status: "created", kind: "subdomain", subdomain: subdomainShortcut });
          continue;
        }
        if (name.startsWith("*.")) {
          results.push({ input: name, name, status: "failed", error: `Add the parent domain ${name.slice(2)} before creating this wildcard subdomain.` });
          continue;
        }

        const existing = await prisma.domain.findUnique({ where: { name }, include: domainInclude() });
        if (existing && body.skipExisting) {
          results.push({ input: name, name, status: "skipped", kind: "domain", domain: existing });
          continue;
        }

        const domain = await createDomainWithDefaults({ ...body, name }, nameServers);
        const fileScaffold = await ensureDomainFileStructure(domain.name);
        let publishResult: Awaited<ReturnType<typeof publishDomainHosting>> | null = null;
        let publishWarning: string | undefined;
        if (body.publish) {
          try {
            publishResult = await publishDomainHosting(domain.id);
          } catch (error) {
            publishWarning = error instanceof Error ? error.message : "Domain hosting publish failed";
            app.log.warn({ error, domain: domain.name }, "bulk domain hosting publish failed");
          }
        }
        await clearDomainCaches(domain.id);
        await audit(request, {
          action: "CREATE",
          resource: "domain",
          resourceId: domain.id,
          description: `Created domain ${domain.name} from bulk add`,
          metadata: JSON.parse(JSON.stringify({ fileScaffold, publish: publishResult, publishWarning })) as Prisma.InputJsonValue
        });
        results.push({ input: name, name: domain.name, status: "created", kind: "domain", domain, publishWarning });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && body.skipExisting) {
          results.push({ input: name, name, status: "skipped", error: "Domain already exists" });
          continue;
        }
        results.push({
          input: name,
          name,
          status: "failed",
          error: error instanceof Error ? error.message : "Could not add domain"
        });
      }
    }

    const summary = {
      created: results.filter((result) => result.status === "created").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length
    };

    await clearDomainCaches();
    await audit(request, {
      action: "CREATE",
      resource: "domain",
      description: `Bulk domain add: ${summary.created} created, ${summary.skipped} skipped, ${summary.failed} failed`,
      metadata: JSON.parse(JSON.stringify({ summary, domains: uniqueDomains })) as Prisma.InputJsonValue
    });

    return reply.code(summary.failed > 0 ? 207 : 201).send({ ...summary, total: results.length, results });
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
    const domain = await prisma.domain.update({ where: { id: domainId }, data: { status: body.status }, include: domainInclude() });
    await clearDomainCaches(domainId);
    await audit(request, { action: "UPDATE", resource: "domain", resourceId: domainId, description: `Updated ${domain.name} status to ${body.status}` });
    return domain;
  });

  app.patch("/:domainId", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = updateDomainSchema.parse(request.body);
    const existing = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const nextHostingMode = body.hostingMode ?? existing.hostingMode;
    const nextRedirectUrl = normalizeRedirectUrl(body.redirectUrl === undefined ? existing.redirectUrl : body.redirectUrl);
    const nextHostingDeploymentId = body.hostingDeploymentId === undefined ? existing.hostingDeploymentId : body.hostingDeploymentId;
    const data = {
      ...body,
      ...(body.documentRoot !== undefined ? { documentRoot: normalizeDocumentRoot(body.documentRoot) } : {}),
      ...(body.redirectUrl !== undefined ? { redirectUrl: nextRedirectUrl } : {})
    };
    await validateHostingSettings({
      hostingMode: nextHostingMode,
      hostingDeploymentId: nextHostingDeploymentId,
      redirectUrl: nextRedirectUrl
    });
    const domain = await prisma.domain.update({ where: { id: domainId }, data, include: domainInclude() });
    if (
      body.hostingMode !== undefined ||
      body.documentRoot !== undefined ||
      body.redirectUrl !== undefined ||
      body.hostingDeploymentId !== undefined ||
      typeof body.forceSsl === "boolean" ||
      typeof body.sslEnabled === "boolean"
    ) {
      await publishDomainHosting(domain.id);
    }
    await clearDomainCaches(domainId);
    await audit(request, { action: "UPDATE", resource: "domain", resourceId: domainId, description: `Updated domain ${domain.name}` });
    return domain;
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
          key: "hosting",
          label: "Hosting",
          ok: domain.hostingMode === "PUBLIC_HTML" || Boolean(domain.redirectUrl || domain.hostingDeploymentId || domain.deployments.length),
          detail: domain.hostingMode === "PUBLIC_HTML"
            ? `${domain.documentRoot} website root`
            : domain.hostingMode === "REDIRECT"
              ? domain.redirectUrl ? `Redirects to ${domain.redirectUrl}` : "Redirect URL missing"
              : domain.hostingDeploymentId || domain.deployments.length > 0 ? "Deployment proxy configured" : "Deployment proxy missing"
        }
      ]
    };
  });

  app.post("/:domainId/publish", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const publish = await publishDomainHosting(domainId);
    await clearDomainCaches(domainId);
    await audit(request, {
      action: "APPLY",
      resource: "domain",
      resourceId: domainId,
      description: `Published DNS and website hosting for ${publish.domain.name}`,
      metadata: JSON.parse(JSON.stringify({ dnsResult: publish.dnsResult, nginxResult: publish.nginxResult, fileScaffold: publish.fileScaffold })) as Prisma.InputJsonValue
    });
    return reply.code(202).send(publish);
  });

  app.delete("/:domainId", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ confirmName: z.string() }).parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    if (body.confirmName !== domain.name) {
      throw app.httpErrors.badRequest("Domain deletion requires exact domain name confirmation");
    }
    await prisma.domain.delete({ where: { id: domainId } });
    await clearDomainCaches(domainId);
    await audit(request, { action: "DELETE", resource: "domain", resourceId: domainId, description: `Deleted domain ${domain.name}` });
    return { ok: true };
  });

  app.post("/:domainId/subdomains", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = subdomainSchema.parse(request.body);
    const created = await createSubdomainForDomain({ domainId, ...body });
    await audit(request, {
      action: "CREATE",
      resource: "subdomain",
      resourceId: created.subdomain.id,
      description: `Created subdomain ${body.name}`,
      metadata: JSON.parse(JSON.stringify({ dnsRecord: created.dnsRecord, publishWarning: created.publishWarning })) as Prisma.InputJsonValue
    });
    return reply.code(201).send(created);
  });

  app.delete("/:domainId/subdomains/:subdomainId", async (request) => {
    const { domainId, subdomainId } = z.object({ domainId: z.string(), subdomainId: z.string() }).parse(request.params);
    const subdomain = await prisma.subdomain.findFirstOrThrow({ where: { id: subdomainId, domainId } });

    await prisma.$transaction(async (tx) => {
      await tx.subdomain.delete({ where: { id: subdomain.id } });
      const recordType = dnsRecordTypeForTarget(subdomain.target);
      await tx.dnsRecord.deleteMany({
        where: {
          domainId,
          type: recordType,
          name: subdomain.name,
          value: subdomain.target
        }
      });
    });

    let publishWarning: string | undefined;
    try {
      await publishDomainHosting(domainId);
    } catch (error) {
      publishWarning = error instanceof Error ? error.message : "Subdomain DNS publish failed";
    }

    await clearDomainCaches(domainId);
    await audit(request, {
      action: "DELETE",
      resource: "subdomain",
      resourceId: subdomain.id,
      description: `Deleted subdomain ${subdomain.name}`,
      metadata: publishWarning ? ({ publishWarning } as Prisma.InputJsonValue) : undefined
    });
    return { ok: true, publishWarning };
  });
};
