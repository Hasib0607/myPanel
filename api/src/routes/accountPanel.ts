import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";

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
  enabled: z.boolean().optional()
});
const unsafeName = /[<>:"|?*\x00-\x1F]/;

function usageFrom(account: any) {
  return {
    domains: account._count.domains,
    deployments: account._count.deployments,
    mailAccounts: account._count.mailAccounts,
    databases: account.deployments?.filter((deployment: any) => deployment.dbType).length ?? 0,
    diskLimitMb: account.diskLimitMb,
    domainLimit: account.domainLimit,
    mailboxLimit: account.mailboxLimit,
    databaseLimit: account.databaseLimit,
    deploymentLimit: account.deploymentLimit
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
    const [account, domains, deployments, mailAccounts] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id }, include: { deployments: { select: { dbType: true } }, _count: { select: { domains: true, deployments: true, mailAccounts: true } } } }),
      prisma.domain.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.deployment.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.mailAccount.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 10, include: { domain: true } })
    ]);
    return {
      account: safeAccount(account),
      usage: usageFrom(account),
      domains,
      deployments,
      mailAccounts,
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

  app.get("/deployments", async (request: any) =>
    prisma.deployment.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" } })
  );

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
    const mailbox = await prisma.mailAccount.updateMany({
      where: { id: mailboxId, accountId: accountId(request) },
      data: body
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
