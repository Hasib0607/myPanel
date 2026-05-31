import bcrypt from "bcrypt";
import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { getSecret, putSecret } from "../lib/secrets.js";
import { cpanelData, WhmClient, whmData } from "../lib/whmClient.js";

const connectionSchema = z.object({
  name: z.string().trim().min(1).max(100).default("WHM migration"),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(2087),
  username: z.string().trim().min(1).default("root"),
  token: z.string().min(10),
  verifySsl: z.boolean().default(true)
});

const importSchema = z.object({
  accountUsernames: z.array(z.string()).optional(),
  includePackages: z.boolean().default(true),
  includeAccounts: z.boolean().default(true),
  includeDomains: z.boolean().default(true),
  includeDns: z.boolean().default(true),
  includeMailboxes: z.boolean().default(false),
  includeDatabases: z.boolean().default(false)
});

const taskSchema = z.object({
  accountUsernames: z.array(z.string()).optional(),
  includeFiles: z.boolean().default(true),
  includeDatabases: z.boolean().default(true),
  includeMail: z.boolean().default(true),
  includeDnsCutover: z.boolean().default(true),
  includeRollback: z.boolean().default(true),
  oldServerHost: z.string().trim().optional()
});

function secretRef(id: string) {
  return `whm-migration:${id}:token`;
}

async function clientFor(migrationId: string) {
  const migration = await prisma.whmMigration.findUniqueOrThrow({ where: { id: migrationId } });
  const token = await getSecret(migration.tokenSecretRef);
  if (!token) throw Object.assign(new Error("WHM token secret is missing."), { statusCode: 400 });
  return { migration, client: new WhmClient({ host: migration.host, port: migration.port, username: migration.username, token, verifySsl: migration.verifySsl }) };
}

function sourceId(...parts: Array<string | number | null | undefined>) {
  return parts.filter((part) => part !== null && part !== undefined && String(part).length > 0).map(String).join(":");
}

function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function randomPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function accountHomeRoot(username: string) {
  return `/var/www/accounts/${username}`;
}

