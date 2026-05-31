import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import type { FastifyPluginAsync } from "fastify";
import { promisify } from "node:util";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { getSecret, putSecret } from "../lib/secrets.js";
import { cpanelData, WhmClient, whmData } from "../lib/whmClient.js";

const execFileAsync = promisify(execFile);

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
const credentialSchema = z.object({
  sshUser: z.string().trim().min(1).default("root"),
  sshHost: z.string().trim().min(1),
  sshPort: z.number().int().min(1).max(65535).default(22),
  sshKeyPath: z.string().trim().optional(),
  imapHost: z.string().trim().optional(),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapUseSsl: z.boolean().default(true)
});

function migrationCredentialsRef(id: string) {
  return `whm-migration:${id}:credentials`;
}

function safeShell(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandArgs(command: string): string[] {
  return ["-lc", command];
}

function allowedTaskCommand(task: { type: string; command: string | null }) {
  const command = task.command ?? "";
  if (task.type === "FILE_SYNC") return command.startsWith("rsync -az ") && command.includes("/public_html/");
  if (task.type === "DATABASE_DUMP") return command.startsWith("ssh ") && command.includes("mysqldump");
  if (task.type === "MAIL_SYNC") return command.startsWith("imapsync ");
  return false;
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

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

function packageLimits(data: any) {
  const diskRaw = Number(data.quota ?? data.diskquota ?? 0);
  const diskLimitMb = Number.isFinite(diskRaw) && diskRaw > 0 ? diskRaw : null;
  const domainLimit = Number(data.maxaddon ?? data.MAXADDON ?? 0) || null;
  const mailboxLimit = Number(data.maxpop ?? data.MAXPOP ?? 0) || null;
  const databaseLimit = Number(data.maxsql ?? data.MAXSQL ?? 0) || null;
  return { diskLimitMb, domainLimit, mailboxLimit, databaseLimit };
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

async function conflictReport(migrationId: string) {
  const items = await prisma.whmMigrationItem.findMany({ where: { migrationId, type: { in: ["ACCOUNT", "DOMAIN", "PACKAGE"] } } });
  const [accounts, domains, packages] = await Promise.all([
    prisma.account.findMany({ select: { username: true, id: true } }),
    prisma.domain.findMany({ select: { name: true, id: true } }),
    prisma.accountPackage.findMany({ select: { name: true, id: true } })
  ]);
  const existingAccounts = new Map(accounts.map((item) => [item.username, item.id]));
  const existingDomains = new Map(domains.map((item) => [item.name, item.id]));
  const existingPackages = new Map(packages.map((item) => [item.name, item.id]));
  return items
    .map((item) => {
      const target = item.type === "ACCOUNT" ? existingAccounts.get(item.name) : item.type === "DOMAIN" ? existingDomains.get(item.name) : existingPackages.get(item.name);
      return target ? { type: item.type, name: item.name, sourceAccount: item.sourceAccount, existingId: target, action: "merge/update" } : null;
    })
    .filter(Boolean);
}

async function migrationReport(migrationId: string) {
  const [migration, grouped, tasks, conflicts] = await Promise.all([
    prisma.whmMigration.findUniqueOrThrow({ where: { id: migrationId } }),
    prisma.whmMigrationItem.groupBy({ by: ["type", "status"], where: { migrationId }, _count: { _all: true } }),
    prisma.whmMigrationTask.groupBy({ by: ["type", "status"], where: { migrationId }, _count: { _all: true } }),
    conflictReport(migrationId)
  ]);
  return { migration, itemCounts: grouped, taskCounts: tasks, conflicts };
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

  app.get("/:migrationId/report", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    return migrationReport(migrationId);
  });

  app.get("/:migrationId/report.csv", async (request, reply) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const items = await prisma.whmMigrationItem.findMany({ where: { migrationId }, orderBy: [{ type: "asc" }, { name: "asc" }] });
    const lines = ["type,name,source_account,status,target_type,target_id,warnings"];
    for (const item of items) {
      lines.push([item.type, item.name, item.sourceAccount ?? "", item.status, item.targetType ?? "", item.targetId ?? "", item.warnings.join("; ")].map(csvCell).join(","));
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="whm-migration-${migrationId}.csv"`);
    return lines.join("\n");
  });

  app.post("/:migrationId/credentials", async (request) => {
    const { migrationId } = z.object({ migrationId: z.string() }).parse(request.params);
    const body = credentialSchema.parse(request.body);
    await prisma.whmMigration.findUniqueOrThrow({ where: { id: migrationId } });
    await putSecret({ ref: migrationCredentialsRef(migrationId), value: JSON.stringify(body), kind: "GENERIC", label: "WHM migration execution credentials" });
    await audit(request, { action: "UPDATE", resource: "whm_migration", resourceId: migrationId, description: "Stored WHM migration execution credentials" });
    return { ok: true };
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
          const limits = packageLimits(data);
          const pkg = await prisma.accountPackage.upsert({
            where: { name: item.name },
            update: { ...limits, metadata: { whm: data } as any },
            create: { name: item.name, description: "Imported from WHM", ...limits, metadata: { whm: data } as any }
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
    const credentialRaw = await getSecret(migrationCredentialsRef(migrationId));
    const credentials = credentialRaw ? credentialSchema.parse(JSON.parse(credentialRaw)) : null;
    for (const account of accounts) {
      const user = account.name;
      const oldHost = credentials?.sshHost ?? body.oldServerHost ?? "${OLD_WHM_HOST}";
      const sshUser = credentials?.sshUser ?? "root";
      const sshPort = credentials?.sshPort ?? 22;
      const sshKey = credentials?.sshKeyPath ? ` -i ${safeShell(credentials.sshKeyPath)}` : "";
      const sshTarget = `${sshUser}@${oldHost}`;
      if (body.includeFiles) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "FILE_SYNC", account: user, command: `rsync -az --delete -e ${safeShell(`ssh -p ${sshPort}${sshKey}`)} ${safeShell(`${sshTarget}:/home/${user}/public_html/`)} ${safeShell(`/var/www/accounts/${user}/public_html/`)}` } }));
      if (body.includeDatabases) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "DATABASE_DUMP", account: user, command: `ssh -p ${sshPort}${sshKey} ${safeShell(sshTarget)} ${safeShell(`uapi --user=${user} Mysql list_databases --output=json && echo 'Use generated database list to run mysqldump/import per DB'`)}` } }));
      if (body.includeMail) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "MAIL_SYNC", account: user, command: `imapsync --host1 ${credentials?.imapHost ?? oldHost} --host2 127.0.0.1 --ssl1 --ssl2 --automap --user1 mailbox@domain --user2 mailbox@domain` } }));
      if (body.includeDnsCutover) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "DNS_CUTOVER", account: user, command: "Lower old TTL, verify files/DB/mail, then switch A records or nameservers." } }));
      if (body.includeRollback) tasks.push(await prisma.whmMigrationTask.create({ data: { migrationId, type: "ROLLBACK", account: user, command: "Restore old A records/nameservers and disable new vhost if post-cutover health fails." } }));
    }
    await prisma.whmMigration.update({ where: { id: migrationId }, data: { status: "MIGRATING" } });
    return { items: tasks };
  });

  app.post("/:migrationId/tasks/:taskId/run", async (request) => {
    const { migrationId, taskId } = z.object({ migrationId: z.string(), taskId: z.string() }).parse(request.params);
    const taskExisting = await prisma.whmMigrationTask.findFirstOrThrow({ where: { id: taskId, migrationId } });
    if (!env.ALLOW_LIVE_WHM_MIGRATION) {
      const task = await prisma.whmMigrationTask.update({
        where: { id: taskId },
        data: { status: "SKIPPED", result: { message: "Live WHM migration commands are disabled. Set ALLOW_LIVE_WHM_MIGRATION=true only after reviewing the command.", commandPreviewOnly: true } as any, finishedAt: new Date() }
      });
      return task;
    }
    if (!allowedTaskCommand(taskExisting)) {
      throw Object.assign(new Error("Task command is not in the WHM migration allowlist."), { statusCode: 400 });
    }
    await prisma.whmMigrationTask.update({ where: { id: taskId }, data: { status: "RUNNING", startedAt: new Date(), approvedAt: new Date() } });
    try {
      const result = await execFileAsync("bash", commandArgs(taskExisting.command ?? ""), { timeout: 1000 * 60 * 30, maxBuffer: 1024 * 1024 * 4 });
      const task = await prisma.whmMigrationTask.update({
        where: { id: taskId },
        data: { status: "SUCCEEDED", log: [result.stdout, result.stderr].filter(Boolean).join("\n"), result: { stdout: result.stdout, stderr: result.stderr } as any, finishedAt: new Date() }
      });
      await audit(request, { action: "APPLY", resource: "whm_migration_task", resourceId: taskId, description: `Ran WHM migration task ${task.type}` });
      return task;
    } catch (error: any) {
      const task = await prisma.whmMigrationTask.update({
        where: { id: taskId },
        data: { status: "FAILED", log: [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n"), result: { error: error?.message, stdout: error?.stdout, stderr: error?.stderr } as any, finishedAt: new Date() }
      });
      return task;
    }
  });

  app.post("/:migrationId/tasks/:taskId/approve", async (request) => {
    const { migrationId, taskId } = z.object({ migrationId: z.string(), taskId: z.string() }).parse(request.params);
    await prisma.whmMigrationTask.findFirstOrThrow({ where: { id: taskId, migrationId } });
    const task = await prisma.whmMigrationTask.update({
      where: { id: taskId },
      data: { status: "APPROVED", approvedAt: new Date() }
    });
    return task;
  });
};
