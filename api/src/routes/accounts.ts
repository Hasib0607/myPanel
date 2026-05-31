import bcrypt from "bcrypt";
import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/);

const accountSchema = z.object({
  username: usernameSchema,
  email: z.string().email().nullable().optional(),
  ownerName: z.string().trim().min(1).nullable().optional(),
  password: z.string().min(10).max(128).optional(),
  packageName: z.string().trim().min(1).nullable().optional(),
  diskLimitMb: z.number().int().min(0).nullable().optional(),
  domainLimit: z.number().int().min(0).nullable().optional()
});

const accountUpdateSchema = accountSchema.omit({ username: true, password: true }).partial().extend({
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional()
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
        domainLimit: body.domainLimit ?? null
      },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    await audit(request, { action: "CREATE", resource: "account", resourceId: account.id, description: `Created account ${account.username}` });
    return reply.code(201).send(publicAccount(account, body.password ? undefined : password));
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
    return publicAccount(account);
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

  app.delete("/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const existing = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    await prisma.account.delete({ where: { id: existing.id } });
    await audit(request, { action: "DELETE", resource: "account", resourceId: existing.id, description: `Deleted account ${existing.username}` });
    return { ok: true };
  });
};
