import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { mailQueue } from "../jobs/queues.js";
import { prisma } from "../lib/prisma.js";

const folderSchema = z.enum(["INBOX", "SENT", "DRAFTS", "SPAM", "TRASH"]);

const messageActionSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  folder: folderSchema.optional()
});

const composeSchema = z.object({
  to: z.string().email(),
  subject: z.string().trim().min(1).max(255),
  html: z.string().min(1).max(200_000),
  text: z.string().max(200_000).optional()
});

function mailAccountId(request: any) {
  return request.user.mailAccountId as string;
}

export const webmailRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireMail);

  app.get("/me", async (request: any) => {
    const mailbox = await prisma.mailAccount.findUniqueOrThrow({
      where: { id: mailAccountId(request) },
      include: { domain: { select: { name: true } } }
    });
    return {
      id: mailbox.id,
      email: `${mailbox.username}@${mailbox.domain.name}`,
      username: mailbox.username,
      quotaMb: mailbox.quotaMb,
      enabled: mailbox.enabled,
      domain: mailbox.domain
    };
  });

  app.get("/folders", async (request: any) => {
    const groups = await prisma.mail.groupBy({
      by: ["folder"],
      where: { accountId: mailAccountId(request) },
      _count: true
    });
    return ["INBOX", "SENT", "DRAFTS", "SPAM", "TRASH"].map((folder) => ({
      folder,
      count: groups.find((group) => group.folder === folder)?._count ?? 0
    }));
  });

  app.get("/messages", async (request: any) => {
    const query = z.object({
      folder: folderSchema.default("INBOX"),
      search: z.string().trim().optional()
    }).parse(request.query);
    return prisma.mail.findMany({
      where: {
        accountId: mailAccountId(request),
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

  app.patch("/messages/:messageId", async (request: any) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
    const body = messageActionSchema.parse(request.body);
    const result = await prisma.mail.updateMany({
      where: { id: messageId, accountId: mailAccountId(request) },
      data: body
    });
    if (result.count === 0) throw app.httpErrors.notFound("Message not found");
    return { ok: true };
  });

  app.delete("/messages/:messageId", async (request: any) => {
    const { messageId } = z.object({ messageId: z.string() }).parse(request.params);
    const result = await prisma.mail.updateMany({
      where: { id: messageId, accountId: mailAccountId(request) },
      data: { folder: "TRASH" }
    });
    if (result.count === 0) throw app.httpErrors.notFound("Message not found");
    return { ok: true };
  });

  app.post("/compose", async (request: any, reply) => {
    const body = composeSchema.parse(request.body);
    const account = await prisma.mailAccount.findUniqueOrThrow({
      where: { id: mailAccountId(request) },
      include: { domain: true }
    });
    const from = `${account.username}@${account.domain.name}`;
    const job = await mailQueue.add("send", { ...body, accountId: account.id, from });
    const sent = await prisma.mail.create({
      data: {
        accountId: account.id,
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
};
