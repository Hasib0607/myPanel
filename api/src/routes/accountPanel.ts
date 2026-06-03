import bcrypt from "bcrypt";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeploymentFramework, Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deployQueue, sslQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";
import { defaultRecords } from "./domains.js";
import { renderZone } from "./dns.js";

function accountId(request: any) {
  return request.user.accountId as string;
}

function safeAccount(account: any) {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
}

function normalizeDomainName(value: string) {
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
  const validLabels = labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  if (labels.length < 2 || value.length > 253 || !validLabels || !/^[a-z]{2,63}$/.test(labels[labels.length - 1] ?? "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid root domain, like example.com" });
  }
});

const createDomainSchema = z.object({
  name: domainNameSchema,
  forceSsl: z.boolean().default(true),
  hostingMode: z.enum(["PUBLIC_HTML", "DEPLOYMENT_PROXY", "REDIRECT"]).default("PUBLIC_HTML"),
  documentRoot: z.string().default("public_html"),
  redirectUrl: z.string().url().nullable().optional(),
  hostingDeploymentId: z.string().nullable().optional()
});
const domainUpdateSchema = z.object({
  forceSsl: z.boolean().optional(),
  hostingMode: z.enum(["PUBLIC_HTML", "DEPLOYMENT_PROXY", "REDIRECT"]).optional(),
  documentRoot: z.string().optional(),
  redirectUrl: z.string().url().nullable().optional(),
  hostingDeploymentId: z.string().nullable().optional()
});
const bulkDomainSchema = z.object({
  domains: z.array(domainNameSchema).min(1).max(500),
  forceSsl: z.boolean().default(true),
  skipExisting: z.boolean().default(true),
  publish: z.boolean().default(true)
});
const fileQuerySchema = z.object({ path: z.string().default(".") });
const listFileQuerySchema = z.object({
  path: z.string().default("."),
  search: z.string().default(""),
  sort: z.enum(["name", "size", "modifiedAt"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(200)
});
const fileWriteSchema = z.object({ path: z.string(), content: z.string().max(1024 * 1024) });
const fileCreateSchema = z.object({ parentPath: z.string().default("."), name: z.string().min(1).max(120), content: z.string().max(1024 * 1024).default("") });
const folderCreateSchema = z.object({ parentPath: z.string().default("."), name: z.string().min(1).max(120) });
const fileDeleteSchema = z.object({ path: z.string().optional(), paths: z.array(z.string()).optional(), permanent: z.boolean().default(false) });
const fileRenameSchema = z.object({ path: z.string(), name: z.string().min(1).max(120) });
const fileCopyMoveSchema = z.object({ sourcePath: z.string(), targetParentPath: z.string(), name: z.string().min(1).max(120).optional(), overwrite: z.boolean().default(false) });
const chmodSchema = z.object({ path: z.string(), mode: z.string().regex(/^[0-7]{3,4}$/) });
const archiveCreateSchema = z.object({ sourcePaths: z.array(z.string()).min(1), archivePath: z.string() });
const archiveExtractSchema = z.object({ archivePath: z.string(), targetPath: z.string(), overwrite: z.boolean().default(false) });
const mailboxSchema = z.object({
  domainId: z.string(),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]+$/),
  password: z.string().min(10),
  quotaMb: z.number().int().min(128).default(1024)
});
const mailboxUpdateSchema = z.object({
  quotaMb: z.number().int().min(128).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(10).max(128).optional()
});
const deploymentSchema = z.object({
  domainId: z.string().nullable().optional(),
  name: z.string().min(1),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).optional(),
  framework: z.enum(["LARAVEL", "NEXTJS", "NODEJS", "PYTHON", "GO", "STATIC"]).default("STATIC"),
  sourceProvider: z.enum(["MANUAL", "GIT_URL", "FILE_MANAGER", "UPLOAD"]).default("FILE_MANAGER"),
  gitUrl: z.string().url().nullable().optional(),
  branch: z.string().default("main"),
  rootDirectory: z.string().default("."),
  installCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  outputDirectory: z.string().nullable().optional(),
  publicDirectory: z.string().nullable().optional(),
  autoDeployEnabled: z.boolean().default(false)
});
const deploymentUpdateSchema = deploymentSchema.partial().extend({
  status: z.enum(["QUEUED", "RUNNING", "STOPPED", "DEPLOYING", "BUILDING", "FAILED"]).optional(),
  healthStatus: z.enum(["UNKNOWN", "HEALTHY", "DEGRADED", "DOWN"]).optional()
});
const envVarSchema = z.object({
  key: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/i),
  value: z.string().nullable().optional(),
  isSecret: z.boolean().default(false),
  secretRef: z.string().nullable().optional()
});
const dnsRecordSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]),
  name: z.string().trim().min(1).default("@"),
  value: z.string().trim().min(1),
  ttl: z.number().int().min(60).max(86400).default(3600),
  priority: z.number().int().min(0).max(65535).nullable().optional()
});
const subdomainSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  target: z.string().trim().min(1),
  sslEnabled: z.boolean().default(false)
});
const databaseSchema = z.object({
  engine: z.enum(["POSTGRESQL", "MYSQL"]),
  database: z.string().regex(/^[a-zA-Z0-9_]+$/),
  username: z.string().regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(12).max(256).optional()
});
const sslSchema = z.object({
  email: z.string().email().optional(),
  includeWww: z.boolean().default(true)
});
const unsafeName = /[<>:"|?*\x00-\x1F]/;
const deploymentPortStart = Number(process.env.DEPLOYMENT_PORT_START ?? 10000);
const deploymentPortEnd = Number(process.env.DEPLOYMENT_PORT_END ?? 19999);
const defaultProcessManagerByFramework: Record<DeploymentFramework, "PM2" | "SUPERVISOR" | "STATIC"> = {
  LARAVEL: "SUPERVISOR",
  NEXTJS: "PM2",
  NODEJS: "PM2",
  PYTHON: "SUPERVISOR",
  GO: "SUPERVISOR",
  STATIC: "STATIC"
};

function usageFrom(account: any) {
  return {
    domains: account._count.domains,
    deployments: account._count.deployments,
    mailAccounts: account._count.mailAccounts,
    databases: account._count.databases ?? 0,
    diskUsedMb: account.diskUsedMb ?? 0,
    diskLimitMb: account.diskLimitMb,
    domainLimit: account.domainLimit,
    mailboxLimit: account.mailboxLimit,
    databaseLimit: account.databaseLimit,
    deploymentLimit: account.deploymentLimit
  };
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function uniqueDeploymentSlug(base: string) {
  const root = slugify(base) || "app";
  for (let index = 0; index < 50; index += 1) {
    const slug = index === 0 ? root : `${root}-${index + 1}`;
    const existing = await prisma.deployment.findUnique({ where: { slug } });
    if (!existing) return slug;
  }
  return `${root}-${Date.now()}`;
}

function includeAccountDeployment() {
  return {
    domain: true,
    domainBindings: { include: { domain: true, subdomain: { include: { domain: true } } }, orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }] },
    env: { orderBy: { key: "asc" as const } },
    releases: { orderBy: { createdAt: "desc" as const }, take: 10 },
    logs: { orderBy: { createdAt: "desc" as const }, take: 100 }
  };
}

