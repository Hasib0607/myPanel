import bcrypt from "bcrypt";
import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/);

const accountSchema = z.object({
  username: usernameSchema,
  email: z.string().email().nullable().optional(),
  ownerName: z.string().trim().min(1).nullable().optional(),
  password: z.string().min(10).max(128).optional(),
  packageName: z.string().trim().min(1).nullable().optional(),
  diskLimitMb: z.number().int().min(0).nullable().optional(),
  domainLimit: z.number().int().min(0).nullable().optional(),
  mailboxLimit: z.number().int().min(0).nullable().optional(),
  databaseLimit: z.number().int().min(0).nullable().optional(),
  deploymentLimit: z.number().int().min(0).nullable().optional()
});

const accountUpdateSchema = accountSchema.omit({ username: true, password: true }).partial().extend({
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional()
});
const assignmentSchema = z.object({
  resourceType: z.enum(["domain", "deployment", "mailAccount"]),
  resourceId: z.string().min(1)
});
const deleteQuerySchema = z.object({
  linkedResourceAction: z.enum(["unassign", "delete"]).optional()
});

function generatedPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function accountHomeRoot(username: string) {
  return `${env.FILE_MANAGER_ROOT.replace(/\/+$/, "")}/accounts/${username}`;
}

function publicAccount(account: any, generated?: string) {
  const { passwordHash: _passwordHash, ...safe } = account;
  return generated ? { ...safe, generatedPassword: generated } : safe;
}

