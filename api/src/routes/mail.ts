import bcrypt from "bcrypt";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { mailQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { publishDomainDnsZone } from "../lib/domainDnsPublish.js";
import { nginxResourceName } from "../lib/nginxNames.js";
import { prisma } from "../lib/prisma.js";
import { currentVpsIp } from "../lib/serverIp.js";
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

const smtpConfigureSchema = z.object({
  hostname: z.string().trim().min(1).optional(),
  messageRateLimit: z.coerce.number().int().min(1).max(10000).default(60)
});

export const mailRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  async function bestEffortSysagent(request: any, action: () => Promise<unknown>) {
    return action().catch((error) => {
      request.log.warn({ error }, "mail sysagent bridge failed");
      return { dryRun: true, unavailable: true, error: error instanceof Error ? error.message : "sysagent unavailable" };
    });
  }

  app.get("/server/status", async () => {
    const [stack, firewall] = await Promise.all([
      sysagent.mailStackStatus(),
      sysagent.mailFirewallStatus()
    ]);
    return { stack, firewall };
  });

  app.post("/server/install", async (request, reply) => {
    const result = await sysagent.installMailStack();
    await audit(request, { action: "APPLY", resource: "mail_stack", description: "Installed and started the mail server stack" });
    return reply.code(202).send(result);
  });

  app.post("/server/firewall/apply", async (request, reply) => {
    const result = await sysagent.applyMailFirewall();
    const ports = [25, 143, 465, 587, 993];
    for (const port of ports) {
      const existing = await prisma.firewallRule.findFirst({ where: { port, protocol: "tcp", direction: "IN", action: "ALLOW" } });
      if (!existing) {
        await prisma.firewallRule.create({ data: { port, protocol: "tcp", direction: "IN", action: "ALLOW", note: "Mail server preset" } });
      }
    }
    await audit(request, { action: "APPLY", resource: "mail_firewall", description: "Opened mail server firewall ports", metadata: { ports } });
    return reply.code(202).send(result);
  });

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
    await bestEffortSysagent(request, () => sysagent.createMailbox({ email: `${account.username}@${domain.name}`, quotaMb: account.quotaMb, passwordHash, enabled: account.enabled }));
    await audit(request, { action: "CREATE", resource: "mail_account", resourceId: account.id, description: `Created mailbox ${account.username}` });
    return reply.code(201).send(account);
  });

  app.patch("/accounts/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = updateMailboxSchema.parse(request.body);
    const account = await prisma.mailAccount.update({ where: { id: accountId }, data: body, include: { domain: true } });
    await bestEffortSysagent(request, () => sysagent.createMailbox({
      email: `${account.username}@${account.domain.name}`,
      quotaMb: account.quotaMb,
      passwordHash: account.passwordHash,
      enabled: account.enabled
    }));
    return account;
  });

  app.post("/accounts/:accountId/reset-password", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = resetPasswordSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const account = await prisma.mailAccount.update({ where: { id: accountId }, data: { passwordHash }, include: { domain: true } });
    await bestEffortSysagent(request, () => sysagent.createMailbox({ email: `${account.username}@${account.domain.name}`, quotaMb: account.quotaMb, passwordHash, enabled: account.enabled }));
    return account;
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

  app.get("/domains/:domainId/smtp-settings", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { mailAccounts: { orderBy: { username: "asc" } } }
    });
    const host = `mail.${domain.name}`;
    return {
      domain: domain.name,
      host,
      ports: [
        { port: 587, security: "STARTTLS", recommended: true },
        { port: 465, security: "SSL/TLS", recommended: false },
        { port: 25, security: "Server-to-server SMTP", recommended: false }
      ],
      auth: "Use full mailbox address and mailbox password.",
      usernames: domain.mailAccounts.map((account) => `${account.username}@${domain.name}`),
      rateLimit: 60,
      rateWindowSeconds: 60,
      notes: [
        "Submission port 587 requires TLS before auth.",
        "Use Sync all mailboxes after enabling SMTP to provision existing password hashes and quotas.",
        "PTR/rDNS must be set at the VPS provider."
      ]
    };
  });

  app.get("/domains/:domainId/tls/status", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const hostname = `mail.${domain.name}`;
    const certificate = await sysagent.certificateStatus(hostname);
    return { hostname, ...certificate };
  });

  app.post("/domains/:domainId/tls/issue", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ email: z.string().email().optional() }).parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const hostname = `mail.${domain.name}`;
    await ensureMailDns(domain.id, domain.name);
    const webRoot = path.join(env.FILE_MANAGER_ROOT, domain.name, domain.documentRoot || "public_html");
    await sysagent.writeStaticNginxVhost({
      name: `mail-${nginxResourceName(domain.name)}`,
      serverName: hostname,
      rootPath: webRoot,
      forceHttps: false
    });
    const preflight = await sysagent.sslPreflight({ domain: hostname, webRoot, includeWww: false });
    if (!mailCommandSucceeded(preflight.certbot)) {
      throw Object.assign(new Error(`Certbot is not ready for ${hostname}: ${preflight.certbot.stderr || "preflight failed"}`), { statusCode: 400 });
    }
    const checks = preflight.localChecks?.length ? preflight.localChecks : preflight.checks;
    const failed = checks.find((check) => !mailCommandSucceeded(check));
    if (failed) {
      throw Object.assign(new Error(`ACME challenge failed for ${hostname}: ${failed.stderr || failed.stdout || "HTTP validation failed"}`), { statusCode: 400 });
    }
    const issue = await sysagent.issueCertificate({
      domain: hostname,
      email: body.email ?? `admin@${domain.name}`,
      webRoot,
      includeWww: false,
      certName: hostname
    });
    if (!mailCommandSucceeded(issue)) {
      throw Object.assign(new Error(`Certificate issue failed for ${hostname}: ${issue.stderr || issue.stdout || "Certbot failed"}`), { statusCode: 400 });
    }
    const certificate = await sysagent.certificateStatus(hostname);
    if (!certificate.exists) throw Object.assign(new Error(`Certbot completed but no certificate was found for ${hostname}`), { statusCode: 500 });
    const attach = await sysagent.configureSmtp({
      domain: domain.name,
      hostname,
      certificatePath: certificate.certificate,
      keyPath: certificate.privateKey,
      messageRateLimit: 60
    });
    await audit(request, { action: "APPLY", resource: "mail_tls", resourceId: domainId, description: `Issued and attached mail TLS for ${hostname}` });
    return reply.code(202).send({ hostname, preflight, issue, certificate, attach });
  });

  app.post("/domains/:domainId/tls/renew", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const hostname = `mail.${domain.name}`;
    const renew = await sysagent.renewCertificate(hostname);
    if (!mailCommandSucceeded(renew)) {
      throw Object.assign(new Error(`Certificate renewal failed for ${hostname}: ${renew.stderr || renew.stdout || "Certbot failed"}`), { statusCode: 400 });
    }
    const certificate = await sysagent.certificateStatus(hostname);
    const attach = await sysagent.configureSmtp({
      domain: domain.name,
      hostname,
      certificatePath: certificate.certificate,
      keyPath: certificate.privateKey,
      messageRateLimit: 60
    });
    await audit(request, { action: "APPLY", resource: "mail_tls", resourceId: domainId, description: `Renewed and reattached mail TLS for ${hostname}` });
    return reply.code(202).send({ hostname, renew, certificate, attach });
  });

  app.get("/domains/:domainId/dns-recommendations", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, include: { dnsRecords: true } });
    const vpsIp = await currentVpsIp();
    const recommended = mailDnsRecords(domain.id, domain.name, vpsIp);
    return {
      domain: domain.name,
      records: recommended.map((record) => ({
        ...record,
        exists: domain.dnsRecords.some((existing) => sameMailDnsRecord(existing, record)),
        current: domain.dnsRecords.filter((existing) => existing.type === record.type && existing.name === record.name)
      }))
    };
  });

  app.post("/domains/:domainId/dns-recommendations/apply", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, include: { dnsRecords: true } });
    const vpsIp = await currentVpsIp();
    const records = mailDnsRecords(domain.id, domain.name, vpsIp);
    const changed = [];
    for (const record of records) {
      const existing = await prisma.dnsRecord.findFirst({ where: { domainId, type: record.type, name: record.name } });
      if (existing) {
        await prisma.dnsRecord.update({ where: { id: existing.id }, data: { value: record.value, ttl: record.ttl, priority: record.priority } });
        changed.push({ action: "updated", record });
      } else {
        await prisma.dnsRecord.create({ data: record });
        changed.push({ action: "created", record });
      }
    }
    const publish = await publishDomainDnsZone(domainId);
    await audit(request, { action: "APPLY", resource: "mail_dns", resourceId: domainId, description: `Applied mail DNS records for ${domain.name}`, metadata: { changed } });
    return { ok: true, changed, publish };
  });

  app.post("/domains/:domainId/dkim/setup", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const result = await sysagent.setupDkim({ domain: domain.name });
    const recordValue = typeof (result as any)?.recordValue === "string" ? (result as any).recordValue : null;
    if (recordValue) {
      const existing = await prisma.dnsRecord.findFirst({ where: { domainId, type: "TXT", name: "mail._domainkey" } });
      if (existing) {
        await prisma.dnsRecord.update({ where: { id: existing.id }, data: { value: recordValue, ttl: 3600 } });
      } else {
        await prisma.dnsRecord.create({ data: { domainId, type: "TXT", name: "mail._domainkey", value: recordValue, ttl: 3600 } });
      }
      await publishDomainDnsZone(domainId);
    }
    return reply.code(202).send({ queued: false, dryRunResult: result });
  });

  app.post("/domains/:domainId/mailboxes/sync", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({
      where: { id: domainId },
      include: { mailAccounts: { orderBy: { username: "asc" } } }
    });
    const mailboxes = domain.mailAccounts.map((account) => ({
      email: `${account.username}@${domain.name}`,
      quotaMb: account.quotaMb,
      passwordHash: account.passwordHash,
      enabled: account.enabled
    }));
    const result = await sysagent.syncMailboxes({ mailboxes });
    await audit(request, { action: "APPLY", resource: "mailbox_sync", resourceId: domainId, description: `Synced ${mailboxes.length} mailboxes for ${domain.name}`, metadata: { count: mailboxes.length } });
    return reply.code(202).send({ ok: true, synced: mailboxes.length, result });
  });

  app.post("/domains/:domainId/smtp/configure", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = smtpConfigureSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const hostname = body.hostname || `mail.${domain.name}`;
    const result = await sysagent.configureSmtp({ domain: domain.name, hostname, messageRateLimit: body.messageRateLimit });
    await audit(request, { action: "APPLY", resource: "smtp", resourceId: domainId, description: `Configured SMTP submission for ${domain.name}`, metadata: { hostname, messageRateLimit: body.messageRateLimit } });
    return reply.code(202).send({ queued: false, result });
  });

  app.post("/services/reload", async (_request, reply) => {
    const result = await sysagent.reloadMailServices();
    return reply.code(202).send({ queued: false, dryRunResult: result });
  });
};

