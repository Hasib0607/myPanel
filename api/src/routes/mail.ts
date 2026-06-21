import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
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
import { syncMailboxInbox } from "../lib/mailInboxSync.js";
import { managedMailDnsValuePrefix } from "../lib/mailDns.js";
import { assertLiveMailProvisioning } from "../lib/mailProvisioning.js";
import { consumeMailboxSendAllowance } from "../lib/mailSendingPolicy.js";

const mailboxSchema = z.object({
  domainId: z.string(),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]+$/),
  password: z.string().min(10),
  quotaMb: z.number().int().min(128).default(1024)
});

const updateMailboxSchema = z.object({
  quotaMb: z.number().int().min(128).optional(),
  enabled: z.boolean().optional(),
  smtpSuspended: z.boolean().optional(),
  dailySendLimit: z.number().int().min(1).max(100000).optional(),
  minuteSendLimit: z.number().int().min(1).max(10000).optional()
});

const resetPasswordSchema = z.object({
  password: z.string().min(10)
});

const aliasSchema = z.object({
  domainId: z.string(),
  source: z.string().trim().toLowerCase().regex(/^[a-z0-9._+-]+(?:@[a-z0-9.-]+)?$/),
  target: z.string().trim().toLowerCase().email(),
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

const smtpHealthSchema = z.object({
  accountId: z.string(),
  password: z.string().min(1),
  recipient: z.string().email().optional()
});

const mailboxHealthSchema = z.object({ accountId: z.string() });
const mailSecuritySchema = z.object({ enableClamav: z.boolean().default(false) });
const installerSchema = z.object({ enableRspamd: z.boolean().default(true) });
const queueActionSchema = z.object({ action: z.enum(["flush", "retry", "delete"]), queueId: z.string().regex(/^[A-Fa-f0-9*!]{5,30}$/).optional() });
const deliverabilitySchema = z.object({
  dkimSelector: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/),
  dmarcPolicy: z.enum(["none", "quarantine", "reject"]),
  spfInclude: z.string().trim().regex(/^[a-z0-9._-]+$/i).max(255).nullable(),
  spfCustom: z.string().trim().regex(/^v=spf1(?:\s|$)/i).max(1000).nullable(),
  bounceAddress: z.string().email().nullable(),
  pop3Enabled: z.boolean()
});

export const mailRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/server/status", async () => {
    const [stack, firewall] = await Promise.all([
      sysagent.mailStackStatus(),
      sysagent.mailFirewallStatus()
    ]);
    return { stack, firewall };
  });

  app.get("/server/security/status", async () => sysagent.mailSecurityStatus());

  app.post("/server/security/configure", async (request, reply) => {
    const body = mailSecuritySchema.parse(request.body ?? {});
    const result = assertLiveMailProvisioning(await sysagent.configureMailSecurity(body), "Mail security configuration");
    await audit(request, { action: "APPLY", resource: "mail_security", description: `Configured Fail2Ban, Rspamd${body.enableClamav ? ", and ClamAV" : ""}` });
    return reply.code(202).send(result);
  });

  app.post("/server/install", async (request, reply) => {
    const body = installerSchema.parse(request.body ?? {});
    const result = assertLiveMailProvisioning(await sysagent.installMailStack(body), "Mail server installation");
    await audit(request, { action: "APPLY", resource: "mail_stack", description: "Installed and started the mail server stack" });
    return reply.code(202).send(result);
  });

  app.get("/server/queue", async () => sysagent.mailQueue());

  app.post("/server/queue/action", async (request) => {
    const body = queueActionSchema.parse(request.body);
    const result = assertLiveMailProvisioning(await sysagent.mailQueueAction(body), `Queue ${body.action}`);
    return result;
  });

  app.post("/server/firewall/apply", async (request, reply) => {
    const result = assertLiveMailProvisioning(await sysagent.applyMailFirewall(), "Mail firewall configuration");
    const ports = [25, 143, 465, 587, 993, 995];
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
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: body.domainId } });
    const passwordHash = await bcrypt.hash(body.password, 12);
    const account = await prisma.mailAccount.create({
      data: {
        domainId: body.domainId,
        username: body.username,
        passwordHash,
        quotaMb: body.quotaMb
      }
    });
    try {
      assertLiveMailProvisioning(
        await sysagent.createMailbox({ email: `${account.username}@${domain.name}`, quotaMb: account.quotaMb, passwordHash, enabled: account.enabled }),
        `Mailbox ${account.username}@${domain.name}`
      );
    } catch (error) {
      await prisma.mailAccount.delete({ where: { id: account.id } });
      throw error;
    }
    await audit(request, { action: "CREATE", resource: "mail_account", resourceId: account.id, description: `Created mailbox ${account.username}` });
    return reply.code(201).send(account);
  });

  app.patch("/accounts/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = updateMailboxSchema.parse(request.body);
    const account = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId }, include: { domain: true } });
    const next = { quotaMb: body.quotaMb ?? account.quotaMb, enabled: body.enabled ?? account.enabled, smtpSuspended: body.smtpSuspended ?? account.smtpSuspended };
    assertLiveMailProvisioning(await sysagent.createMailbox({
      email: `${account.username}@${account.domain.name}`,
      quotaMb: next.quotaMb,
      passwordHash: account.passwordHash,
      enabled: next.enabled,
      smtpSuspended: next.smtpSuspended
    }), `Mailbox ${account.username}@${account.domain.name}`);
    return prisma.mailAccount.update({ where: { id: accountId }, data: body, include: { domain: true } });
  });

  app.post("/accounts/:accountId/reset-password", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const body = resetPasswordSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const account = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId }, include: { domain: true } });
    assertLiveMailProvisioning(await sysagent.createMailbox({ email: `${account.username}@${account.domain.name}`, quotaMb: account.quotaMb, passwordHash, enabled: account.enabled, smtpSuspended: account.smtpSuspended }), `Mailbox ${account.username}@${account.domain.name}`);
    return prisma.mailAccount.update({ where: { id: accountId }, data: { passwordHash }, include: { domain: true } });
  });

  app.delete("/accounts/:accountId", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const account = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId }, include: { domain: true } });
    assertLiveMailProvisioning(await sysagent.deleteMailbox({ email: `${account.username}@${account.domain.name}` }), `Delete mailbox ${account.username}@${account.domain.name}`);
    await prisma.mailAccount.delete({ where: { id: accountId } });
    return { ok: true };
  });

  app.get("/accounts/:accountId/messages", async (request) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);
    const query = z.object({
      folder: folderSchema.default("INBOX"),
      search: z.string().optional()
    }).parse(request.query);
    await syncMailboxInbox(accountId).catch((error) => request.log.warn({ error }, "mailbox inbox sync failed"));
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
    await syncMailboxInbox(accountId).catch((error) => request.log.warn({ error }, "mailbox inbox sync failed"));
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
    const envelopeFrom = account.domain.mailBounceAddress || from;
    await consumeMailboxSendAllowance(account.id);
    const pending = await prisma.mail.create({
      data: {
        accountId: body.accountId,
        messageId: `local-${randomUUID()}@${account.domain.name}`,
        fromAddress: from,
        toAddress: body.to,
        subject: body.subject,
        bodyText: body.text ?? null,
        bodyHtml: body.html,
        folder: "SENT",
        deliveryStatus: "PENDING",
        isRead: true,
        receivedAt: new Date()
      }
    });
    try {
      const job = await mailQueue.add("send", { ...body, from, envelopeFrom, mailId: pending.id }, {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 500,
        removeOnFail: 1_000
      });
      return reply.code(202).send({ queued: true, jobId: job.id, message: pending });
    } catch (error) {
      await prisma.mail.update({ where: { id: pending.id }, data: { deliveryStatus: "FAILED", deliveryError: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
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
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: body.domainId } });
    const source = body.source.includes("@") ? body.source : `${body.source}@${domain.name}`;
    if (!source.endsWith(`@${domain.name}`)) throw app.httpErrors.badRequest("Alias source must belong to the selected domain");
    assertLiveMailProvisioning(await sysagent.updateMailAlias({ source, target: body.target }), `Alias ${source}`);
    const alias = await prisma.mailAlias.create({ data: body });
    await audit(request, { action: "CREATE", resource: "mail_alias", resourceId: alias.id, description: `Created mail alias ${alias.source}` });
    return reply.code(201).send(alias);
  });

  app.delete("/aliases/:aliasId", async (request) => {
    const { aliasId } = z.object({ aliasId: z.string() }).parse(request.params);
    const alias = await prisma.mailAlias.findUniqueOrThrow({ where: { id: aliasId } });
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: alias.domainId } });
    const source = alias.source.includes("@") ? alias.source : `${alias.source}@${domain.name}`;
    assertLiveMailProvisioning(await sysagent.deleteMailAlias({ source }), `Delete alias ${source}`);
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
      mailboxes: domain.mailAccounts.map((account) => ({ id: account.id, email: `${account.username}@${domain.name}`, enabled: account.enabled })),
      rateLimit: 60,
      rateWindowSeconds: 60,
      notes: [
        "Submission port 587 requires TLS before auth.",
        "Use Sync all mailboxes after enabling SMTP to provision existing password hashes and quotas.",
        "PTR/rDNS must be set at the VPS provider."
      ],
      protocols: [
        { protocol: "SMTP", host, port: 587, security: "STARTTLS" },
        { protocol: "SMTP", host, port: 465, security: "SSL/TLS" },
        { protocol: "IMAP", host, port: 993, security: "SSL/TLS" },
        ...(domain.mailPop3Enabled ? [{ protocol: "POP3", host, port: 995, security: "SSL/TLS" }] : [])
      ]
    };
  });

  app.get("/domains/:domainId/deliverability", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    return { dkimSelector: domain.mailDkimSelector, dmarcPolicy: domain.mailDmarcPolicy, spfInclude: domain.mailSpfInclude, spfCustom: domain.mailSpfCustom, bounceAddress: domain.mailBounceAddress, pop3Enabled: domain.mailPop3Enabled };
  });

  app.patch("/domains/:domainId/deliverability", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = deliverabilitySchema.parse(request.body);
    const existing = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    assertLiveMailProvisioning(await sysagent.configureSmtp({ domain: existing.name, hostname: `mail.${existing.name}`, messageRateLimit: 60, pop3Enabled: body.pop3Enabled }), `Mail protocols for ${existing.name}`);
    const domain = await prisma.domain.update({ where: { id: domainId }, data: { mailDkimSelector: body.dkimSelector, mailDmarcPolicy: body.dmarcPolicy, mailSpfInclude: body.spfInclude || null, mailSpfCustom: body.spfCustom || null, mailBounceAddress: body.bounceAddress || null, mailPop3Enabled: body.pop3Enabled } });
    await ensureMailDns(domain.id, domain.name);
    return { ok: true };
  });

  app.get("/domains/:domainId/diagnostics", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, include: { dnsRecords: true } });
    const live = await sysagent.mailDiagnostics({ domain: domain.name, hostname: `mail.${domain.name}` }) as any;
    const txt = domain.dnsRecords.filter((record) => record.type === "TXT");
    const dnsChecks = [
      { key: "mx", label: "MX present", ok: domain.dnsRecords.some((record) => record.type === "MX"), detail: "Mail exchanger record" },
      { key: "spf", label: "SPF present", ok: txt.some((record) => record.value.toLowerCase().startsWith("v=spf1")), detail: "Sender policy" },
      { key: "dkim", label: "DKIM present", ok: txt.some((record) => record.value.toLowerCase().startsWith("v=dkim1")), detail: `${domain.mailDkimSelector} selector` },
      { key: "dmarc", label: "DMARC present", ok: txt.some((record) => record.value.toLowerCase().startsWith("v=dmarc1")), detail: `${domain.mailDmarcPolicy} policy` },
      { key: "ptr", label: "PTR / rDNS", ok: false, detail: "Verify and set PTR at the VPS provider" }
    ];
    return { ...live, checks: [...(live.checks ?? []), ...dnsChecks] };
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
      messageRateLimit: 60,
      pop3Enabled: domain.mailPop3Enabled
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
      messageRateLimit: 60,
      pop3Enabled: domain.mailPop3Enabled
    });
    await audit(request, { action: "APPLY", resource: "mail_tls", resourceId: domainId, description: `Renewed and reattached mail TLS for ${hostname}` });
    return reply.code(202).send({ hostname, renew, certificate, attach });
  });

  app.get("/domains/:domainId/dns-recommendations", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, include: { dnsRecords: true } });
    const vpsIp = await currentVpsIp();
    const recommended = mailDnsRecords(domain.id, domain.name, vpsIp, domain);
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
    const records = mailDnsRecords(domain.id, domain.name, vpsIp, domain);
    const changed = [];
    for (const record of records) {
      const existing = await findManagedMailDnsRecord(domainId, record);
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
    const result = assertLiveMailProvisioning(await sysagent.setupDkim({ domain: domain.name, selector: domain.mailDkimSelector }), `DKIM for ${domain.name}`);
    const recordValue = typeof (result as any)?.recordValue === "string" ? (result as any).recordValue : null;
    if (recordValue) {
      const recordName = typeof (result as any)?.recordName === "string" ? (result as any).recordName : `${domain.mailDkimSelector}._domainkey`;
      const existing = await findManagedMailDnsRecord(domainId, { type: "TXT", name: recordName, value: recordValue });
      if (existing) {
        await prisma.dnsRecord.update({ where: { id: existing.id }, data: { value: recordValue, ttl: 3600 } });
      } else {
        await prisma.dnsRecord.create({ data: { domainId, type: "TXT", name: recordName, value: recordValue, ttl: 3600 } });
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
      enabled: account.enabled,
      smtpSuspended: account.smtpSuspended
    }));
    const result = assertLiveMailProvisioning(await sysagent.syncMailboxes({ domain: domain.name, mailboxes }), `Mailbox sync for ${domain.name}`);
    await audit(request, { action: "APPLY", resource: "mailbox_sync", resourceId: domainId, description: `Synced ${mailboxes.length} mailboxes for ${domain.name}`, metadata: { count: mailboxes.length } });
    return reply.code(202).send({ ok: true, synced: mailboxes.length, result });
  });

  app.post("/domains/:domainId/health/smtp", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = smtpHealthSchema.parse(request.body);
    const account = await prisma.mailAccount.findFirstOrThrow({ where: { id: body.accountId, domainId, enabled: true }, include: { domain: true } });
    const username = `${account.username}@${account.domain.name}`;
    const result = await sysagent.testSmtpHealth({ hostname: `mail.${account.domain.name}`, port: 587, username, password: body.password, recipient: body.recipient ?? username });
    await audit(request, { action: "APPLY", resource: "smtp_health", resourceId: account.id, description: `Tested authenticated SMTP for ${username}` });
    return result;
  });

  app.post("/domains/:domainId/health/incoming", async (request) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = mailboxHealthSchema.parse(request.body);
    const account = await prisma.mailAccount.findFirstOrThrow({ where: { id: body.accountId, domainId, enabled: true }, include: { domain: true } });
    const email = `${account.username}@${account.domain.name}`;
    const result = await sysagent.testIncomingMail({ domain: account.domain.name, email });
    await audit(request, { action: "APPLY", resource: "incoming_mail_health", resourceId: account.id, description: `Tested inbound delivery for ${email}` });
    return result;
  });

  app.post("/domains/:domainId/smtp/configure", async (request, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = smtpConfigureSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
    const hostname = body.hostname || `mail.${domain.name}`;
    const result = assertLiveMailProvisioning(await sysagent.configureSmtp({ domain: domain.name, hostname, messageRateLimit: body.messageRateLimit, pop3Enabled: domain.mailPop3Enabled }), `SMTP configuration for ${domain.name}`);
    await audit(request, { action: "APPLY", resource: "smtp", resourceId: domainId, description: `Configured SMTP submission for ${domain.name}`, metadata: { hostname, messageRateLimit: body.messageRateLimit } });
    return reply.code(202).send({ queued: false, result });
  });

  app.post("/services/reload", async (_request, reply) => {
    const result = await sysagent.reloadMailServices();
    return reply.code(202).send({ queued: false, dryRunResult: result });
  });
};