async function findAccountDeployment(request: any, idOrSlug: string) {
  return prisma.deployment.findFirstOrThrow({
    where: { accountId: accountId(request), OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: includeAccountDeployment()
  });
}

async function nextDeploymentPort() {
  const deployments = await prisma.deployment.findMany({
    where: { port: { gte: deploymentPortStart, lte: deploymentPortEnd } },
    select: { port: true }
  });
  const used = new Set(deployments.map((deployment) => deployment.port));
  for (let port = deploymentPortStart; port <= deploymentPortEnd; port += 1) {
    if (!used.has(port)) return port;
  }
  throw Object.assign(new Error(`No available deployment ports in ${deploymentPortStart}-${deploymentPortEnd}`), { statusCode: 409 });
}

async function directorySizeBytes(root: string) {
  let total = 0;
  async function walk(dir: string) {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        total += await fs.stat(fullPath).then((stats) => stats.size).catch(() => 0);
      }
    }
  }
  await walk(root);
  return total;
}

function expiryStatus(expiry: Date | null) {
  if (!expiry) return { state: "missing", daysRemaining: null, alert: false };
  const daysRemaining = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
  return {
    state: daysRemaining < 0 ? "expired" : daysRemaining < 14 ? "expiring" : "valid",
    daysRemaining,
    alert: daysRemaining < 14
  };
}

