import { prisma } from "./prisma.js";
import { sysagent } from "./sysagent.js";

export async function syncMailboxInbox(accountId: string) {
  const account = await prisma.mailAccount.findUnique({
    where: { id: accountId },
    include: { domain: { select: { name: true } } }
  });
  if (!account || !account.enabled) return { synced: 0 };

  const email = `${account.username}@${account.domain.name}`;
  const result = await sysagent.mailboxMessages({ email, maxMessages: 250 });
  let synced = 0;
  for (const message of result.messages) {
    await prisma.mail.upsert({
      where: { accountId_messageId: { accountId, messageId: message.messageId } },
      create: {
        accountId,
        messageId: message.messageId,
        fromAddress: message.fromAddress,
        toAddress: message.toAddress || email,
        subject: message.subject,
        bodyText: message.bodyText ?? null,
        bodyHtml: message.bodyHtml ?? null,
        folder: "INBOX",
        deliveryStatus: "RECEIVED",
        receivedAt: new Date(message.receivedAt)
      },
      update: {
        fromAddress: message.fromAddress,
        toAddress: message.toAddress || email,
        subject: message.subject,
        bodyText: message.bodyText ?? null,
        bodyHtml: message.bodyHtml ?? null
      }
    });
    synced += 1;
  }
  return { synced };
}