function mailDnsRecords(domainId: string, domain: string, vpsIp: string, settings?: { mailDmarcPolicy?: string; mailSpfInclude?: string | null; mailSpfCustom?: string | null }) {
  const spf = settings?.mailSpfCustom || `v=spf1 ip4:${vpsIp} mx${settings?.mailSpfInclude ? ` include:${settings.mailSpfInclude}` : ""} ~all`;
  return [
    { domainId, type: "A" as const, name: "mail", value: vpsIp, ttl: 3600, priority: null },
    { domainId, type: "MX" as const, name: "@", value: `mail.${domain}`, ttl: 3600, priority: 10 },
    { domainId, type: "TXT" as const, name: "@", value: spf, ttl: 3600, priority: null },
    { domainId, type: "TXT" as const, name: "_dmarc", value: `v=DMARC1; p=${settings?.mailDmarcPolicy || "quarantine"}; rua=mailto:postmaster@${domain}`, ttl: 3600, priority: null }
  ];
}

function sameMailDnsRecord(existing: { type: string; name: string; value: string; priority: number | null }, record: { type: string; name: string; value: string; priority: number | null }) {
  return existing.type === record.type && existing.name === record.name && existing.value === record.value && (existing.priority ?? null) === (record.priority ?? null);
}

async function ensureMailDns(domainId: string, domainName: string) {
  const vpsIp = await currentVpsIp();
  const settings = await prisma.domain.findUniqueOrThrow({ where: { id: domainId } });
  for (const record of mailDnsRecords(domainId, domainName, vpsIp, settings)) {
    const existing = await findManagedMailDnsRecord(domainId, record);
    if (existing) {
      await prisma.dnsRecord.update({ where: { id: existing.id }, data: { value: record.value, ttl: record.ttl, priority: record.priority } });
    } else {
      await prisma.dnsRecord.create({ data: record });
    }
  }
  return publishDomainDnsZone(domainId);
}

function mailCommandSucceeded(result: { returncode?: number; dryRun?: boolean }) {
  return result.dryRun !== true && result.returncode === 0;
}

async function findManagedMailDnsRecord(domainId: string, record: { type: string; name: string; value: string }) {
  const prefix = managedMailDnsValuePrefix(record.type, record.value);
  return prisma.dnsRecord.findFirst({
    where: {
      domainId,
      type: record.type as any,
      name: record.name,
      ...(prefix ? { value: { startsWith: prefix, mode: "insensitive" as const } } : {})
    }
  });
}
