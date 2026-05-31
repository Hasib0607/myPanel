import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { DeploymentFramework, Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deployQueue, sslQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

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
  forceSsl: z.boolean().default(true)
});
const fileQuerySchema = z.object({ path: z.string().default(".") });
const fileWriteSchema = z.object({ path: z.string(), content: z.string().max(1024 * 1024) });
const fileCreateSchema = z.object({ parentPath: z.string().default("."), name: z.string().min(1).max(120), content: z.string().max(1024 * 1024).default("") });
const folderCreateSchema = z.object({ parentPath: z.string().default("."), name: z.string().min(1).max(120) });
const fileDeleteSchema = z.object({ path: z.string() });
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
const dnsRecordSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]),
  name: z.string().trim().min(1).default("@"),
  value: z.string().trim().min(1),
  ttl: z.number().int().min(60).max(86400).default(3600),
  priority: z.number().int().min(0).max(65535).nullable().optional()
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
  return {
    name: path.basename(resolved),
    path: relative,
    type: stats.isDirectory() ? "directory" : "file",
    size: stats.size,
    modifiedAt: stats.mtime.toISOString()
  };
}

export const accountPanelRoutes: FastifyPluginAsync = async (app) => {
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
      prisma.domain.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.deployment.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.mailAccount.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10, include: { domain: true } }),
      prisma.accountDatabase.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10 })
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

  app.get("/domains", async (request: any) =>
    prisma.domain.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" } })
  );

  app.post("/domains", async (request: any, reply) => {
    const body = createDomainSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    assertLimit(account._count.domains, account.domainLimit, "Domain");
    try {
      const domain = await prisma.domain.create({
        data: {
          name: body.name,
          accountId: account.id,
          forceSsl: body.forceSsl,
          hostingMode: "PUBLIC_HTML",
          documentRoot: `accounts/${account.username}/public_html`
        }
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

  app.get("/deployments", async (request: any) =>
    prisma.deployment.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" } })
  );

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
    return reply.code(201).send(deployment);
  });

  app.get("/deployments/:deploymentId/logs", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await prisma.deployment.findFirstOrThrow({ where: { id: deploymentId, accountId: accountId(request) } });
    return prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id },
      orderBy: { createdAt: "asc" },
      take: 200
    });
  });

  app.post("/deployments/:deploymentId/:action", async (request: any, reply) => {
    const params = z.object({
      deploymentId: z.string(),
      action: z.enum(["deploy", "redeploy", "start", "stop", "restart"])
    }).parse(request.params);
    const deployment = await prisma.deployment.findFirstOrThrow({ where: { id: params.deploymentId, accountId: accountId(request) } });
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
    return reply.code(202).send({ queued: true, jobId: queue.id, release });
  });

  app.get("/databases", async (request: any) =>
    prisma.accountDatabase.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" } })
  );

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

  app.get("/files/list", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    await fs.mkdir(resolved, { recursive: true });
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) throw app.httpErrors.badRequest("Path is not a directory");
    const names = await fs.readdir(resolved);
    const items = await Promise.all(names.map((name) => fileEntry(account, path.join(resolved, name))));
    return {
      current: await fileEntry(account, resolved),
      root: account.homeRoot,
      items: items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)
    };
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

  app.delete("/files/delete", async (request: any) => {
    const body = fileDeleteSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved, relative } = safeAccountPath(account, body.path);
    if (relative === ".") throw app.httpErrors.badRequest("Account root cannot be deleted");
    await fs.rm(resolved, { recursive: true, force: true });
    await audit(request, { action: "DELETE", resource: "account_file", resourceId: account.id, description: `Account deleted ${body.path}` });
    return { ok: true };
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
