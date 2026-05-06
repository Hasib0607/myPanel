import bcrypt from "bcrypt";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { mailQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const mailboxSchema = z.object({
  domainId: z.string(),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]+$/),
  password: z.string().min(10),
  quotaMb: z.number().int().min(128).default(1024)
});

const updateMailboxSchema = z.object({
  quotaMb: z.number().int().min(128).optional(),
  enabled: z.boolean().optional()
});

const resetPasswordSchema = z.object({
  password: z.string().min(10)
});

const aliasSchema = z.object({
  domainId: z.string(),
  source: z.string().trim().toLowerCase().min(1),
  target: z.string().trim().toLowerCase().min(3),
  accountId: z.string().nullable().optional()
});

const folderSchema = z.enum(["INBOX", "SENT", "DRAFTS", "SPAM", "TRASH"]);

const messageActionSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  folder: folderSchema.optional()
});

const composeSchema = z.object({
  accountId: z.string(),
  to: z.string().email(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional()
});

export const mailRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  async function bestEffortSysagent(request: any, action: () => Promise<unknown>) {
    return action().catch((error) => {
      request.log.warn({ error }, "mail sysagent bridge failed");
      return { dryRun: true, unavailable: true, error: error instanceof Error ? error.message : "sysagent unavailable" };
    });
  }

  app.get("/accounts", async (request) => {
    const query = z.object({ domainId: z.string().optional() }).parse(request.query);
    return prisma.mailAccount.findMany({
      where: query.domainId ? { domainId: query.domainId } : {},
      include: { domain: { select: { name: true } } },
      orderBy: { createdAt: "desc" }
    });
  });

  app.post("/accounts", async (request, reply) => {
    const body = mailboxSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const account = await prisma.mailAccount.create({
      data: {
        domainId: body.domainId,
        username: body.username,
        passwordHash,
        quotaMb: body.quotaMb
      }
    });
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: account.domainId } });
    await bestEffortSysagent(request, () => sysagent.createMailbox({ email: `${account.username}@${domain.name}`, quotaMb: account.quotaMb }));
    await audit(request, { action: "CREATE", resource: "mail_account", resourceId: account.id, description: `Created mailbox ${account.username}` });
    return reply.code(201).send(account);
  });

  app.patch("/accounts/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = updateMailboxSchema.parse(request.body);
    return prisma.mailAccount.update({ where: { id: accountId }, data: body });
  });

  app.post("/accounts/:accountId/reset-password", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = resetPasswordSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    return prisma.mailAccount.update({ where: { id: accountId }, data: { passwordHash } });
  });

  app.delete("/accounts/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    await prisma.mailAccount.delete({ where: { id: accountId } });
    return { ok: true };
  });

  app.get("/accounts/:accountId/messages", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const query = z.object({
      folder: folderSchema.default("INBOX"),
      search: z.string().optional()
    }).parse(request.query);
    return prisma.mail.findMany({
      where: {
        accountId,
        folder: query.folder,
        ...(query.search
          ? {
              OR: [
                { subject: { contains: query.search, mode: "insensitive" as const } },
                { fromAddress: { contains: query.search, mode: "insensitive" as const } },
                { toAddress: { contains: query.search, mode: "insensitive" as const } }
              ]
            }
          : {})
      },
      orderBy: { receivedAt: "desc" },
      take: 100
    });
  });

  app.get("/accounts/:accountId/folders", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const groups = await prisma.mail.groupBy({
      by: ["folder"],
      where: { accountId },
      _count: true
    });
    return ["INBOX", "SENT", "DRAFTS", "SPAM", "TRASH"].map((folder) => ({
      folder,
      count: groups.find((group) => group.folder === folder)?._count ?? 0
    }));
  });

  app.patch("/messages/:messageId", async (request) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
    const body = messageActionSchema.parse(request.body);
    return prisma.mail.update({ where: { id: messageId }, data: body });
  });

  app.delete("/messages/:messageId", async (request) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
    await prisma.mail.update({ where: { id: messageId }, data: { folder: "TRASH" } });
    return { ok: true };
  });

  app.post("/compose", async (request, reply) => {
    const body = composeSchema.parse(request.body);
    const account = await prisma.mailAccount.findUniqueOrThrow({
      where: { id: body.accountId },
      include: { domain: true }
    });
    const from = `${account.username}@${account.domain.name}`;
    const job = await mailQueue.add("send", { ...body, from });
    const sent = await prisma.mail.create({
      data: {
        accountId: body.accountId,
        messageId: `local-${job.id}-${Date.now()}@${account.domain.name}`,
        fromAddress: from,
        toAddress: body.to,
        subject: body.subject,
        folder: "SENT",
        isRead: true,
        receivedAt: new Date()
      }
    });
    return reply.code(202).send({ queued: true, jobId: job.id, message: sent });
  });

  app.get("/aliases", async (request) => {
    const query = z.object({ domainId: z.string().optional() }).parse(request.query);
    return prisma.mailAlias.findMany({
      where: query.domainId ? { domainId: query.domainId } : {},
      orderBy: { source: "asc" }
    });
  });

  app.post("/aliases", async (request, reply) => {
    const body = aliasSchema.parse(request.body);
    const alias = await prisma.mailAlias.create({ data: body });
    await bestEffortSysagent(request, () => sysagent.updateMailAlias({ source: alias.source, target: alias.target }));
    await audit(request, { action: "CREATE", resource: "mail_alias", resourceId: alias.id, description: `Created mail alias ${alias.source}` });
    return reply.code(201).send(alias);
  });

  app.delete("/aliases/:aliasId", async (request) => {
    const { aliasId } = z.object({ aliasId: z.string() }).parse(request.params);
    await prisma.mailAlias.delete({ where: { id: aliasId } });
    return { ok: true };
  });

  app.get("/domains/:domainId/auth-status", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { dnsRecords: true, mailAccounts: true }
    });

    const txt = domain.dnsRecords.filter((record) => record.type === "TXT");
    const mx = domain.dnsRecords.filter((record) => record.type === "MX");
    const spf = txt.find((record) => record.value.toLowerCase().includes("v=spf1"));
    const dmarc = txt.find((record) => record.name.toLowerCase() === "_dmarc" && record.value.toLowerCase().includes("v=dmarc1"));
    const dkim = txt.find((record) => record.name.toLowerCase().includes("._domainkey"));

    return {
      domain: domain.name,
      mailboxCount: domain.mailAccounts.length,
      checks: [
        { key: "mx", label: "MX", ok: mx.length > 0, detail: mx.length > 0 ? `${mx.length} MX record(s)` : "Missing MX record" },
        { key: "spf", label: "SPF", ok: Boolean(spf), detail: spf?.value ?? "Missing SPF TXT record" },
        { key: "dkim", label: "DKIM", ok: Boolean(dkim), detail: dkim?.name ?? "Missing DKIM TXT record" },
        { key: "dmarc", label: "DMARC", ok: Boolean(dmarc), detail: dmarc?.value ?? "Missing DMARC TXT record" },
        { key: "ptr", label: "PTR / rDNS", ok: false, detail: "Set reverse DNS at the VPS provider; panel can only remind you." }
      ]
    };
  });

  app.post("/domains/:domainId/dkim/setup", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const result = await sysagent.setupDkim({ domain: domain.name });
    return reply.code(202).send({ queued: false, dryRunResult: result });
  });

  app.post("/services/reload", async (_request, reply) => {
    const result = await sysagent.reloadMailServices();
    return reply.code(202).send({ queued: false, dryRunResult: result });
  });
};