function mailDnsRecords(domainId: string, domain: string, vpsIp: string) {
  return [
    { domainId, type: "A" as const, name: "mail", value: vpsIp, ttl: 3600, priority: null },
    { domainId, type: "MX" as const, name: "@", value: `mail.${domain}`, ttl: 3600, priority: 10 },
    { domainId, type: "TXT" as const, name: "@", value: `v=spf1 ip4:${vpsIp} mx ~all`, ttl: 3600, priority: null },
    { domainId, type: "TXT" as const, name: "_dmarc", value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, ttl: 3600, priority: null }
  ];
}

function sameMailDnsRecord(existing: { type: string; name: string; value: string; priority: number | null }, record: { type: string; name: string; value: string; priority: number | null }) {
  return existing.type === record.type && existing.name === record.name && existing.value === record.value && (existing.priority ?? null) === (record.priority ?? null);
}

async function ensureMailDns(domainId: string, domainName: string) {
  const vpsIp = await currentVpsIp();
  for (const record of mailDnsRecords(domainId, domainName, vpsIp)) {
    const existing = await prisma.dnsRecord.findFirst({ where: { domainId, type: record.type, name: record.name } });
    if (existing) {
      await prisma.dnsRecord.update({ where: { id: existing.id }, data: { value: record.value, ttl: record.ttl, priority: record.priority } });
    } else {
      await prisma.dnsRecord.create({ data: record });
    }
  }
  return publishDomainDnsZone(domainId);
}

function mailCommandSucceeded(result: { returncode?: number; dryRun?: boolean }) {
  return result.dryRun === true || result.returncode === 0;
}