function asArray(value: any): any[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function domainEntries(account: any, domainsResponse: any) {
  const user = String(account.user ?? account.username ?? "");
  const primary = normalizeDomain(String(account.domain ?? ""));
  const data = cpanelData(domainsResponse)[0] ?? {};
  const addon = asArray(data.addon_domains ?? data.addon ?? data.addondomains);
  const parked = asArray(data.parked_domains ?? data.parked ?? data.parkeddomains);
  const sub = asArray(data.sub_domains ?? data.sub ?? data.subdomains);
  const items = [
    primary ? { domain: primary, role: "primary" } : null,
    ...addon.map((domain) => ({ domain: normalizeDomain(String(domain)), role: "addon" })),
    ...parked.map((domain) => ({ domain: normalizeDomain(String(domain)), role: "parked" })),
    ...sub.map((domain) => ({ domain: normalizeDomain(String(domain)), role: "subdomain" }))
  ].filter(Boolean) as Array<{ domain: string; role: string }>;
  return [...new Map(items.filter((item) => item.domain).map((item) => [`${user}:${item.domain}`, item])).values()];
}

function dnsRecordsFromZone(zone: any) {
  const records = asArray(zone?.data?.zone?.record ?? zone?.zone?.record ?? zone?.data?.record);
  return records
    .map((record) => {
      const type = String(record.type ?? "").toUpperCase();
      if (!["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"].includes(type)) return null;
      return {
        type,
        name: String(record.name ?? "").replace(/\.$/, ""),
        value: String(record.address ?? record.cname ?? record.exchange ?? record.txtdata ?? record.target ?? record.value ?? "").replace(/\.$/, ""),
        ttl: Number(record.ttl ?? 3600),
        priority: record.preference !== undefined ? Number(record.preference) : record.priority !== undefined ? Number(record.priority) : null,
        raw: record
      };
    })
    .filter((record) => record && record.name && record.value) as Array<{ type: string; name: string; value: string; ttl: number; priority: number | null; raw: any }>;
}

async function upsertItem(input: {
  migrationId: string;
  type: "ACCOUNT" | "DOMAIN" | "DNS_ZONE" | "DNS_RECORD" | "PACKAGE" | "MAILBOX" | "DATABASE" | "SSL";
  sourceId: string;
  sourceAccount?: string | null;
  name: string;
  data: any;
  warnings?: string[];
}) {
  return prisma.whmMigrationItem.upsert({
    where: { migrationId_type_sourceId: { migrationId: input.migrationId, type: input.type, sourceId: input.sourceId } },
    update: { name: input.name, sourceAccount: input.sourceAccount ?? null, data: input.data, warnings: input.warnings ?? [] },
    create: {
      migrationId: input.migrationId,
      type: input.type,
      sourceId: input.sourceId,
      sourceAccount: input.sourceAccount ?? null,
      name: input.name,
      data: input.data,
      warnings: input.warnings ?? []
    }
  });
}

async function scanMigration(migrationId: string) {
  const { client } = await clientFor(migrationId);
  await prisma.whmMigration.update({ where: { id: migrationId }, data: { status: "SCANNING" } });
  const warnings: string[] = [];
  const [version, accountsResponse, packagesResponse] = await Promise.all([
    client.version().catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    client.listAccounts(),
    client.listPackages().catch((error) => ({ error: error instanceof Error ? error.message : String(error), data: { pkg: [] } }))
  ]);
  const accounts = whmData(accountsResponse, "acct");
  const packages = whmData(packagesResponse, "pkg");

  for (const pkg of packages) {
    const name = String(pkg.name ?? pkg.pkg ?? "");
    if (!name) continue;
    await upsertItem({ migrationId, type: "PACKAGE", sourceId: name, name, data: pkg });
  }

  for (const account of accounts) {
    const user = String(account.user ?? account.username ?? "");
    if (!user) continue;
    await upsertItem({ migrationId, type: "ACCOUNT", sourceId: user, sourceAccount: user, name: user, data: account });
    let domainsResponse: any = {};
    let mailboxesResponse: any = {};
    let databasesResponse: any = {};
    let sslResponse: any = {};
    try { domainsResponse = await client.listDomains(user); } catch (error) { warnings.push(`${user}: domains scan failed: ${error instanceof Error ? error.message : String(error)}`); }
    try { mailboxesResponse = await client.listMailboxes(user); } catch (error) { warnings.push(`${user}: mailbox scan failed: ${error instanceof Error ? error.message : String(error)}`); }
    try { databasesResponse = await client.listDatabases(user); } catch (error) { warnings.push(`${user}: database scan failed: ${error instanceof Error ? error.message : String(error)}`); }
    try { sslResponse = await client.installedHosts(user); } catch (error) { warnings.push(`${user}: SSL scan failed: ${error instanceof Error ? error.message : String(error)}`); }

    for (const entry of domainEntries(account, domainsResponse)) {
      await upsertItem({ migrationId, type: "DOMAIN", sourceId: sourceId(user, entry.domain), sourceAccount: user, name: entry.domain, data: entry });
      try {
        const zone = await client.dumpZone(entry.domain);
        await upsertItem({ migrationId, type: "DNS_ZONE", sourceId: entry.domain, sourceAccount: user, name: entry.domain, data: zone });
        for (const record of dnsRecordsFromZone(zone)) {
          await upsertItem({ migrationId, type: "DNS_RECORD", sourceId: sourceId(entry.domain, record.type, record.name, record.value, record.priority), sourceAccount: user, name: `${record.type} ${record.name}`, data: { domain: entry.domain, ...record } });
        }
      } catch (error) {
        warnings.push(`${entry.domain}: DNS zone scan failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const mailbox of cpanelData(mailboxesResponse)) {
      const email = String(mailbox.email ?? mailbox.login ?? "");
      if (!email) continue;
      await upsertItem({ migrationId, type: "MAILBOX", sourceId: sourceId(user, email), sourceAccount: user, name: email, data: mailbox });
    }
    for (const db of cpanelData(databasesResponse)) {
      const name = String(db.database ?? db.db ?? db.name ?? "");
      if (!name) continue;
      await upsertItem({ migrationId, type: "DATABASE", sourceId: sourceId(user, name), sourceAccount: user, name, data: db });
    }
    for (const ssl of cpanelData(sslResponse)) {
      const host = String(ssl.host ?? ssl.domain ?? "");
      if (!host) continue;
      await upsertItem({ migrationId, type: "SSL", sourceId: sourceId(user, host), sourceAccount: user, name: host, data: ssl });
    }
  }

  const grouped = await prisma.whmMigrationItem.groupBy({ by: ["type"], where: { migrationId }, _count: { _all: true } });
  const summary = Object.fromEntries(grouped.map((item) => [item.type, item._count._all]));
  return prisma.whmMigration.update({
    where: { id: migrationId },
    data: { status: "SCANNED", serverInfo: version as any, summary: { ...summary, warnings } as any, lastScanAt: new Date() },
    include: { _count: { select: { items: true, tasks: true } } }
  });
}

export const whmMigrationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async () => ({
    items: await prisma.whmMigration.findMany({
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { items: true, tasks: true } } }
    })
  }));

  app.post("/", async (request, reply) => {
    const body = connectionSchema.parse(request.body);
    const migration = await prisma.whmMigration.create({
      data: {
        name: body.name,
        host: body.host,
        port: body.port,
        username: body.username,
        tokenSecretRef: "pending",
        verifySsl: body.verifySsl
      }
    });
    await putSecret({ ref: secretRef(migration.id), value: body.token, kind: "GENERIC", label: `WHM token for ${body.host}` });
    const updated = await prisma.whmMigration.update({ where: { id: migration.id }, data: { tokenSecretRef: secretRef(migration.id), status: "DRAFT" } });
    await audit(request, { action: "CREATE", resource: "whm_migration", resourceId: migration.id, description: `Created WHM migration ${body.host}` });
    return reply.code(201).send(updated);
  });

  app.get("/:migrationId", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const [migration, items, tasks] = await Promise.all([
      prisma.whmMigration.findUniqueOrThrow({ where: { id: migrationId }, include: { _count: { select: { items: true, tasks: true } } } }),
      prisma.whmMigrationItem.findMany({ where: { migrationId }, orderBy: [{ type: "asc" }, { name: "asc" }], take: 500 }),
      prisma.whmMigrationTask.findMany({ where: { migrationId }, orderBy: { createdAt: "desc" }, take: 200 })
    ]);
    return { migration, items, tasks };
  });

  app.post("/:migrationId/test", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const { client } = await clientFor(migrationId);
    const version = await client.version();
    const migration = await prisma.whmMigration.update({ where: { id: migrationId }, data: { status: "CONNECTED", serverInfo: version as any } });
    await audit(request, { action: "APPLY", resource: "whm_migration", resourceId: migrationId, description: "Tested WHM connection" });
    return { ok: true, version, migration };
  });

  app.post("/:migrationId/scan", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const migration = await scanMigration(migrationId);
    await audit(request, { action: "APPLY", resource: "whm_migration", resourceId: migrationId, description: "Scanned WHM server" });
    return migration;
  });

  app.post("/:migrationId/import", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const body = importSchema.parse(request.body ?? {});
    await prisma.whmMigration.update({ where: { id: migrationId }, data: { status: "IMPORTING" } });
    const accountFilter = body.accountUsernames?.length ? { sourceAccount: { in: body.accountUsernames } } : {};
    const items = await prisma.whmMigrationItem.findMany({ where: { migrationId, ...accountFilter }, orderBy: { createdAt: "asc" } });
    const imported: Record<string, number> = {};
    const accountIds = new Map<string, string>();

    for (const item of items) {
      try {
        if (item.type === "PACKAGE" && body.includePackages) {
          const data: any = item.data;
          const pkg = await prisma.accountPackage.upsert({
            where: { name: item.name },
            update: { metadata: { whm: data } as any },
            create: { name: item.name, description: "Imported from WHM", metadata: { whm: data } as any }
          });
          await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "IMPORTED", targetType: "account_package", targetId: pkg.id } });
          imported.PACKAGE = (imported.PACKAGE ?? 0) + 1;
        }
        if (item.type === "ACCOUNT" && body.includeAccounts) {
          const data: any = item.data;
          const passwordHash = await bcrypt.hash(randomPassword(), 12);
          const account = await prisma.account.upsert({
            where: { username: item.name },
            update: { metadata: { whm: data } as any },
            create: {
              username: item.name,
              email: data.email || null,
              ownerName: data.owner || null,
              passwordHash,
              status: data.suspended === 1 || data.suspended === "1" ? "SUSPENDED" : "ACTIVE",
              homeRoot: accountHomeRoot(item.name),
              packageName: data.plan || data.package || null,
              metadata: { whm: data } as any
            }
          });
          accountIds.set(item.name, account.id);
          await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "IMPORTED", targetType: "account", targetId: account.id } });
          imported.ACCOUNT = (imported.ACCOUNT ?? 0) + 1;
        }
        if (item.type === "DOMAIN" && body.includeDomains) {
          const accountId = item.sourceAccount ? accountIds.get(item.sourceAccount) ?? (await prisma.account.findUnique({ where: { username: item.sourceAccount } }))?.id : null;
          const domain = await prisma.domain.upsert({
            where: { name: item.name },
            update: { accountId: accountId ?? undefined, status: "PENDING" },
            create: { name: item.name, status: "PENDING", accountId: accountId ?? null }
          });
          await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "IMPORTED", targetType: "domain", targetId: domain.id } });
          imported.DOMAIN = (imported.DOMAIN ?? 0) + 1;
        }
        if (item.type === "DNS_RECORD" && body.includeDns) {
          const data: any = item.data;
          const domain = await prisma.domain.findUnique({ where: { name: data.domain } });
          if (!domain) continue;
          await prisma.dnsRecord.create({
            data: { domainId: domain.id, type: data.type, name: data.name, value: data.value, ttl: data.ttl ?? 3600, priority: data.priority ?? null }
          }).catch(() => null);
          await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "IMPORTED", targetType: "dns_record" } });
          imported.DNS_RECORD = (imported.DNS_RECORD ?? 0) + 1;
        }
        if (item.type === "MAILBOX" && body.includeMailboxes) {
          await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "MAPPED", warnings: ["Mailbox migration requires mail service cutover; queued separately."] } });
        }
        if (item.type === "DATABASE" && body.includeDatabases) {
          const account = item.sourceAccount ? await prisma.account.findUnique({ where: { username: item.sourceAccount } }) : null;
          if (account) {
            await prisma.accountDatabase.create({ data: { accountId: account.id, engine: "MYSQL", database: item.name, username: item.sourceAccount ?? item.name } }).catch(() => null);
          }
          await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "MAPPED", targetType: "account_database" } });
        }
      } catch (error) {
        await prisma.whmMigrationItem.update({ where: { id: item.id }, data: { status: "FAILED", warnings: [error instanceof Error ? error.message : String(error)] } });
      }
    }
    const migration = await prisma.whmMigration.update({ where: { id: migrationId }, data: { status: "IMPORTED", summary: { imported } as any } });
    await audit(request, { action: "APPLY", resource: "whm_migration", resourceId: migrationId, description: "Imported WHM snapshot into myPanel", metadata: imported as any });
    return { migration, imported };
  });

  app.post("/:migrationId/tasks/prepare", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const body = taskSchema.parse(request.body ?? {});
    const where = { migrationId, type: "ACCOUNT" as const, ...(body.accountUsernames?.length ? { sourceAccount: { in: body.accountUsernames } } : {}) };
    const accounts = await prisma.whmMigrationItem.findMany({ where });
    const tasks = [];
    for (const account of accounts) {
      const user = account.name;
      const oldHost = body.oldServerHost ?? "${OLD_WHM_HOST}";
      if (body.includeFiles) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "FILE_SYNC", account: user, command: `rsync -az --numeric-ids root@${oldHost}:/home/${user}/public_html/ /var/www/accounts/${user}/public_html/` } }));
      if (body.includeDatabases) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "DATABASE_DUMP", account: user, command: `ssh root@${oldHost} 'for db in $(uapi --user=${user} Mysql list_databases --output=json); do mysqldump "$db" > /root/${user}-$db.sql; done'` } }));
      if (body.includeMail) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "MAIL_SYNC", account: user, command: `imapsync --host1 ${oldHost} --host2 127.0.0.1 --automap --user1 mailbox@domain --user2 mailbox@domain` } }));
      if (body.includeDnsCutover) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "DNS_CUTOVER", account: user, command: "Lower old TTL, verify files/DB/mail, then switch A records or nameservers." } }));
      if (body.includeRollback) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "ROLLBACK", account: user, command: "Restore old A records/nameservers and disable new vhost if post-cutover health fails." } }));
    }
    await prisma.whmMigration.update({ where: { id: migrationId }, data: { status: "MIGRATING" } });
    return { items: tasks };
  });

  app.post("/:migrationId/tasks/:taskId/run", async (request) => {
    const { migrationId, taskId } = z.object({ migrationId: z.string(), taskId: z.string() }).parse(request.params);
    await prisma.whmMigrationTask.findFirstOrThrow({ where: { id: taskId, migrationId } });
    const task = await prisma.whmMigrationTask.update({
      where: { id: taskId },
      data: { status: "SKIPPED", result: { message: "Command execution is intentionally approval/manual for WHM migrations.", commandPreviewOnly: true } as any, finishedAt: new Date() }
    });
    return task;
  });
};