function assertLimit(current: number, limit: number | null | undefined, label: string) {
  if (limit !== null && limit !== undefined && current >= limit) {
    const error = new Error(`${label} package limit reached`);
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}

function domainInclude() {
  return {
    _count: { select: { subdomains: true, dnsRecords: true, mailAccounts: true } },
    subdomains: { orderBy: { name: "asc" as const } }
  };
}

function normalizeDocumentRoot(value?: string | null) {
  const root = (value || "public_html").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!root || root.includes("..") || path.isAbsolute(root)) {
    const error = new Error("Document root must be a folder inside the account.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return root;
}

function normalizeRedirectUrl(value?: string | null) {
  return value ? value.replace(/\/+$/, "") : null;
}

function dnsRecordTypeForTarget(target: string) {
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(target)) return "A" as const;
  if (target.includes(":")) return "AAAA" as const;
  return "CNAME" as const;
}

async function validateAccountHostingSettings(accountId: string, input: {
  hostingMode?: "PUBLIC_HTML" | "DEPLOYMENT_PROXY" | "REDIRECT";
  hostingDeploymentId?: string | null;
  redirectUrl?: string | null;
}) {
  if (input.hostingMode === "DEPLOYMENT_PROXY") {
    if (!input.hostingDeploymentId) {
      const error = new Error("Select a deployment before using deployment proxy hosting.");
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }
    await prisma.deployment.findFirstOrThrow({ where: { id: input.hostingDeploymentId, accountId } });
  }
  if (input.hostingMode === "REDIRECT" && !input.redirectUrl) {
    const error = new Error("Set a redirect URL before using redirect hosting.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
}

function safeAccountPath(account: { homeRoot: string }, inputPath = ".") {
  const root = path.resolve(account.homeRoot);
  const normalized = inputPath.replaceAll("\\", "/");
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const error = new Error("Path escapes account file root");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return { root, resolved, relative: path.relative(root, resolved).replaceAll(path.sep, "/") || "." };
}

function safeChildPath(account: { homeRoot: string }, parentPath: string, name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || unsafeName.test(name)) {
    const error = new Error("Unsafe file or folder name");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  const parent = safeAccountPath(account, parentPath);
  return safeAccountPath(account, path.posix.join(parent.relative, name));
}

async function fileEntry(account: { homeRoot: string }, resolved: string) {
  const stats = await fs.stat(resolved);
  const relative = path.relative(path.resolve(account.homeRoot), resolved).replaceAll(path.sep, "/") || ".";
  const name = path.basename(resolved);
  const isDirectory = stats.isDirectory();
  const extension = isDirectory ? "" : path.extname(name).toLowerCase();
  const textExtensions = new Set([".css", ".env", ".go", ".html", ".ini", ".js", ".json", ".jsx", ".md", ".nginx", ".php", ".prisma", ".py", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
  const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
  return {
    name,
    path: relative,
    type: isDirectory ? "directory" : "file",
    kind: isDirectory ? "directory" : textExtensions.has(extension) ? "text" : imageExtensions.has(extension) ? "image" : extension === ".pdf" ? "pdf" : "binary",
    extension,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    createdAt: stats.birthtime.toISOString(),
    permissions: (stats.mode & 0o777).toString(8).padStart(3, "0"),
    mime: null,
    isHidden: name.startsWith("."),
    isReadonly: false
  };
}

function sortFileEntries(entries: Awaited<ReturnType<typeof fileEntry>>[], sort: "name" | "size" | "modifiedAt", direction: "asc" | "desc") {
  const factor = direction === "asc" ? 1 : -1;
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    if (sort === "size") return (a.size - b.size) * factor;
    if (sort === "modifiedAt") return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * factor;
    return a.name.localeCompare(b.name) * factor;
  });
}

async function buildFileTree(account: { homeRoot: string }, dir: string, depth: number, state: { count: number }): Promise<any[]> {
  if (depth <= 0 || state.count > 500) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  const result = [];
  for (const entry of folders) {
    state.count += 1;
    const fullPath = path.join(dir, entry.name);
    result.push({ ...(await fileEntry(account, fullPath)), children: await buildFileTree(account, fullPath, depth - 1, state) });
  }
  return result;
}

function breadcrumbsFor(relative: string) {
  const parts = relative === "." ? [] : relative.split("/").filter(Boolean);
  const crumbs = [{ name: "root", path: "." }];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

function parentPath(value: string) {
  if (value === "." || !value.includes("/")) return ".";
  return value.split("/").slice(0, -1).join("/") || ".";
}

export const accountPanelRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/vnd.vps-panel.file-upload", (_request, payload, done) => {
    done(null, payload);
  });
  app.addHook("preHandler", app.requireAccount);

  app.get("/me", async (request: any) => {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    return safeAccount(account);
  });

  app.get("/dashboard", async (request: any) => {
    const id = accountId(request);
    const [account, domains, deployments, mailAccounts, databases] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id }, include: { _count: { select: { domains: true, deployments: true, mailAccounts: true, databases: true } } } }),
      prisma.domain.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } }),
      prisma.deployment.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } }),
      prisma.mailAccount.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, include: { domain: true } }),
      prisma.accountDatabase.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } })
    ]);
    const diskUsedMb = Math.ceil(await directorySizeBytes(account.homeRoot) / 1024 / 1024);
    return {
      account: safeAccount({ ...account, diskUsedMb }),
      usage: usageFrom({ ...account, diskUsedMb }),
      domains,
      deployments,
      mailAccounts,
      databases,
      fileRoot: account.homeRoot
    };
  });

  app.get("/domains", async (request: any) => {
    const query = z.object({
      search: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(50)
    }).parse(request.query);
    const id = accountId(request);
    const subdomainSearch = query.search?.split(".")[0];
    const where = {
      accountId: id,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              ...(subdomainSearch ? [{ subdomains: { some: { name: { contains: subdomainSearch, mode: "insensitive" as const } } } }] : [])
            ]
          }
        : {})
    };
    const [items, total] = await Promise.all([
      prisma.domain.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: domainInclude()
      }),
      prisma.domain.count({ where })
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  app.post("/domains", async (request: any, reply) => {
    const body = createDomainSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    assertLimit(account._count.domains, account.domainLimit, "Domain");
    const documentRoot = normalizeDocumentRoot(body.documentRoot || "public_html");
    const redirectUrl = normalizeRedirectUrl(body.redirectUrl);
    await validateAccountHostingSettings(account.id, { ...body, redirectUrl });
    try {
      const domain = await prisma.$transaction(async (tx) => {
        const created = await tx.domain.create({
          data: {
            name: body.name,
            accountId: account.id,
            status: "ACTIVE",
            forceSsl: body.forceSsl,
            hostingMode: body.hostingMode,
            documentRoot,
            redirectUrl,
            hostingDeploymentId: body.hostingDeploymentId ?? null
          }
        });
        await tx.dnsRecord.createMany({ data: defaultRecords(created.id, created.name), skipDuplicates: true });
        return tx.domain.findUniqueOrThrow({ where: { id: created.id }, include: domainInclude() });
      });
      await audit(request, { action: "CREATE", resource: "domain", resourceId: domain.id, description: `Account created domain ${domain.name}` });
      return reply.code(201).send(domain);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "Domain already exists" });
      }
      throw error;
    }
  });

  app.post("/domains/bulk", async (request: any, reply) => {
    const body = bulkDomainSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true } } }
    });
    const uniqueDomains = [...new Set(body.domains)];
    const results: Array<{ input: string; name: string; status: "created" | "skipped" | "failed"; error?: string; publishWarning?: string }> = [];
    let currentDomainCount = account._count.domains;

    for (const name of uniqueDomains) {
      try {
        const existing = await prisma.domain.findUnique({ where: { name } });
        if (existing && body.skipExisting) {
          results.push({ input: name, name, status: "skipped", error: "Domain already exists" });
          continue;
        }
        assertLimit(currentDomainCount, account.domainLimit, "Domain");
        const domain = await prisma.$transaction(async (tx) => {
          const created = await tx.domain.create({
            data: {
              name,
              accountId: account.id,
              status: "ACTIVE",
              forceSsl: body.forceSsl,
              hostingMode: "PUBLIC_HTML",
              documentRoot: "public_html"
            }
          });
          await tx.dnsRecord.createMany({ data: defaultRecords(created.id, created.name), skipDuplicates: true });
          return tx.domain.findUniqueOrThrow({ where: { id: created.id }, include: domainInclude() });
        });
        currentDomainCount += 1;
        let publishWarning: string | undefined;
        if (body.publish) {
          try {
            const records = await prisma.dnsRecord.findMany({ where: { domainId: domain.id } });
            await sysagent.applyDnsZone({ domain: domain.name, zone: renderZone(domain.name, records) });
          } catch (error) {
            publishWarning = error instanceof Error ? error.message : "Domain DNS publish failed";
          }
        }
        await audit(request, { action: "CREATE", resource: "domain", resourceId: domain.id, description: `Account bulk-created domain ${domain.name}` });
        results.push({ input: name, name: domain.name, status: "created", publishWarning });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && body.skipExisting) {
          results.push({ input: name, name, status: "skipped", error: "Domain already exists" });
          continue;
        }
        results.push({ input: name, name, status: "failed", error: error instanceof Error ? error.message : "Could not add domain" });
      }
    }
    const summary = {
      created: results.filter((result) => result.status === "created").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length
    };
    return reply.code(summary.failed > 0 ? 207 : 201).send({ ...summary, total: results.length, results });
  });

  app.patch("/domains/:domainId/status", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["ACTIVE", "PENDING", "SUSPENDED"]) }).parse(request.body);
    const domain = await prisma.domain.update({
      where: { id: (await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } })).id },
      data: { status: body.status },
      include: domainInclude()
    });
    await audit(request, { action: "UPDATE", resource: "domain", resourceId: domain.id, description: `Account updated ${domain.name} status to ${body.status}` });
    return domain;
  });

  app.patch("/domains/:domainId", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = domainUpdateSchema.parse(request.body);
    const existing = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const nextHostingMode = body.hostingMode ?? existing.hostingMode;
    const nextRedirectUrl = normalizeRedirectUrl(body.redirectUrl === undefined ? existing.redirectUrl : body.redirectUrl);
    const nextHostingDeploymentId = body.hostingDeploymentId === undefined ? existing.hostingDeploymentId : body.hostingDeploymentId;
    await validateAccountHostingSettings(accountId(request), { hostingMode: nextHostingMode, hostingDeploymentId: nextHostingDeploymentId, redirectUrl: nextRedirectUrl });
    const domain = await prisma.domain.update({
      where: { id: existing.id },
      data: {
        ...body,
        ...(body.documentRoot !== undefined ? { documentRoot: normalizeDocumentRoot(body.documentRoot) } : {}),
        ...(body.redirectUrl !== undefined ? { redirectUrl: nextRedirectUrl } : {})
      },
      include: domainInclude()
    });
    await audit(request, { action: "UPDATE", resource: "domain", resourceId: domain.id, description: `Account updated domain ${domain.name}` });
    return domain;
  });

  app.post("/domains/:domainId/publish", async (request: any, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({
      where: { id: domainId, accountId: accountId(request) },
      include: { dnsRecords: true }
    });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const dnsResult = await sysagent.applyDnsZone({ domain: domain.name, zone: renderZone(domain.name, domain.dnsRecords) });
    const nginxResult = domain.hostingMode === "REDIRECT"
      ? await sysagent.writeRedirectNginxVhost({
          name: `account-domain-${domain.name}`,
          serverName: `${domain.name} www.${domain.name}`,
          redirectUrl: normalizeRedirectUrl(domain.redirectUrl)
        })
      : await sysagent.writeStaticNginxVhost({
          name: `account-domain-${domain.name}`,
          serverName: `${domain.name} www.${domain.name}`,
          rootPath: path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot)),
          forceHttps: domain.forceSsl && domain.sslEnabled,
          ...(domain.sslEnabled
            ? {
                sslCertificate: `/etc/letsencrypt/live/${domain.name}/fullchain.pem`,
                sslCertificateKey: `/etc/letsencrypt/live/${domain.name}/privkey.pem`
              }
            : {})
        });
    await audit(request, { action: "APPLY", resource: "domain", resourceId: domain.id, description: `Account published DNS and website for ${domain.name}`, metadata: { dnsResult, nginxResult } as any });
    return reply.code(202).send({ domain, dnsResult, nginxResult });
  });

  app.delete("/domains/:domainId", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ confirmName: z.string() }).parse(request.body ?? {});
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    if (body.confirmName !== domain.name) throw app.httpErrors.badRequest("Domain deletion requires exact domain name confirmation");
    await prisma.domain.delete({ where: { id: domain.id } });
    await audit(request, { action: "DELETE", resource: "domain", resourceId: domain.id, description: `Account deleted domain ${domain.name}` });
    return { ok: true };
  });

  app.post("/domains/:domainId/subdomains", async (request: any, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = subdomainSchema.parse(request.body);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const recordType = dnsRecordTypeForTarget(body.target);
    const result = await prisma.$transaction(async (tx) => {
      const subdomain = await tx.subdomain.create({ data: { domainId: domain.id, name: body.name, target: body.target, sslEnabled: body.sslEnabled } });
      await tx.dnsRecord.createMany({
        data: [{ domainId: domain.id, type: recordType, name: body.name, value: body.target }],
        skipDuplicates: true
      });
      return { subdomain, dnsRecord: { type: recordType, name: body.name, value: body.target } };
    });
    await audit(request, { action: "CREATE", resource: "subdomain", resourceId: result.subdomain.id, description: `Account created subdomain ${body.name}.${domain.name}` });
    return reply.code(201).send(result);
  });

  app.get("/domains/:domainId/dns", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    return prisma.dnsRecord.findMany({ where: { domainId: domain.id }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  });

  app.post("/domains/:domainId/dns", async (request: any, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = dnsRecordSchema.parse(request.body);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const record = await prisma.dnsRecord.create({
      data: {
        domainId: domain.id,
        type: body.type,
        name: body.name,
        value: body.value,
        ttl: body.ttl,
        priority: body.priority ?? null
      }
    });
    await audit(request, { action: "CREATE", resource: "dns_record", resourceId: record.id, description: `Account created ${record.type} record for ${domain.name}` });
    return reply.code(201).send(record);
  });

  app.delete("/domains/:domainId/dns/:recordId", async (request: any) => {
    const { domainId, recordId } = z.object({ domainId: z.string(), recordId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const deleted = await prisma.dnsRecord.deleteMany({ where: { id: recordId, domainId: domain.id } });
    if (deleted.count === 0) throw app.httpErrors.notFound("DNS record not found");
    await audit(request, { action: "DELETE", resource: "dns_record", resourceId: recordId, description: `Account deleted DNS record for ${domain.name}` });
    return { ok: true };
  });

  app.get("/domains/:domainId/ssl", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    return {
      domainId: domain.id,
      domain: domain.name,
      sslEnabled: domain.sslEnabled,
      sslExpiry: domain.sslExpiry,
      forceSsl: domain.forceSsl,
      ...expiryStatus(domain.sslEnabled ? domain.sslExpiry : null)
    };
  });

  app.post("/domains/:domainId/ssl/:action", async (request: any, reply) => {
    const { domainId, action } = z.object({ domainId: z.string(), action: z.enum(["issue", "renew"]) }).parse(request.params);
    const body = sslSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const webRoot = path.join(account.homeRoot, "public_html");
    const job = await sslQueue.add(action, {
      domainId: domain.id,
      domain: domain.name,
      email: body.email ?? `admin@${domain.name}`,
      webRoot,
      includeWww: body.includeWww,
      forceSsl: domain.forceSsl,
      source: "account"
    });
    await audit(request, { action: "APPLY", resource: "ssl", resourceId: domain.id, description: `Account queued SSL ${action} for ${domain.name}` });
    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.get("/deployments", async (request: any) => {
    const query = z.object({
      search: z.string().default(""),
      status: z.string().default(""),
      sourceProvider: z.string().default(""),
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(50)
    }).parse(request.query);
    const where = {
      accountId: accountId(request),
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: "insensitive" as const } }, { slug: { contains: query.search, mode: "insensitive" as const } }] } : {}),
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.sourceProvider ? { sourceProvider: query.sourceProvider as any } : {})
    };
    const [items, total] = await Promise.all([
      prisma.deployment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: includeAccountDeployment()
      }),
      prisma.deployment.count({ where })
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  });

  app.get("/deployments/ports/next", async () => ({ port: await nextDeploymentPort() }));

  app.post("/deployments/detect", async () => ({
    detected: "STATIC",
    confidence: 0.4,
    reason: "Account-scoped framework detection uses the default static profile.",
    suggestions: { runtime: "STATIC", packageManager: null, installCommand: null, buildCommand: null, startCommand: null, outputDirectory: "public" }
  }));

  app.post("/deployments", async (request: any, reply) => {
    const body = deploymentSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true, databases: true } } }
    });
    assertLimit(account._count.deployments, account.deploymentLimit, "Deployment");
    const domain = body.domainId ? await prisma.domain.findFirstOrThrow({ where: { id: body.domainId, accountId: account.id } }) : null;
    const slug = await uniqueDeploymentSlug(body.slug || body.name);
    const rootPath = path.join(account.homeRoot, "deployments", slug);
    await fs.mkdir(rootPath, { recursive: true });
    const deployment = await prisma.deployment.create({
      data: {
        accountId: account.id,
        domainId: domain?.id ?? null,
        name: body.name,
        slug,
        framework: body.framework,
        runtime: body.framework === "STATIC" ? "STATIC" : null,
        sourceProvider: body.sourceProvider,
        gitUrl: body.gitUrl ?? null,
        branch: body.branch,
        rootDirectory: body.rootDirectory,
        rootPath,
        installCommand: body.installCommand ?? null,
        buildCommand: body.buildCommand ?? null,
        startCommand: body.startCommand ?? null,
        outputDirectory: body.outputDirectory ?? null,
        publicDirectory: body.publicDirectory ?? null,
        processManager: defaultProcessManagerByFramework[body.framework],
        port: await nextDeploymentPort(),
        autoDeployEnabled: body.autoDeployEnabled,
        status: "STOPPED"
      }
    });
    if (domain) {
      await prisma.deploymentDomain.upsert({
        where: { deploymentId_domainId: { deploymentId: deployment.id, domainId: domain.id } },
        update: { role: "primary" },
        create: { deploymentId: deployment.id, domainId: domain.id, role: "primary" }
      });
      await prisma.domain.update({ where: { id: domain.id }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } });
    }
    await audit(request, { action: "CREATE", resource: "deployment", resourceId: deployment.id, description: `Account created deployment ${deployment.slug}` });
    return reply.code(201).send(await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id }, include: includeAccountDeployment() }));
  });

  app.patch("/deployments/:deploymentId", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = deploymentUpdateSchema.parse(request.body);
    const existing = await findAccountDeployment(request, deploymentId);
    const domain = body.domainId ? await prisma.domain.findFirstOrThrow({ where: { id: body.domainId, accountId: accountId(request) } }) : body.domainId === null ? null : undefined;
    const deployment = await prisma.deployment.update({
      where: { id: existing.id },
      data: {
        ...body,
        domainId: domain === undefined ? existing.domainId : domain?.id ?? null,
        gitUrl: body.gitUrl ?? undefined,
        repoUrl: (body as any).repoUrl ?? undefined,
        processManager: body.framework ? defaultProcessManagerByFramework[body.framework] : undefined
      },
      include: includeAccountDeployment()
    });
    if (domain !== undefined) {
      await prisma.deploymentDomain.deleteMany({ where: { deploymentId: deployment.id, role: "primary" } });
      if (domain) {
        await prisma.deploymentDomain.upsert({
          where: { deploymentId_domainId: { deploymentId: deployment.id, domainId: domain.id } },
          update: { role: "primary" },
          create: { deploymentId: deployment.id, domainId: domain.id, role: "primary" }
        });
      }
    }
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Account updated deployment ${deployment.slug}` });
    return prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id }, include: includeAccountDeployment() });
  });

  app.get("/deployments/:deploymentId/releases", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    return prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "desc" }, take: 50 });
  });

  app.get("/deployments/:deploymentId/logs", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    return prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id },
      orderBy: { createdAt: "asc" },
      take: 200
    });
  });

  app.get("/deployments/:deploymentId/logs/export", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const logs = await prisma.deploymentLog.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" }, take: 500 });
    reply.type("text/plain");
    return logs.map((log) => `[${log.createdAt.toISOString()}] ${log.step}: ${log.message}`).join("\n") || "No logs yet.";
  });

  app.post("/deployments/:deploymentId/domains", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ domainId: z.string(), primary: z.boolean().default(false) }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: body.domainId, accountId: accountId(request) } });
    if (body.primary) await prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id }, data: { role: "alias" } });
    const binding = await prisma.deploymentDomain.upsert({
      where: { deploymentId_domainId: { deploymentId: deployment.id, domainId: domain.id } },
      update: { role: body.primary ? "primary" : "alias" },
      create: { deploymentId: deployment.id, domainId: domain.id, role: body.primary ? "primary" : "alias" },
      include: { domain: true, subdomain: { include: { domain: true } } }
    });
    await prisma.domain.update({ where: { id: domain.id }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } });
    if (body.primary) await prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: domain.id } });
    return reply.code(201).send(binding);
  });

  app.patch("/deployments/:deploymentId/domains/:domainId/primary", async (request: any) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const binding = await prisma.deploymentDomain.findFirstOrThrow({ where: { deploymentId: deployment.id, domainId } });
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: binding.domainId ?? "", accountId: accountId(request) } });
    await prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id }, data: { role: "alias" } });
    await prisma.deploymentDomain.update({ where: { id: binding.id }, data: { role: "primary" } });
    await prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: domain.id } });
    return { ok: true };
  });

  app.delete("/deployments/:deploymentId/domains/:domainId", async (request: any) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const deleted = await prisma.deploymentDomain.deleteMany({ where: { deploymentId: deployment.id, domainId } });
    if (deleted.count === 0) throw app.httpErrors.notFound("Domain binding not found");
    if (deployment.domainId === domainId) await prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: null } });
    return { ok: true };
  });

  app.get("/deployments/:deploymentId/env/:key/reveal", async (request: any) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const item = await prisma.deploymentEnvVar.findUniqueOrThrow({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    return { key: item.key, value: item.value ?? "", isSecret: item.isSecret };
  });

  app.put("/deployments/:deploymentId/env/:key", async (request: any) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const body = envVarSchema.omit({ key: true }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    return prisma.deploymentEnvVar.upsert({
      where: { deploymentId_key: { deploymentId: deployment.id, key } },
      update: { value: body.value ?? "", isSecret: body.isSecret, secretRef: body.secretRef ?? null },
      create: { deploymentId: deployment.id, key, value: body.value ?? "", isSecret: body.isSecret, secretRef: body.secretRef ?? null }
    });
  });

  app.post("/deployments/:deploymentId/env/bulk", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ env: z.array(envVarSchema).max(200) }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const items = [];
    for (const item of body.env) {
      items.push(await prisma.deploymentEnvVar.upsert({
        where: { deploymentId_key: { deploymentId: deployment.id, key: item.key } },
        update: { value: item.value ?? "", isSecret: item.isSecret, secretRef: item.secretRef ?? null },
        create: { deploymentId: deployment.id, key: item.key, value: item.value ?? "", isSecret: item.isSecret, secretRef: item.secretRef ?? null }
      }));
    }
    return { ok: true, items };
  });

  app.delete("/deployments/:deploymentId/env/:key", async (request: any) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    return { ok: true };
  });

  app.post("/deployments/:deploymentId/env/bulk-delete", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const removed: string[] = [];
    for (const key of [...new Set(body.keys.map((item) => item.trim().toUpperCase()).filter(Boolean))]) {
      await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } }).then(() => removed.push(key)).catch(() => undefined);
    }
    return { ok: true, removed };
  });

  app.post("/deployments/:deploymentId/env/clear-database-overrides", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const keys = ["DB_PASSWORD", "DATABASE_URL"];
    const removed: string[] = [];
    for (const key of keys) {
      await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } }).then(() => removed.push(key)).catch(() => undefined);
    }
    return { ok: true, removed };
  });

  app.post("/deployments/:deploymentId/rollback", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ releaseId: z.string() }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const release = await prisma.deploymentRelease.findFirstOrThrow({ where: { id: body.releaseId, deploymentId: deployment.id } });
    const queue = await deployQueue.add("rollback", { deploymentId: deployment.id, releaseId: release.id });
    return reply.code(202).send({ queue: { queued: true, jobId: queue.id }, release });
  });

  app.post("/deployments/:deploymentId/doctor/repair", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    await prisma.deploymentLog.create({ data: { deploymentId: deployment.id, step: "HEALTH_CHECK", message: "Account Guardian repair requested." } });
    return { ok: true, status: "queued", summary: "Guardian repair requested for this account deployment." };
  });

  app.delete("/deployments/:deploymentId", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ confirmSlug: z.string() }).parse(request.body ?? {});
    const deployment = await findAccountDeployment(request, deploymentId);
    if (body.confirmSlug !== deployment.slug) throw app.httpErrors.badRequest("Deployment deletion requires exact slug confirmation");
    await prisma.deployment.delete({ where: { id: deployment.id } });
    await audit(request, { action: "DELETE", resource: "deployment", resourceId: deployment.id, description: `Account deleted deployment ${deployment.slug}` });
    return { ok: true };
  });

  app.post("/deployments/:deploymentId/:action", async (request: any, reply) => {
    const params = z.object({
      deploymentId: z.string(),
      action: z.enum(["deploy", "redeploy", "start", "stop", "restart"])
    }).parse(request.params);
    const deployment = await findAccountDeployment(request, params.deploymentId);
    const release = ["deploy", "redeploy"].includes(params.action)
      ? await prisma.deploymentRelease.create({
          data: {
            deploymentId: deployment.id,
            status: "QUEUED",
            commitSha: deployment.commitSha,
            sourcePath: deployment.rootPath,
            envSnapshot: deployment.envVars === null ? {} : deployment.envVars as Prisma.InputJsonValue,
            processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
          }
        })
      : null;
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: params.action === "stop" ? "STOPPED" : "QUEUED",
        healthStatus: params.action === "stop" ? "DOWN" : "UNKNOWN"
      }
    });
    const queue = await deployQueue.add(params.action, { deploymentId: deployment.id, releaseId: release?.id });
    await audit(request, { action: params.action === "stop" ? "STOP" : params.action === "restart" ? "RESTART" : "DEPLOY", resource: "deployment", resourceId: deployment.id, description: `Account queued ${params.action} for ${deployment.slug}` });
    return reply.code(202).send({ queue: { queued: true, jobId: queue.id }, release });
  });

  app.get("/databases", async (request: any) => {
    const databases = await prisma.accountDatabase.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" } });
    const engines = (["POSTGRESQL", "MYSQL"] as const).map((engine) => {
      const items = databases.filter((database) => database.engine === engine);
      return {
        engine,
        installed: true,
        databases: items.map((database) => ({ name: database.database, owner: database.username })),
        users: items.map((database) => ({ name: database.username, host: null })),
        checks: {}
      };
    });
    return { engines };
  });

  app.post("/databases", async (request: any, reply) => {
    const body = databaseSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true, databases: true } } }
    });
    assertLimit(account._count.databases, account.databaseLimit, "Database");
    const prefix = `${account.username}_`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24);
    if (!body.database.startsWith(prefix) || !body.username.startsWith(prefix)) {
      throw app.httpErrors.badRequest(`Database and username must start with ${prefix}`);
    }
    const result = await sysagent.provisionDatabase(body);
    const accountDatabase = await prisma.accountDatabase.create({
      data: {
        accountId: account.id,
        engine: body.engine,
        database: body.database,
        username: body.username
      }
    });
    await audit(request, { action: "CREATE", resource: "database", resourceId: accountDatabase.id, description: `Account created ${body.engine} database ${body.database}`, metadata: { result } as any });
    return reply.code(201).send({ ...accountDatabase, result });
  });

  app.post("/databases/:databaseId/password", async (request: any) => {
    const { databaseId } = z.object({ databaseId: z.string() }).parse(request.params);
    const body = z.object({ password: z.string().min(12).max(256) }).parse(request.body);
    const accountDatabase = await prisma.accountDatabase.findFirstOrThrow({ where: { id: databaseId, accountId: accountId(request) } });
    const result = await sysagent.databasePassword({ engine: accountDatabase.engine, username: accountDatabase.username, password: body.password });
    await audit(request, { action: "UPDATE", resource: "database-user", resourceId: accountDatabase.id, description: `Account changed DB password for ${accountDatabase.username}`, metadata: { result } as any });
    return { ok: true, result };
  });

  app.delete("/databases/:databaseId", async (request: any) => {
    const { databaseId } = z.object({ databaseId: z.string() }).parse(request.params);
    const accountDatabase = await prisma.accountDatabase.findFirstOrThrow({ where: { id: databaseId, accountId: accountId(request) } });
    const result = await sysagent.databaseDelete({ engine: accountDatabase.engine, database: accountDatabase.database });
    await prisma.accountDatabase.delete({ where: { id: accountDatabase.id } });
    await audit(request, { action: "DELETE", resource: "database", resourceId: accountDatabase.id, description: `Account deleted database ${accountDatabase.database}`, metadata: { result } as any });
    return { ok: true, result };
  });

  app.get("/mail", async (request: any) =>
    prisma.mailAccount.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" }, include: { domain: true } })
  );

  app.post("/mail", async (request: any, reply) => {
    const body = mailboxSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    assertLimit(account._count.mailAccounts, account.mailboxLimit, "Mailbox");
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: body.domainId, accountId: account.id } });
    const mailbox = await prisma.mailAccount.create({
      data: {
        accountId: account.id,
        domainId: domain.id,
        username: body.username,
        passwordHash: await bcrypt.hash(body.password, 12),
        quotaMb: body.quotaMb
      }
    });
    await audit(request, { action: "CREATE", resource: "mail_account", resourceId: mailbox.id, description: `Account created mailbox ${mailbox.username}@${domain.name}` });
    return reply.code(201).send({ ...mailbox, domain });
  });

  app.patch("/mail/:mailboxId", async (request: any) => {
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const body = mailboxUpdateSchema.parse(request.body);
    const data = {
      quotaMb: body.quotaMb,
      enabled: body.enabled,
      ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 12) } : {})
    };
    const mailbox = await prisma.mailAccount.updateMany({
      where: { id: mailboxId, accountId: accountId(request) },
      data
    });
    if (mailbox.count === 0) throw app.httpErrors.notFound("Mailbox not found");
    await audit(request, { action: "UPDATE", resource: "mail_account", resourceId: mailboxId, description: "Account updated mailbox" });
    return { ok: true };
  });

  app.delete("/mail/:mailboxId", async (request: any) => {
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const mailbox = await prisma.mailAccount.findFirst({ where: { id: mailboxId, accountId: accountId(request) } });
    if (!mailbox) throw app.httpErrors.notFound("Mailbox not found");
    await prisma.mailAccount.delete({ where: { id: mailbox.id } });
    await audit(request, { action: "DELETE", resource: "mail_account", resourceId: mailbox.id, description: "Account deleted mailbox" });
    return { ok: true };
  });

  app.get("/files/overview", async (request: any) => {
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    await fs.mkdir(account.homeRoot, { recursive: true });
    return { root: account.homeRoot, platform: os.platform(), pathSeparator: path.sep, textReadLimit: 1024 * 1024, uploadLimit: 3 * 1024 * 1024 * 1024, uploadChunkLimit: 64 * 1024 * 1024, writable: true };
  });

  app.get("/files/list", async (request: any) => {
    const query = listFileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved, relative } = safeAccountPath(account, query.path);
    await fs.mkdir(resolved, { recursive: true });
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) throw app.httpErrors.badRequest("Path is not a directory");
    const names = await fs.readdir(resolved);
    let items = await Promise.all(names.map((name) => fileEntry(account, path.join(resolved, name))));
    if (query.search) items = items.filter((item) => item.name.toLowerCase().includes(query.search.toLowerCase()));
    items = sortFileEntries(items, query.sort, query.direction);
    const start = (query.page - 1) * query.pageSize;
    return {
      current: await fileEntry(account, resolved),
      breadcrumbs: breadcrumbsFor(relative),
      root: account.homeRoot,
      items: items.slice(start, start + query.pageSize),
      total: items.length,
      page: query.page,
      pageSize: query.pageSize
    };
  });

  app.get("/files/tree", async (request: any) => {
    const query = z.object({ path: z.string().default("."), depth: z.coerce.number().int().min(0).max(5).default(2) }).parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    return { root: await fileEntry(account, resolved), children: await buildFileTree(account, resolved, query.depth, { count: 0 }) };
  });

  app.get("/files/read", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    if (stats.size > 1024 * 1024) throw app.httpErrors.payloadTooLarge("File is too large for account editor");
    return { file: await fileEntry(account, resolved), content: await fs.readFile(resolved, "utf8") };
  });

  app.put("/files/write", async (request: any) => {
    const body = fileWriteSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, body.path);
    await fs.writeFile(resolved, body.content, "utf8");
    await audit(request, { action: "UPDATE", resource: "account_file", resourceId: account.id, description: `Account updated ${body.path}` });
    return { ok: true, file: await fileEntry(account, resolved) };
  });

  app.post("/files/files", async (request: any, reply) => {
    const body = fileCreateSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeChildPath(account, body.parentPath, body.name);
    await fs.writeFile(resolved, body.content, { encoding: "utf8", flag: "wx" });
    await audit(request, { action: "CREATE", resource: "account_file", resourceId: account.id, description: `Account created ${body.name}` });
    return reply.code(201).send(await fileEntry(account, resolved));
  });

  app.post("/files/folders", async (request: any, reply) => {
    const body = folderCreateSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeChildPath(account, body.parentPath, body.name);
    await fs.mkdir(resolved);
    await audit(request, { action: "CREATE", resource: "account_file", resourceId: account.id, description: `Account created folder ${body.name}` });
    return reply.code(201).send(await fileEntry(account, resolved));
  });

  app.post("/files/domain-scaffold", async (request: any, reply) => {
    const body = z.object({ domain: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    await prisma.domain.findFirstOrThrow({ where: { accountId: account.id, name: body.domain } });
    const root = safeAccountPath(account, path.posix.join(body.domain, "public_html"));
    await fs.mkdir(root.resolved, { recursive: true });
    return reply.code(201).send({ root: await fileEntry(account, root.resolved), scaffold: { domain: body.domain, relativeRoot: root.relative, folders: [root.relative] } });
  });

  app.post("/files/subdomain-scaffold", async (request: any, reply) => {
    const body = z.object({ domain: z.string(), subdomain: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const domain = await prisma.domain.findFirstOrThrow({ where: { accountId: account.id, name: body.domain } });
    await prisma.subdomain.findFirstOrThrow({ where: { domainId: domain.id, name: body.subdomain } });
    const root = safeAccountPath(account, path.posix.join(body.domain, "subdomains", body.subdomain, "public_html"));
    await fs.mkdir(root.resolved, { recursive: true });
    return reply.code(201).send({ root: await fileEntry(account, root.resolved), scaffold: { domain: body.domain, subdomain: body.subdomain, relativeRoot: root.relative, folders: [root.relative] } });
  });

  app.patch("/files/rename", async (request: any) => {
    const body = fileRenameSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const source = safeAccountPath(account, body.path);
    const target = safeChildPath(account, parentPath(source.relative), body.name);
    await fs.rename(source.resolved, target.resolved);
    return { ok: true, file: await fileEntry(account, target.resolved) };
  });

  app.post("/files/copy", async (request: any) => {
    const body = fileCopyMoveSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const source = safeAccountPath(account, body.sourcePath);
    const targetParent = safeAccountPath(account, body.targetParentPath);
    const target = safeChildPath(account, targetParent.relative, body.name ?? path.basename(source.resolved));
    if (!body.overwrite) {
      await fs.access(target.resolved).then(() => { throw app.httpErrors.conflict("Target already exists"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    await fs.cp(source.resolved, target.resolved, { recursive: true, force: body.overwrite, errorOnExist: !body.overwrite });
    return { ok: true, file: await fileEntry(account, target.resolved) };
  });

  app.post("/files/move", async (request: any) => {
    const body = fileCopyMoveSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const source = safeAccountPath(account, body.sourcePath);
    const targetParent = safeAccountPath(account, body.targetParentPath);
    const target = safeChildPath(account, targetParent.relative, body.name ?? path.basename(source.resolved));
    if (!body.overwrite) {
      await fs.access(target.resolved).then(() => { throw app.httpErrors.conflict("Target already exists"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    await fs.rename(source.resolved, target.resolved);
    return { ok: true, file: await fileEntry(account, target.resolved) };
  });

  app.delete("/files/delete", async (request: any) => {
    const body = fileDeleteSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const paths = body.paths ?? (body.path ? [body.path] : []);
    const movedToTrash: string[] = [];
    const permanentlyRemoved: string[] = [];
    const trashRoot = safeAccountPath(account, ".trash");
    for (const itemPath of paths) {
      const { resolved, relative } = safeAccountPath(account, itemPath);
      if (relative === "." || relative === ".trash") throw app.httpErrors.badRequest("Account root cannot be deleted");
      if (body.permanent || relative.startsWith(".trash/")) {
        await fs.rm(resolved, { recursive: true, force: true });
        permanentlyRemoved.push(itemPath);
      } else {
        await fs.mkdir(trashRoot.resolved, { recursive: true });
        const trashTarget = safeAccountPath(account, path.posix.join(".trash", `${Date.now()}-${randomUUID().slice(0, 8)}-${path.basename(resolved)}`));
        await fs.rename(resolved, trashTarget.resolved);
        movedToTrash.push(itemPath);
      }
    }
    await audit(request, { action: "DELETE", resource: "account_file", resourceId: account.id, description: `Account processed ${paths.length} delete request(s)` });
    return { ok: true, movedToTrash, permanentlyRemoved };
  });

  app.get("/files/download", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    return { file: await fileEntry(account, resolved), contentBase64: (await fs.readFile(resolved)).toString("base64") };
  });

  app.get("/files/checksum", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    return { hash: createHash("sha256").update(await fs.readFile(resolved)).digest("hex") };
  });

  app.post("/files/chmod", async (request: any) => {
    const body = chmodSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, body.path);
    await fs.chmod(resolved, Number.parseInt(body.mode, 8));
    return { ok: true, file: await fileEntry(account, resolved) };
  });

  app.post("/files/git/status", async (request: any) => {
    const body = z.object({ path: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved, relative } = safeAccountPath(account, body.path);
    const gitDir = path.join(resolved, ".git");
    const isRepo = await fs.stat(gitDir).then((stats) => stats.isDirectory()).catch(() => false);
    return { ok: true, path: relative, isRepo };
  });

  app.post("/files/git/pull", async (request: any) => {
    const body = z.object({ path: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { relative } = safeAccountPath(account, body.path);
    return { ok: true, path: relative, stdout: "Git pull is disabled in account file manager.", stderr: "", returncode: 0 };
  });

  app.post("/files/git/github/pull", async (request: any) => {
    const body = z.object({ owner: z.string(), repo: z.string(), branch: z.string().default("main"), targetParentPath: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { relative } = safeAccountPath(account, body.targetParentPath);
    return { ok: true, path: relative, owner: body.owner, repo: body.repo, branch: body.branch };
  });

  app.post("/files/archive/create", async (request: any) => {
    const body = archiveCreateSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    for (const sourcePath of body.sourcePaths) safeAccountPath(account, sourcePath);
    const archive = safeAccountPath(account, body.archivePath);
    await fs.writeFile(archive.resolved, "");
    return { ok: true, file: await fileEntry(account, archive.resolved) };
  });

  app.post("/files/archive/extract", async (request: any) => {
    const body = archiveExtractSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    safeAccountPath(account, body.archivePath);
    const target = safeAccountPath(account, body.targetPath);
    await fs.mkdir(target.resolved, { recursive: true });
    return { ok: true, targetPath: target.relative, overwrite: body.overwrite };
  });

  app.post("/files/upload/chunk", { bodyLimit: 70 * 1024 * 1024 }, async (request: any, reply) => {
    const query = z.object({
      parentPath: z.string(),
      name: z.string().min(1).max(180),
      uploadId: z.string(),
      index: z.coerce.number().int().min(0),
      totalChunks: z.coerce.number().int().min(1),
      overwrite: z.enum(["true", "false"]).default("false")
    }).parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const target = safeChildPath(account, query.parentPath, query.name);
    if (query.index === 0 && query.overwrite !== "true") {
      await fs.access(target.resolved).then(() => { throw app.httpErrors.conflict("Target already exists"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body ?? "");
    await fs.mkdir(path.dirname(target.resolved), { recursive: true });
    await fs.writeFile(target.resolved, buffer, { flag: query.index === 0 ? "w" : "a" });
    const file = await fileEntry(account, target.resolved);
    return reply.code(query.index + 1 === query.totalChunks ? 201 : 202).send({ ok: true, uploadId: query.uploadId, file });
  });

  app.post("/password", async (request: any) => {
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(10).max(128)
    }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const ok = await bcrypt.compare(body.currentPassword, account.passwordHash);
    if (!ok) throw app.httpErrors.unauthorized("Current password is incorrect");
    await prisma.account.update({
      where: { id: account.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12) }
    });
    await audit(request, { action: "UPDATE", resource: "account", resourceId: account.id, description: "Account changed own password" });
    return { ok: true };
  });
};
