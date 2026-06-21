import { prisma } from "./prisma.js";

export async function consumeMailboxSendAllowance(accountId: string) {
  await prisma.$transaction(async (tx) => {
    const account = await tx.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
    if (!account.enabled || account.smtpSuspended) {
      throw Object.assign(new Error("SMTP sending is suspended for this mailbox"), { statusCode: 403 });
    }

    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const counterDay = account.sendCounterDate
      ? Date.UTC(account.sendCounterDate.getUTCFullYear(), account.sendCounterDate.getUTCMonth(), account.sendCounterDate.getUTCDate())
      : null;
    const sentToday = counterDay === today ? account.sentToday : 0;
    if (sentToday >= account.dailySendLimit) {
      throw Object.assign(new Error(`Daily send limit of ${account.dailySendLimit} reached`), { statusCode: 429 });
    }

    const recent = await tx.mail.count({
      where: { accountId, folder: "SENT", receivedAt: { gte: new Date(now.getTime() - 60_000) }, deliveryStatus: { in: ["PENDING", "SENT"] } }
    });
    if (recent >= account.minuteSendLimit) {
      throw Object.assign(new Error(`Per-minute send limit of ${account.minuteSendLimit} reached`), { statusCode: 429 });
    }

    await tx.mailAccount.update({ where: { id: accountId }, data: { sentToday: sentToday + 1, sendCounterDate: now } });
  }, { isolationLevel: "Serializable" });
}