async function usageFor(accountId: string) {
  const [domains, deployments, mailAccounts, databases] = await Promise.all([
    prisma.domain.count({ where: { accountId } }),
    prisma.deployment.count({ where: { accountId } }),
    prisma.mailAccount.count({ where: { accountId } }),
    prisma.deployment.count({ where: { accountId, dbType: { not: null } } })
  ]);
  return { domains, deployments, mailAccounts, databases };
}

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (request) => {
    const query = z.object({
      search: z.string().optional(),
      status: z.enum(["ACTIVE", "SUSPENDED"]).optional()
    }).parse(request.query);
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? {
        OR: [
          { username: { contains: query.search, mode: "insensitive" as const } },
          { email: { contains: query.search, mode: "insensitive" as const } },
          { ownerName: { contains: query.search, mode: "insensitive" as const } }
        ]
      } : {})
    };
    return {
      items: await prisma.account.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
      })
    };
  });

  app.post("/", async (request, reply) => {
    const body = accountSchema.parse(request.body);
    const password = body.password ?? generatedPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const account = await prisma.account.create({
      data: {
        username: body.username,
        email: body.email ?? null,
        ownerName: body.ownerName ?? null,
        passwordHash,
        homeRoot: accountHomeRoot(body.username),
        packageName: body.packageName ?? null,
        diskLimitMb: body.diskLimitMb ?? null,
        domainLimit: body.domainLimit ?? null,
        mailboxLimit: body.mailboxLimit ?? null,
        databaseLimit: body.databaseLimit ?? null,
        deploymentLimit: body.deploymentLimit ?? null
      },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    const scaffold = await sysagent.createAccountScaffold({ username: account.username }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    await audit(request, { action: "CREATE", resource: "account", resourceId: account.id, description: `Created account ${account.username}`, metadata: { scaffold } as any });
    return reply.code(201).send({ ...publicAccount(account, body.password ? undefined : password), scaffold });
  });

  app.get("/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const account = await prisma.account.findFirstOrThrow({
      where: { OR: [{ id: accountId }, { username: accountId }] },
      include: {
        domains: { orderBy: { createdAt: "desc" }, take: 20 },
        deployments: { orderBy: { createdAt: "desc" }, take: 20 },
        mailAccounts: { orderBy: { createdAt: "desc" }, take: 20 },
        _count: { select: { domains: true, deployments: true, mailAccounts: true } }
      }
    });
    const [usage, activity] = await Promise.all([
      usageFor(account.id),
      prisma.auditLog.findMany({
        where: {
          OR: [
            { resourceId: account.id },
            { actor: `account:${account.id}` }
          ]
        },
        orderBy: { createdAt: "desc" },
        take: 25
      })
    ]);
    return { ...publicAccount(account), usage, activity };
  });

  app.get("/:accountId/assignable", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const [domains, deployments, mailAccounts] = await Promise.all([
      prisma.domain.findMany({ where: { accountId: null }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.deployment.findMany({ where: { accountId: null }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.mailAccount.findMany({ where: { accountId: null }, orderBy: { createdAt: "desc" }, take: 100, include: { domain: true } })
    ]);
    return { domains, deployments, mailAccounts };
  });

  app.patch("/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = accountUpdateSchema.parse(request.body);
    const existing = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const account = await prisma.account.update({
      where: { id: existing.id },
      data: body,
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    if (body.status === "SUSPENDED") {
      await prisma.$transaction([
        prisma.deployment.updateMany({ where: { accountId: account.id }, data: { status: "STOPPED", healthStatus: "DOWN" } }),
        prisma.mailAccount.updateMany({ where: { accountId: account.id }, data: { enabled: false } })
      ]);
    }
    await audit(request, { action: "UPDATE", resource: "account", resourceId: account.id, description: `Updated account ${account.username}` });
    return publicAccount(account);
  });

  app.post("/:accountId/password", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = z.object({ password: z.string().min(10).max(128).optional() }).parse(request.body ?? {});
    const existing = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const password = body.password ?? generatedPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const account = await prisma.account.update({ where: { id: existing.id }, data: { passwordHash } });
    await audit(request, { action: "UPDATE", resource: "account", resourceId: account.id, description: `Reset password for account ${account.username}` });
    return { id: account.id, username: account.username, generatedPassword: body.password ? undefined : password };
  });

  app.post("/:accountId/assign", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = assignmentSchema.parse(request.body);
    const account = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const data = { accountId: account.id };
    const result = body.resourceType === "domain"
      ? await prisma.domain.update({ where: { id: body.resourceId }, data })
      : body.resourceType === "deployment"
        ? await prisma.deployment.update({ where: { id: body.resourceId }, data })
        : await prisma.mailAccount.update({ where: { id: body.resourceId }, data });
    await audit(request, { action: "UPDATE", resource: "account_assignment", resourceId: account.id, description: `Assigned ${body.resourceType} to ${account.username}`, metadata: { resourceId: body.resourceId } as any });
    return result;
  });

  app.post("/:accountId/unassign", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = assignmentSchema.parse(request.body);
    const account = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const data = { accountId: null };
    const where = { id: body.resourceId, accountId: account.id };
    const result = body.resourceType === "domain"
      ? await prisma.domain.updateMany({ where, data })
      : body.resourceType === "deployment"
        ? await prisma.deployment.updateMany({ where, data })
        : await prisma.mailAccount.updateMany({ where, data });
    await audit(request, { action: "UPDATE", resource: "account_assignment", resourceId: account.id, description: `Unassigned ${body.resourceType} from ${account.username}`, metadata: { resourceId: body.resourceId } as any });
    return result;
  });

  app.delete("/:accountId", async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const query = deleteQuerySchema.parse(request.query);
    const existing = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const usage = await usageFor(existing.id);
    const linkedTotal = usage.domains + usage.deployments + usage.mailAccounts;
    if (linkedTotal > 0 && !query.linkedResourceAction) {
      return reply.code(409).send({ error: "Account has linked resources. Choose unassign or delete linked resources first.", usage });
    }
    if (query.linkedResourceAction === "delete") {
      await prisma.$transaction([
        prisma.mailAccount.deleteMany({ where: { accountId: existing.id } }),
        prisma.deployment.deleteMany({ where: { accountId: existing.id } }),
        prisma.domain.deleteMany({ where: { accountId: existing.id } })
      ]);
    } else if (query.linkedResourceAction === "unassign") {
      await prisma.$transaction([
        prisma.mailAccount.updateMany({ where: { accountId: existing.id }, data: { accountId: null } }),
        prisma.deployment.updateMany({ where: { accountId: existing.id }, data: { accountId: null } }),
        prisma.domain.updateMany({ where: { accountId: existing.id }, data: { accountId: null } })
      ]);
    }
    await prisma.account.delete({ where: { id: existing.id } });
    await audit(request, { action: "DELETE", resource: "account", resourceId: existing.id, description: `Deleted account ${existing.username}`, metadata: { linkedResourceAction: query.linkedResourceAction ?? "none", usage } as any });
    return { ok: true };
  });
};
