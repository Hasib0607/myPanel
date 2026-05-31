import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";

const packageSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  diskLimitMb: z.number().int().min(0).nullable().optional(),
  domainLimit: z.number().int().min(0).nullable().optional(),
  mailboxLimit: z.number().int().min(0).nullable().optional(),
  databaseLimit: z.number().int().min(0).nullable().optional(),
  deploymentLimit: z.number().int().min(0).nullable().optional(),
  isDefault: z.boolean().default(false)
});

function packageData(body: z.infer<typeof packageSchema>) {
  return {
    name: body.name,
    description: body.description ?? null,
    diskLimitMb: body.diskLimitMb ?? null,
    domainLimit: body.domainLimit ?? null,
    mailboxLimit: body.mailboxLimit ?? null,
    databaseLimit: body.databaseLimit ?? null,
    deploymentLimit: body.deploymentLimit ?? null,
    isDefault: body.isDefault
  };
}

async function clearDefaultIfNeeded(packageId: string | null, isDefault: boolean) {
  if (!isDefault) return;
  await prisma.accountPackage.updateMany({
    where: packageId ? { id: { not: packageId }, isDefault: true } : { isDefault: true },
    data: { isDefault: false }
  });
}

export const packageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async () => ({
    items: await prisma.accountPackage.findMany({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      include: { _count: { select: { accounts: true } } }
    })
  }));

  app.post("/", async (request, reply) => {
    const body = packageSchema.parse(request.body);
    await clearDefaultIfNeeded(null, body.isDefault);
    const accountPackage = await prisma.accountPackage.create({ data: packageData(body) });
    await audit(request, { action: "CREATE", resource: "account_package", resourceId: accountPackage.id, description: `Created package ${accountPackage.name}` });
    return reply.code(201).send(accountPackage);
  });

  app.patch("/:packageId", async (request) => {
    const { packageId } = z.object({ packageId: z.string() }).parse(request.params);
    const body = packageSchema.partial().parse(request.body);
    if (body.isDefault !== undefined) await clearDefaultIfNeeded(packageId, body.isDefault);
    const accountPackage = await prisma.accountPackage.update({ where: { id: packageId }, data: body });
    await audit(request, { action: "UPDATE", resource: "account_package", resourceId: accountPackage.id, description: `Updated package ${accountPackage.name}` });
    return accountPackage;
  });

  app.post("/:packageId/apply/:accountId", async (request) => {
    const { packageId, accountId } = z.object({ packageId: z.string(), accountId: z.string() }).parse(request.params);
    const accountPackage = await prisma.accountPackage.findUniqueOrThrow({ where: { id: packageId } });
    const account = await prisma.account.findFirstOrThrow({ where: { OR: [{ id: accountId }, { username: accountId }] } });
    const updated = await prisma.account.update({
      where: { id: account.id },
      data: {
        packageId: accountPackage.id,
        packageName: accountPackage.name,
        diskLimitMb: accountPackage.diskLimitMb,
        domainLimit: accountPackage.domainLimit,
        mailboxLimit: accountPackage.mailboxLimit,
        databaseLimit: accountPackage.databaseLimit,
        deploymentLimit: accountPackage.deploymentLimit
      }
    });
    await audit(request, { action: "UPDATE", resource: "account", resourceId: account.id, description: `Applied package ${accountPackage.name} to ${account.username}` });
    return updated;
  });

  app.delete("/:packageId", async (request) => {
    const { packageId } = z.object({ packageId: z.string() }).parse(request.params);
    const existing = await prisma.accountPackage.findUniqueOrThrow({ where: { id: packageId } });
    await prisma.accountPackage.delete({ where: { id: existing.id } });
    await audit(request, { action: "DELETE", resource: "account_package", resourceId: existing.id, description: `Deleted package ${existing.name}` });
    return { ok: true };
  });
};
