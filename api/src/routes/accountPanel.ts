import bcrypt from "bcrypt";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { DeploymentFramework, Prisma } from "@prisma/client";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { chunkUploadQuery, writeUploadChunk } from "../lib/fileChunkUpload.js";
import { configuredFileUploadLimitBytes, fileUploadBodyLimitBytes, fileUploadChunkBodyLimitBytes, fileUploadChunkBytes, fileUploadLimitBytes } from "../lib/fileUploadLimits.js";
import { deployQueue, sslQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { githubApiErrorMessage, isGithubWebhookPermissionError } from "../lib/githubApiErrors.js";
import { publishDomainDnsZone } from "../lib/domainDnsPublish.js";
import { detectDeploymentFiles } from "../lib/deploymentDetection.js";
import { deploymentRuntimeReview, prepareDeploymentRuntimeTools } from "../lib/deploymentRuntimeReview.js";
import { buildDeploymentNginxRequest, deploymentIsRoutable } from "../lib/deploymentDomainSsl.js";
import { prisma } from "../lib/prisma.js";
import { resolvePublicA } from "../lib/publicDns.js";
import { deleteSecret, getSecret, putSecret } from "../lib/secrets.js";
import { sysagent } from "../lib/sysagent.js";
import { certbotCertificateName, isWildcardHostname, nginxResourceName } from "../lib/nginxNames.js";
import { currentVpsIp } from "../lib/serverIp.js";
import {
  deploymentWorkerMax,
  inferredLaravelManagedProcesses,
  laravelManagedProcessesSchema,
  laravelManagedProgramName,
  queueGroupCommand,
  renderLaravelProcessCommand
} from "../lib/laravelProcesses.js";
import { defaultRecords } from "./domains.js";
import { renderZone } from "./dns.js";

function accountId(request: any) {
  return request.user.accountId as string;
}

function safeAccount(account: any) {
  const { passwordHash: _passwordHash, ...rest } = account;
  return rest;
}

function normalizeDomainName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0]
    .replace(/\.$/, "");
}

const domainNameSchema = z.string().transform((value) => normalizeDomainName(value)).superRefine((value, ctx) => {
  const labels = value.split(".");
  const validLabels = labels.every((label, index) => {
    if (label === "*" && index === 0) return true;
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  });
  if (labels.length < 2 || value.length > 253 || !validLabels || !/^[a-z]{2,63}$/.test(labels[labels.length - 1] ?? "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid root domain, like example.com, or a wildcard subdomain like *.example.com" });
  }
});

const createDomainSchema = z.object({
  name: domainNameSchema,
  forceSsl: z.boolean().default(true),
  hostingMode: z.enum(["PUBLIC_HTML", "DEPLOYMENT_PROXY", "REDIRECT"]).default("PUBLIC_HTML"),
  documentRoot: z.string().default("public_html"),
  redirectUrl: z.string().url().nullable().optional(),
  hostingDeploymentId: z.string().nullable().optional(),
  autoSsl: z.boolean().default(true),
  autoSslIncludeWww: z.boolean().default(true)
});
const domainUpdateSchema = z.object({
  forceSsl: z.boolean().optional(),
  hostingMode: z.enum(["PUBLIC_HTML", "DEPLOYMENT_PROXY", "REDIRECT"]).optional(),
  documentRoot: z.string().optional(),
  redirectUrl: z.string().url().nullable().optional(),
  hostingDeploymentId: z.string().nullable().optional()
});
const bulkDomainSchema = z.object({
  domains: z.array(domainNameSchema).min(1).max(500),
  forceSsl: z.boolean().default(true),
  skipExisting: z.boolean().default(true),
  publish: z.boolean().default(true),
  issueSsl: z.boolean().default(false)
});
const bulkDomainActionSchema = z.object({
  domainIds: z.array(z.string()).min(1).max(250),
  action: z.enum(["activate", "deactivate", "delete", "force_ssl", "issue_ssl"])
});
const fileQuerySchema = z.object({ path: z.string().default(".") });
const listFileQuerySchema = z.object({
  path: z.string().default("."),
  search: z.string().default(""),
  sort: z.enum(["name", "size", "modifiedAt"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(200)
});
const fileWriteSchema = z.object({ path: z.string(), content: z.string().max(1024 * 1024) });
const fileCreateSchema = z.object({ parentPath: z.string().default("."), name: z.string().min(1).max(120), content: z.string().max(1024 * 1024).default("") });
const folderCreateSchema = z.object({ parentPath: z.string().default("."), name: z.string().min(1).max(120) });
const fileDeleteSchema = z.object({ path: z.string().optional(), paths: z.array(z.string()).optional(), permanent: z.boolean().default(false) });
const fileRenameSchema = z.object({ path: z.string(), name: z.string().min(1).max(120) });
const fileCopyMoveSchema = z.object({ sourcePath: z.string(), targetParentPath: z.string(), name: z.string().min(1).max(120).optional(), overwrite: z.boolean().default(false) });
const chmodSchema = z.object({ path: z.string(), mode: z.string().regex(/^[0-7]{3,4}$/) });
const archiveCreateSchema = z.object({ sourcePaths: z.array(z.string()).min(1), archivePath: z.string() });
const archiveExtractSchema = z.object({ archivePath: z.string(), targetPath: z.string(), overwrite: z.boolean().default(false) });
const mailboxSchema = z.object({
  domainId: z.string(),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]+$/),
  password: z.string().min(10),
  quotaMb: z.number().int().min(128).default(1024)
});
const mailboxUpdateSchema = z.object({
  quotaMb: z.number().int().min(128).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(10).max(500).optional()
});
const deploymentSchema = z.object({
  domainId: z.string().nullable().optional(),
  name: z.string().min(1),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).optional(),
  framework: z.enum(["LARAVEL", "NEXTJS", "NODEJS", "PYTHON", "GO", "STATIC"]).default("STATIC"),
  sourceProvider: z.enum(["MANUAL", "GIT_URL", "GITHUB", "FILE_MANAGER", "UPLOAD"]).default("FILE_MANAGER"),
  repoUrl: z.string().url().nullable().optional(),
  gitUrl: z.string().url().nullable().optional(),
  githubOwner: z.string().nullable().optional(),
  githubRepo: z.string().nullable().optional(),
  githubRepoId: z.string().nullable().optional(),
  githubVisibility: z.string().nullable().optional(),
  branch: z.string().default("main"),
  rootDirectory: z.string().default("."),
  rootPath: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  installCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  outputDirectory: z.string().nullable().optional(),
  publicDirectory: z.string().nullable().optional(),
  dbType: z.enum(["POSTGRESQL", "MYSQL"]).nullable().optional(),
  dbName: z.string().nullable().optional(),
  dbUser: z.string().nullable().optional(),
  envVars: z.record(z.string()).default({}),
  autoDeployEnabled: z.boolean().default(false)
});
const deploymentUpdateSchema = deploymentSchema.partial().extend({
  status: z.enum(["QUEUED", "RUNNING", "STOPPED", "DEPLOYING", "BUILDING", "FAILED"]).optional(),
  healthStatus: z.enum(["UNKNOWN", "HEALTHY", "DEGRADED", "DOWN"]).optional()
});
const runtimeInstallSelectionSchema = z.object({
  approvedRuntimeTools: z.array(z.string().min(1)).max(50).default([])
});
const accountLaravelWorkersSchema = z.object({
  enabled: z.boolean().default(false),
  autoscale: z.boolean().default(false),
  desiredWorkers: z.number().int().min(0).max(deploymentWorkerMax).default(0),
  minWorkers: z.number().int().min(0).max(deploymentWorkerMax).default(0),
  maxWorkers: z.number().int().min(1).max(deploymentWorkerMax).default(deploymentWorkerMax),
  queueCommand: z.string().trim().min(1).max(500).default("php artisan queue:work --sleep=3 --tries=3 --timeout=90")
});
const githubConnectionSchema = z.object({
  username: z.string().trim().min(1).nullable().optional(),
  token: z.string().min(8).nullable().optional(),
  installationId: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([])
});
const envVarSchema = z.object({
  key: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/i),
  value: z.string().nullable().optional(),
  isSecret: z.boolean().default(false),
  secretRef: z.string().nullable().optional()
});
const dnsRecordSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]),
  name: z.string().trim().min(1).default("@"),
  value: z.string().trim().min(1),
  ttl: z.number().int().min(60).max(86400).default(3600),
  priority: z.number().int().min(0).max(65535).nullable().optional()
});
const bulkZoneMatchSchema = z.object({
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]),
  name: z.string().trim().min(1)
});
const bulkZoneActionSchema = z.object({
  domainIds: z.array(z.string()).min(1).max(250),
  action: z.enum(["add", "edit", "delete"]),
  record: dnsRecordSchema.optional(),
  match: bulkZoneMatchSchema.optional(),
  patch: dnsRecordSchema.partial().optional()
});
type AccountDnsRecordInput = z.infer<typeof dnsRecordSchema>;
type DnsRecordIdentity = { domainId: string; id?: string; type: AccountDnsRecordInput["type"]; name: string };
const subdomainSchema = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  target: z.string().trim().min(1),
  sslEnabled: z.boolean().default(false)
});
const databaseSchema = z.object({
  engine: z.enum(["POSTGRESQL", "MYSQL"]),
  database: z.string().regex(/^[a-zA-Z0-9_]+$/),
  username: z.string().regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(12).max(500).optional()
});
const databasePasswordSchema = z.object({
  engine: z.enum(["POSTGRESQL", "MYSQL"]),
  username: z.string().regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(12).max(500).optional()
});
const databaseTargetSchema = z.object({
  engine: z.enum(["POSTGRESQL", "MYSQL"]),
  database: z.string().regex(/^[a-zA-Z0-9_]+$/)
});
const databaseImportSchema = databaseTargetSchema.extend({
  sql: z.string().min(1).max(20_000_000)
});
const databaseGrantSchema = databaseTargetSchema.extend({
  username: z.string().regex(/^[a-zA-Z0-9_]+$/)
});
const databaseUploadQuerySchema = databaseTargetSchema.extend({
  filename: z.string().trim().min(1).max(255).optional()
});
const databaseTableSchema = databaseTargetSchema.extend({
  table: z.string().regex(/^[a-zA-Z0-9_]+$/)
});
const databaseRowsSchema = databaseTableSchema.extend({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0)
});
const databaseTableImportSchema = databaseTableSchema.extend({
  format: z.enum(["SQL", "CSV"]),
  content: z.string().min(1).max(20_000_000)
});
const databaseRowValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const databaseRowCreateSchema = databaseTableSchema.extend({
  values: z.record(z.string().regex(/^[a-zA-Z0-9_]+$/), databaseRowValueSchema)
});
const databaseRowTargetSchema = databaseTableSchema.extend({
  keyColumn: z.string().regex(/^[a-zA-Z0-9_]+$/),
  keyValue: z.union([z.string(), z.number(), z.boolean()])
});
const databaseRowUpdateSchema = databaseRowTargetSchema.extend({
  values: z.record(z.string().regex(/^[a-zA-Z0-9_]+$/), databaseRowValueSchema)
});
const sslSchema = z.object({
  email: z.string().email().optional(),
  includeWww: z.boolean().default(true)
});
const unsafeName = /[<>:"|?*\x00-\x1F]/;
const maxImportUploadBytes = 3 * 1024 * 1024 * 1024;
const importUploadContentType = "application/vnd.vps-panel.db-import";
const deploymentPortStart = Number(process.env.DEPLOYMENT_PORT_START ?? 10000);
const deploymentPortEnd = Number(process.env.DEPLOYMENT_PORT_END ?? 19999);
const defaultProcessManagerByFramework: Record<DeploymentFramework, "PM2" | "SUPERVISOR" | "STATIC"> = {
  LARAVEL: "SUPERVISOR",
  NEXTJS: "PM2",
  NODEJS: "PM2",
  PYTHON: "SUPERVISOR",
  GO: "SUPERVISOR",
  STATIC: "STATIC"
};
type DatabaseOverviewEngine = {
  engine: string;
  installed: boolean;
  databases: Array<{ name: string; owner?: string | null; tableCount?: number; rowCount?: number; sizeBytes?: number }>;
  users: Array<{ name: string; host?: string | null }>;
  checks?: Record<string, unknown>;
};
type DatabaseOverview = { engines?: DatabaseOverviewEngine[] };

function usageFrom(account: any) {
  return {
    domains: account._count.domains,
    deployments: account._count.deployments,
    mailAccounts: account._count.mailAccounts,
    databases: account._count.databases ?? 0,
    diskUsedMb: account.diskUsedMb ?? 0,
    diskLimitMb: account.diskLimitMb,
    domainLimit: account.domainLimit,
    mailboxLimit: account.mailboxLimit,
    databaseLimit: account.databaseLimit,
    deploymentLimit: account.deploymentLimit
  };
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function cleanDatabaseIdentifier(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
}

function accountDatabaseIdentifier(prefix: string, value: string) {
  const clean = cleanDatabaseIdentifier(value);
  return clean.startsWith(prefix) ? clean : `${prefix}${clean}`.slice(0, 63);
}

function accountGithubConnectionId(accountId: string) {
  return `account:${accountId}`;
}

function accountGithubTokenSecretRef(accountId: string) {
  return `github:account:${accountId}:token`;
}

async function applyAccountDnsZone(domainId: string, ownerAccountId: string) {
  const domain = await prisma.domain.findFirstOrThrow({
    where: { id: domainId, accountId: ownerAccountId },
    include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
  });
  const zone = renderZone(domain.name, domain.dnsRecords);
  const result = await sysagent.applyDnsZone({ domain: domain.name, zone });
  return { domain, zone, result };
}

async function removeAccountCnameConflicts(record: DnsRecordIdentity) {
  const baseWhere = {
    domainId: record.domainId,
    name: record.name,
    ...(record.id ? { id: { not: record.id } } : {})
  };
  const where: Prisma.DnsRecordWhereInput = record.type === "CNAME"
    ? baseWhere
    : { ...baseWhere, type: "CNAME" };
  return prisma.dnsRecord.deleteMany({ where });
}

function deploymentWebhookSecretRef(deploymentSlug: string) {
  return `deployment:${deploymentSlug}:webhook`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function githubJson<T>(githubPath: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${githubPath}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "vps-panel",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub API failed with ${response.status}`);
  return response.json() as Promise<T>;
}

async function githubRequest<T>(githubPath: string, token: string, init?: RequestInit): Promise<{ data: T; scopes: string[] }> {
  const response = await fetch(`https://api.github.com${githubPath}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "vps-panel",
      "x-github-api-version": "2022-11-28",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(githubApiErrorMessage(response.status, detail));
  }
  const text = await response.text();
  return {
    data: (text ? JSON.parse(text) : null) as T,
    scopes: (response.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean)
  };
}

async function ensureAccountGithubWebhook(
  accountId: string,
  deployment: { id: string; slug: string; githubOwner: string | null; githubRepo: string | null; webhookSecretHash: string | null }
) {
  const connection = await prisma.gitHubConnection.findUnique({ where: { id: accountGithubConnectionId(accountId) } });
  const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
  if (!token || !deployment.githubOwner || !deployment.githubRepo) {
    return { configured: false, reason: "GitHub token or repository is missing" };
  }

  const secretRef = deploymentWebhookSecretRef(deployment.slug);
  const existingSecret = await getSecret(secretRef);
  const secret = existingSecret ?? randomBytes(32).toString("hex");
  if (!existingSecret) {
    await putSecret({
      ref: secretRef,
      value: secret,
      kind: "WEBHOOK_SECRET",
      label: `${deployment.slug} GitHub webhook secret`,
      metadata: { accountId, deploymentId: deployment.id, deploymentSlug: deployment.slug }
    });
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { webhookSecretHash: sha256(secret) }
    });
  }

  const webhookUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/api/v1/webhooks/github`;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(webhookUrl)) {
    return { configured: false, webhookUrl, reason: "FRONTEND_URL points to localhost; set it to the public panel URL before enabling auto deploy" };
  }

  const hookBody = {
    name: "web",
    active: true,
    events: ["push"],
    config: {
      url: webhookUrl,
      content_type: "json",
      secret,
      insecure_ssl: "0"
    }
  };

  try {
    await githubRequest(`/repos/${encodeURIComponent(deployment.githubOwner)}/${encodeURIComponent(deployment.githubRepo)}/hooks`, token, {
      method: "POST",
      body: JSON.stringify(hookBody)
    });
    return { configured: true, webhookUrl };
  } catch (error) {
    if (isGithubWebhookPermissionError(error)) {
      return {
        configured: true,
        webhookUrl,
        manualSetupRequired: true,
        reason: error instanceof Error ? error.message : "GitHub token cannot manage repository webhooks"
      };
    }
    try {
      const hooks = await githubRequest<Array<{ id: number; config?: { url?: string } }>>(
        `/repos/${encodeURIComponent(deployment.githubOwner)}/${encodeURIComponent(deployment.githubRepo)}/hooks?per_page=100`,
        token
      );
      const existing = hooks.data.find((hook) => hook.config?.url === webhookUrl);
      if (existing) {
        await githubRequest(`/repos/${encodeURIComponent(deployment.githubOwner)}/${encodeURIComponent(deployment.githubRepo)}/hooks/${existing.id}`, token, {
          method: "PATCH",
          body: JSON.stringify(hookBody)
        });
        return { configured: true, webhookUrl, updatedExisting: true };
      }
    } catch {
      // Keep the original hook creation error below.
    }
    return { configured: false, webhookUrl, reason: error instanceof Error ? error.message : "Could not create GitHub webhook" };
  }
}

async function uniqueDeploymentSlug(base: string) {
  const root = slugify(base) || "app";
  for (let index = 0; index < 50; index += 1) {
    const slug = index === 0 ? root : `${root}-${index + 1}`;
    const existing = await prisma.deployment.findUnique({ where: { slug } });
    if (!existing) return slug;
  }
  return `${root}-${Date.now()}`;
}

function includeAccountDeployment() {
  return {
    domain: { include: { account: true } },
    domainBindings: {
      include: {
        domain: { include: { account: true } },
        subdomain: { include: { domain: { include: { account: true } } } }
      },
      orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }]
    },
    env: { orderBy: [{ createdAt: "asc" as const }, { key: "asc" as const }] },
    releases: { orderBy: { createdAt: "desc" as const }, take: 10 },
    logs: { orderBy: { createdAt: "desc" as const }, take: 100 }
  };
}

function logMetadataText(metadata: Prisma.JsonValue | null) {
  if (!metadata) return "";
  try {
    return `\n${JSON.stringify(metadata, null, 2)}`;
  } catch {
    return "";
  }
}

const subdomainSelectionPrefix = "subdomain:";

function isSubdomainSelectionId(value: string) {
  return value.startsWith(subdomainSelectionPrefix);
}

function subdomainFqdn(subdomain: { name: string; domain: { name: string } }) {
  return `${subdomain.name}.${subdomain.domain.name}`;
}

function serializeAccountDeploymentBinding(binding: any) {
  if (binding.subdomain) {
    const id = `${subdomainSelectionPrefix}${binding.subdomain.id}`;
    return {
      ...binding,
      domainId: id,
      domain: {
        id,
        name: subdomainFqdn(binding.subdomain),
        forceSsl: binding.subdomain.sslEnabled,
        sslEnabled: binding.subdomain.sslEnabled,
        documentRoot: binding.subdomain.domain.documentRoot,
        includeWww: false
      }
    };
  }
  return binding;
}

function serializeAccountDeployment<T extends { domainBindings?: any[]; domainId?: string | null }>(deployment: T) {
  const domainBindings = deployment.domainBindings?.map(serializeAccountDeploymentBinding);
  const primary = domainBindings?.find((binding) => binding.role === "primary") ?? domainBindings?.[0];
  return {
    ...deployment,
    domainId: primary?.domainId ?? deployment.domainId ?? null,
    domainBindings
  };
}

async function resolveAccountBindingTarget(accountId: string, selectionId: string) {
  if (isSubdomainSelectionId(selectionId)) {
    const subdomainId = selectionId.slice(subdomainSelectionPrefix.length);
    const subdomain = await prisma.subdomain.findFirst({
      where: { id: subdomainId, domain: { accountId } },
      include: { domain: true }
    });
    if (subdomain) {
      return { domainId: null as string | null, subdomainId: subdomain.id, displayName: subdomainFqdn(subdomain) };
    }
    const aliasDomain = await prisma.domain.findFirst({ where: { id: subdomainId, accountId } });
    if (aliasDomain) {
      return { domainId: aliasDomain.id, subdomainId: null as string | null, displayName: aliasDomain.name };
    }
    throw Object.assign(new Error("Domain binding target not found"), { statusCode: 404 });
  }
  const domain = await prisma.domain.findFirstOrThrow({ where: { id: selectionId, accountId } });
  return { domainId: domain.id, subdomainId: null as string | null, displayName: domain.name };
}

async function syncAccountPrimaryBinding(deploymentId: string, accountId: string, selectionId: string | null | undefined) {
  if (selectionId === undefined) return null;
  if (selectionId === null || selectionId === "") {
    await prisma.deploymentDomain.updateMany({ where: { deploymentId, role: "primary" }, data: { role: "alias" } });
    await prisma.deployment.update({ where: { id: deploymentId }, data: { domainId: null } });
    return null;
  }
  const target = await resolveAccountBindingTarget(accountId, selectionId);
  if (target.subdomainId) {
    await prisma.$transaction([
      prisma.deploymentDomain.upsert({
        where: { deploymentId_subdomainId: { deploymentId, subdomainId: target.subdomainId } },
        update: { role: "primary" },
        create: { deploymentId, subdomainId: target.subdomainId, role: "primary" }
      }),
      prisma.deploymentDomain.updateMany({ where: { deploymentId, subdomainId: { not: target.subdomainId }, role: "primary" }, data: { role: "alias" } }),
      prisma.deploymentDomain.updateMany({ where: { deploymentId, domainId: { not: null }, role: "primary" }, data: { role: "alias" } }),
      prisma.deployment.update({ where: { id: deploymentId }, data: { domainId: null } })
    ]);
    return target;
  }
  await prisma.$transaction([
    prisma.deploymentDomain.upsert({
      where: { deploymentId_domainId: { deploymentId, domainId: target.domainId ?? "" } },
      update: { role: "primary" },
      create: { deploymentId, domainId: target.domainId, role: "primary" }
    }),
    prisma.deploymentDomain.updateMany({ where: { deploymentId, domainId: { not: target.domainId }, role: "primary" }, data: { role: "alias" } }),
    prisma.deploymentDomain.updateMany({ where: { deploymentId, subdomainId: { not: null }, role: "primary" }, data: { role: "alias" } }),
    prisma.deployment.update({ where: { id: deploymentId }, data: { domainId: target.domainId } }),
    prisma.domain.update({ where: { id: target.domainId ?? "" }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deploymentId } })
  ]);
  return target;
}

async function findAccountDeployment(request: any, idOrSlug: string) {
  const deployment = await prisma.deployment.findFirstOrThrow({
    where: { accountId: accountId(request), OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: includeAccountDeployment()
  });
  return serializeAccountDeployment(deployment);
}

async function nextDeploymentPort() {
  const deployments = await prisma.deployment.findMany({
    where: { port: { gte: deploymentPortStart, lte: deploymentPortEnd } },
    select: { port: true }
  });
  const used = new Set(deployments.map((deployment) => deployment.port));
  for (let port = deploymentPortStart; port <= deploymentPortEnd; port += 1) {
    if (!used.has(port)) return port;
  }
  throw Object.assign(new Error(`No available deployment ports in ${deploymentPortStart}-${deploymentPortEnd}`), { statusCode: 409 });
}

async function directorySizeBytes(root: string) {
  let total = 0;
  async function walk(dir: string) {
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        total += await fs.stat(fullPath).then((stats) => stats.size).catch(() => 0);
      }
    }
  }
  await walk(root);
  return total;
}

function expiryStatus(expiry: Date | null) {
  if (!expiry) return { state: "missing", daysRemaining: null, alert: false };
  const daysRemaining = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
  return {
    state: daysRemaining < 0 ? "expired" : daysRemaining < 14 ? "expiring" : "valid",
    daysRemaining,
    alert: daysRemaining < 14
  };
}

async function accountSslJobStatus(request: any, jobId: string) {
  const job = await sslQueue.getJob(jobId);
  if (!job) {
    throw Object.assign(new Error("SSL job not found. It may have already been cleaned up."), { statusCode: 404 });
  }
  await assertAccountOwnsSslJob(request, job);
  const state = await job.getState();
  return {
    id: job.id,
    name: job.name,
    state,
    progress: job.progress,
    failedReason: job.failedReason,
    stacktrace: job.stacktrace,
    returnvalue: job.returnvalue,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn
  };
}

async function assertAccountOwnsSslJob(request: any, job: { data?: { domainId?: string | null; subdomainId?: string | null } }) {
  const ownerAccountId = accountId(request);
  if (job.data?.domainId) {
    await prisma.domain.findFirstOrThrow({ where: { id: job.data.domainId, accountId: ownerAccountId } });
    return;
  }
  if (job.data?.subdomainId) {
    await prisma.subdomain.findFirstOrThrow({ where: { id: job.data.subdomainId, domain: { accountId: ownerAccountId } } });
    return;
  }
  throw Object.assign(new Error("SSL job is not linked to this account."), { statusCode: 404 });
}

async function killAccountSslJob(request: any, jobId: string) {
  const job = await sslQueue.getJob(jobId);
  if (!job) {
    throw Object.assign(new Error("SSL job not found. It may have already been cleaned up."), { statusCode: 404 });
  }
  await assertAccountOwnsSslJob(request, job);
  const state = await job.getState();
  const terminal = state === "completed" || state === "failed";
  let processKill: Awaited<ReturnType<typeof sysagent.killSslProcess>> | null = null;
  if (!terminal && job.data?.domain) {
    processKill = await sysagent.killSslProcess({
      domain: job.data.domain,
      certName: job.data.certName ?? certbotCertificateName(job.data.domain)
    }).catch((error) => ({
      returncode: 1,
      stderr: error instanceof Error ? error.message : "Could not kill SSL process"
    }));
  }
  let removed = false;
  if (!terminal) {
    try {
      await job.remove();
      removed = true;
    } catch {
      removed = false;
    }
  }
  return { killed: true, jobId, state, removed, processKill };
}

async function activeAccountSslJobIdForResource(resource: { domainId?: string | null; subdomainId?: string | null }) {
  const jobs = await sslQueue.getJobs(["waiting", "active", "delayed", "paused", "prioritized", "waiting-children"], 0, 100, true);
  const job = jobs.find((item) => {
    if (resource.domainId && item.data?.domainId === resource.domainId) return true;
    if (resource.subdomainId && item.data?.subdomainId === resource.subdomainId) return true;
    return false;
  });
  return job?.id ? String(job.id) : null;
}

function domainLabelInsideParent(domainName: string, parentName: string) {
  if (!domainName.endsWith(`.${parentName}`)) return null;
  const label = domainName.slice(0, -(parentName.length + 1));
  return label && !label.includes("..") ? label : null;
}

async function upsertAccountARecord(domainId: string, name: string) {
  const vpsIp = await currentVpsIp();
  const existing = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name } });
  if (existing) {
    if (existing.value === vpsIp && existing.ttl <= 3600) return existing;
    return prisma.dnsRecord.update({ where: { id: existing.id }, data: { value: vpsIp, ttl: 300 } });
  }
  return prisma.dnsRecord.create({ data: { domainId, type: "A", name, value: vpsIp, ttl: 300 } });
}

async function findAccountManagedParentDomain(ownerAccountId: string, fqdnName: string) {
  const accountDomains = await prisma.domain.findMany({
    where: { accountId: ownerAccountId },
    select: { id: true, name: true }
  });
  const parent = accountDomains
    .filter((item) => domainLabelInsideParent(fqdnName, item.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const subdomainName = parent ? domainLabelInsideParent(fqdnName, parent.name) : null;
  return parent && subdomainName ? { parent, subdomainName } : null;
}

async function createAccountSubdomainShortcut(ownerAccountId: string, fqdnName: string) {
  const managedParent = await findAccountManagedParentDomain(ownerAccountId, fqdnName);
  if (!managedParent) return null;

  const target = await currentVpsIp();
  const recordType = dnsRecordTypeForTarget(target);
  const created = await prisma.$transaction(async (tx) => {
    const subdomain = await tx.subdomain.create({
      data: {
        domainId: managedParent.parent.id,
        name: managedParent.subdomainName,
        target,
        sslEnabled: false
      }
    });
    await tx.dnsRecord.createMany({
      data: [{ domainId: managedParent.parent.id, type: recordType, name: managedParent.subdomainName, value: target, ttl: 300 }],
      skipDuplicates: true
    });
    return {
      subdomain,
      dnsRecord: { type: recordType, name: managedParent.subdomainName, value: target, ttl: 300 }
    };
  });

  let publishWarning: string | undefined;
  try {
    await publishDomainDnsZone(managedParent.parent.id);
  } catch (error) {
    publishWarning = error instanceof Error ? error.message : "Subdomain DNS publish failed";
  }

  return {
    kind: "subdomain" as const,
    name: fqdnName,
    parentDomain: managedParent.parent,
    subdomain: created.subdomain,
    dnsRecord: created.dnsRecord,
    publishWarning
  };
}

async function ensureAccountDomainDns(request: any, domain: { id: string; name: string }) {
  await upsertAccountARecord(domain.id, "@");
  await publishDomainDnsZone(domain.id);

  const parentDomain = await prisma.domain.findFirst({
    where: {
      accountId: accountId(request),
      id: { not: domain.id },
      name: { endsWith: `.${domain.name.split(".").slice(-2).join(".")}` }
    },
    orderBy: { name: "asc" }
  });
  const accountDomains = await prisma.domain.findMany({
    where: { accountId: accountId(request), id: { not: domain.id } },
    select: { id: true, name: true }
  });
  const parent = accountDomains
    .filter((item) => domainLabelInsideParent(domain.name, item.name))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? parentDomain;
  const label = parent ? domainLabelInsideParent(domain.name, parent.name) : null;
  if (parent && label) {
    await upsertAccountARecord(parent.id, label);
    await publishDomainDnsZone(parent.id);
  }
}

function groupAccountDomainRows(items: any[]) {
  const domainsById = new Map(items.map((domain) => [domain.id, {
    ...domain,
    subdomains: [...(domain.subdomains ?? [])],
    _count: { ...domain._count }
  }]));
  const roots = new Set(items.map((domain) => domain.id));

  for (const child of items) {
    const parent = items
      .filter((candidate) => candidate.id !== child.id && domainLabelInsideParent(child.name, candidate.name))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!parent) continue;
    const parentRow = domainsById.get(parent.id);
    if (!parentRow) continue;
    const label = domainLabelInsideParent(child.name, parent.name);
    if (!label) continue;
    parentRow.subdomains.push({
      id: child.id,
      name: label,
      fqdn: child.name,
      target: child.documentRoot || "public_html",
      sslEnabled: child.sslEnabled,
      domainId: child.id,
      isDomainAlias: true,
      dnsRecords: child._count?.dnsRecords ?? 0
    });
    parentRow._count.subdomains = parentRow.subdomains.length;
    roots.delete(child.id);
  }

  return [...domainsById.values()]
    .filter((domain) => roots.has(domain.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function optionalPublicA(hostname: string) {
  try {
    const vpsIp = await currentVpsIp();
    const records = await resolvePublicA(hostname);
    return { host: hostname, records, ok: records.includes(vpsIp), skipped: !records.includes(vpsIp) };
  } catch {
    return { host: hostname, records: [] as string[], ok: false, skipped: true };
  }
}

async function waitForPublicA(hostname: string, expectedIp: string, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastRecords: string[] = [];
  let lastError: string | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const records = await resolvePublicA(hostname);
      lastRecords = records;
      lastError = null;
      if (records.includes(expectedIp)) return records;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "lookup failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const detail = lastRecords.length ? `${hostname} resolves to ${lastRecords.join(", ")}` : lastError ?? `${hostname} has no public A record`;
  throw Object.assign(new Error(`SSL cannot be issued yet. ${detail}, but this VPS is ${expectedIp}. DNS has been published where this panel controls the zone; wait for propagation or update the registrar DNS.`), { statusCode: 400 });
}

async function accountSslPreflight(request: any, domain: { id: string; name: string; documentRoot?: string | null }, includeWww: boolean) {
  await ensureAccountDomainDns(request, domain);
  const vpsIp = await currentVpsIp();
  let records: string[];
  try {
    records = await waitForPublicA(domain.name, vpsIp);
  } catch (error) {
    const certbot = await sysagent.certbotStatus();
    const certbotFailure = failedCommand(certbot);
    if (certbotFailure) {
      throw Object.assign(new Error(`Certbot is not ready for ${domain.name}. ${certbotFailure}`), { statusCode: 400 });
    }
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const webRoot = path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot));
    await fs.mkdir(path.join(webRoot, ".well-known", "acme-challenge"), { recursive: true });
    return {
      webRoot,
      includeWww: false,
      dnsChallenge: true,
      parentDomain: domain.name,
      certName: certbotCertificateName(domain.name),
      dnsChecks: [
        {
          host: `_acme-challenge.${domain.name}`,
          records: [],
          ok: true,
          skipped: false,
          dns01: true,
          reason: error instanceof Error ? error.message : "HTTP A record is not ready"
        }
      ],
      preflight: { certbot, write: certbot, checks: [] }
    };
  }
  const wwwCheck = includeWww ? await optionalPublicA(`www.${domain.name}`) : null;
  const effectiveIncludeWww = Boolean(wwwCheck?.ok);
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
  const webRoot = path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot));
  await fs.mkdir(path.join(webRoot, ".well-known", "acme-challenge"), { recursive: true });
  const nginxResult = await sysagent.writeStaticNginxVhost({
    name: `domain-${nginxResourceName(domain.name)}`,
    serverName: effectiveIncludeWww ? `${domain.name} www.${domain.name}` : domain.name,
    rootPath: webRoot,
    forceHttps: false
  });
  const nginxFailure = failedCommand(nginxResult.test) ?? failedCommand(nginxResult.reload);
  if (nginxFailure) {
    throw Object.assign(new Error(`Could not publish HTTP challenge vhost for ${domain.name}. ${nginxFailure}`), { statusCode: 400 });
  }
  const preflight = await sysagent.sslPreflight({ domain: domain.name, webRoot, includeWww: effectiveIncludeWww });
  const certbotFailure = failedCommand(preflight.certbot);
  if (certbotFailure) {
    throw Object.assign(new Error(`Certbot is not ready for ${domain.name}. ${certbotFailure}`), { statusCode: 400 });
  }
  const failedCheck = preflightChallengeChecks(preflight).find((check) => failedCommand(check));
  if (failedCheck) {
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${domain.name}. Publish the website and keep port 80 open. ${failedCommand(failedCheck) ?? ""}`.trim()), { statusCode: 400 });
  }
  return {
    webRoot,
    includeWww: effectiveIncludeWww,
    dnsChecks: [
      { host: domain.name, records, ok: true, skipped: false },
      ...(wwwCheck ? [wwwCheck] : [])
    ],
    preflight
  };
}

async function accountSubdomainSslTarget(request: any, subdomainId: string) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
  const subdomain = await prisma.subdomain.findFirstOrThrow({
    where: {
      id: subdomainId,
      domain: { accountId: account.id }
    },
    include: { domain: { select: { id: true, name: true } } }
  });
  const fqdn = `${subdomain.name}.${subdomain.domain.name}`;
  const webRoot = path.join(account.homeRoot, "public_html");
  await fs.mkdir(path.join(webRoot, ".well-known", "acme-challenge"), { recursive: true });
  return { account, subdomain, parentDomain: subdomain.domain, fqdn, webRoot };
}

async function accountSubdomainSslPreflight(request: any, subdomainId: string) {
  const target = await accountSubdomainSslTarget(request, subdomainId);
  await publishDomainDnsZone(target.parentDomain.id);

  if (isWildcardHostname(target.fqdn)) {
    const certbot = await sysagent.certbotStatus();
    const certbotFailure = failedCommand(certbot);
    if (certbotFailure) {
      throw Object.assign(new Error(`Certbot is not ready for ${target.fqdn}. ${certbotFailure}`), { statusCode: 400 });
    }
    return {
      ...target,
      dnsChecks: [{ host: `_acme-challenge.${target.parentDomain.name}`, records: [] as string[], ok: true, skipped: false, dns01: true }],
      preflight: { certbot, write: certbot, checks: [], webRoot: target.webRoot },
      includeWww: false,
      dnsChallenge: true,
      parentDomainName: target.parentDomain.name,
      certName: certbotCertificateName(target.fqdn)
    };
  }

  const vpsIp = await currentVpsIp();
  const records = await waitForPublicA(target.fqdn, vpsIp);
  const nginxResult = await sysagent.writeStaticNginxVhost({
    name: `domain-${nginxResourceName(target.fqdn)}`,
    serverName: target.fqdn,
    rootPath: target.webRoot,
    forceHttps: false
  });
  const nginxFailure = failedCommand(nginxResult.test) ?? failedCommand(nginxResult.reload);
  if (nginxFailure) {
    throw Object.assign(new Error(`Could not publish HTTP challenge vhost for ${target.fqdn}. ${nginxFailure}`), { statusCode: 400 });
  }
  const preflight = await sysagent.sslPreflight({ domain: target.fqdn, webRoot: target.webRoot, includeWww: false });
  const certbotFailure = failedCommand(preflight.certbot);
  if (certbotFailure) {
    throw Object.assign(new Error(`Certbot is not ready for ${target.fqdn}. ${certbotFailure}`), { statusCode: 400 });
  }
  const failedCheck = preflightChallengeChecks(preflight).find((check) => failedCommand(check));
  if (failedCheck) {
    throw Object.assign(new Error(`HTTP ACME challenge failed for ${target.fqdn}. Publish the subdomain and keep port 80 open. ${failedCommand(failedCheck) ?? ""}`.trim()), { statusCode: 400 });
  }

  return {
    ...target,
    dnsChecks: [{ host: target.fqdn, records, ok: true, skipped: false }],
    preflight,
    includeWww: false,
    dnsChallenge: false,
    parentDomainName: target.parentDomain.name,
    certName: certbotCertificateName(target.fqdn)
  };
}

async function publishAccountDomainRoute(request: any, account: { id: string; homeRoot: string }, domainId: string) {
  const domain = await prisma.domain.findFirstOrThrow({
    where: { id: domainId, accountId: account.id },
    include: {
      dnsRecords: true,
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      deploymentBindings: {
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        take: 1,
        include: { deployment: true }
      }
    }
  });
  const dnsResult = await sysagent.applyDnsZone({ domain: domain.name, zone: renderZone(domain.name, domain.dnsRecords) });
  const deployment = domain.hostingDeploymentId
    ? await prisma.deployment.findFirst({ where: { id: domain.hostingDeploymentId, accountId: account.id } })
    : domain.deploymentBindings[0]?.deployment ?? domain.deployments[0] ?? null;
  const nginxResult = deployment && deploymentIsRoutable(deployment)
    ? await sysagent.deploymentNginx(
        buildDeploymentNginxRequest({
          deploymentId: deployment.id,
          fqdn: `${domain.name} www.${domain.name}`,
          upstreamPort: deployment.port,
          rootPath: accountDeploymentAppPath(deployment),
          framework: deployment.framework,
          startCommand: deployment.startCommand,
          publicDirectory: deployment.publicDirectory,
          outputDirectory: deployment.outputDirectory,
          fallbackRootPath: path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot)),
          forceSsl: domain.forceSsl && domain.sslEnabled
        })
      )
    : domain.hostingMode === "REDIRECT"
      ? await sysagent.writeRedirectNginxVhost({
          name: `domain-${nginxResourceName(domain.name)}`,
          serverName: `${domain.name} www.${domain.name}`,
          redirectUrl: normalizeRedirectUrl(domain.redirectUrl)
        })
      : await sysagent.writeStaticNginxVhost({
          name: `domain-${nginxResourceName(domain.name)}`,
          serverName: `${domain.name} www.${domain.name}`,
          rootPath: path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot)),
          forceHttps: domain.forceSsl && domain.sslEnabled,
          ...(domain.sslEnabled
            ? {
                sslCertificate: `/etc/letsencrypt/live/${domain.name}/fullchain.pem`,
                sslCertificateKey: `/etc/letsencrypt/live/${domain.name}/privkey.pem`
              }
            : {})
        });
  await audit(request, { action: "APPLY", resource: "domain", resourceId: domain.id, description: `Account published DNS and website for ${domain.name}`, metadata: { dnsResult, nginxResult } as any });
  return { domain, dnsResult, nginxResult };
}

async function queueAccountBulkDomainSslJobs(account: { homeRoot: string }, domains: Array<{ id: string; name: string; documentRoot?: string | null; forceSsl: boolean }>) {
  const jobs = [];
  for (const [index, domain] of domains.entries()) {
    const job = await sslQueue.add("issue", {
      domainId: domain.id,
      domain: domain.name,
      email: `admin@${domain.name}`,
      webRoot: path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot)),
      includeWww: true,
      forceSsl: domain.forceSsl,
      source: "account-bulk-domain-ssl"
    }, {
      delay: index * 60_000,
      attempts: 2,
      backoff: { type: "fixed", delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 500
    });
    jobs.push({ domainId: domain.id, domain: domain.name, jobId: job.id });
  }
  return jobs;
}

async function queueAccountAutoDomainSslJob(account: { homeRoot: string }, domain: { id: string; name: string; documentRoot?: string | null; forceSsl: boolean }, includeWww: boolean) {
  const activeJobId = await activeAccountSslJobIdForResource({ domainId: domain.id });
  if (activeJobId) return { domainId: domain.id, domain: domain.name, jobId: activeJobId, existing: true };
  const job = await sslQueue.add("issue", {
    domainId: domain.id,
    domain: domain.name,
    email: `admin@${domain.name}`,
    webRoot: path.join(account.homeRoot, normalizeDocumentRoot(domain.documentRoot)),
    includeWww,
    forceSsl: domain.forceSsl,
    source: "account-auto-domain-ssl"
  }, {
    attempts: env.ACCOUNT_DOMAIN_AUTO_SSL_ATTEMPTS,
    backoff: { type: "fixed", delay: env.ACCOUNT_DOMAIN_AUTO_SSL_RETRY_DELAY_MS },
    removeOnComplete: 100,
    removeOnFail: 500
  });
  return { domainId: domain.id, domain: domain.name, jobId: job.id, existing: false };
}

async function sslJobCounts() {
  return sslQueue.getJobCounts("waiting", "delayed", "active", "failed");
}

function preflightChallengeChecks(preflight: { checks: unknown[]; localChecks?: unknown[] }) {
  return preflight.localChecks?.length ? preflight.localChecks : preflight.checks;
}

function assertLimit(current: number, limit: number | null | undefined, label: string) {
  if (limit !== null && limit !== undefined && current >= limit) {
    const error = new Error(`${label} package limit reached`);
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
}

function domainInclude() {
  return {
    _count: { select: { subdomains: true, dnsRecords: true, mailAccounts: true } },
    subdomains: { orderBy: { name: "asc" as const } }
  };
}

function normalizeDocumentRoot(value?: string | null) {
  const root = (value || "public_html").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!root || root.includes("..") || path.isAbsolute(root)) {
    const error = new Error("Document root must be a folder inside the account.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return root;
}

function normalizeRedirectUrl(value?: string | null) {
  return value ? value.replace(/\/+$/, "") : null;
}

function dnsRecordTypeForTarget(target: string) {
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(target)) return "A" as const;
  if (target.includes(":")) return "AAAA" as const;
  return "CNAME" as const;
}

async function validateAccountHostingSettings(accountId: string, input: {
  hostingMode?: "PUBLIC_HTML" | "DEPLOYMENT_PROXY" | "REDIRECT";
  hostingDeploymentId?: string | null;
  redirectUrl?: string | null;
}) {
  if (input.hostingMode === "DEPLOYMENT_PROXY") {
    if (!input.hostingDeploymentId) {
      const error = new Error("Select a deployment before using deployment proxy hosting.");
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }
    await prisma.deployment.findFirstOrThrow({ where: { id: input.hostingDeploymentId, accountId } });
  }
  if (input.hostingMode === "REDIRECT" && !input.redirectUrl) {
    const error = new Error("Set a redirect URL before using redirect hosting.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
}

function safeAccountPath(account: { homeRoot: string }, inputPath = ".") {
  const root = path.resolve(account.homeRoot);
  const normalized = inputPath.replaceAll("\\", "/");
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    const error = new Error("Path escapes account file root");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return { root, resolved, relative: path.relative(root, resolved).replaceAll(path.sep, "/") || "." };
}

function accountDeploymentRootPath(account: { homeRoot: string }, requestedPath: string | undefined, slug: string) {
  const fallback = path.join(account.homeRoot, "deployments", slug);
  if (!requestedPath) return fallback;
  const cleanRequested = requestedPath.replaceAll("\\", "/");
  const accountRoot = path.resolve(account.homeRoot);
  const resolvedRequested = path.resolve(cleanRequested);
  if (resolvedRequested === accountRoot || resolvedRequested.startsWith(`${accountRoot}${path.sep}`)) {
    return resolvedRequested;
  }
  if (cleanRequested.startsWith("/var/www/deployments/")) {
    return path.join(account.homeRoot, "deployments", path.basename(cleanRequested));
  }
  return safeAccountPath(account, cleanRequested).resolved;
}

function accountDeploymentAppPath(deployment: { rootPath: string; rootDirectory: string }) {
  return path.resolve(deployment.rootPath, deployment.rootDirectory === "." ? "" : deployment.rootDirectory);
}

function accountDeploymentLogDir(slug: string) {
  return `${env.DEPLOYMENT_LOG_ROOT.replace(/\/+$/, "")}/${slug}`;
}

function accountDeploymentServerName(domain: { name: string; includeWww?: boolean } | null | undefined) {
  if (!domain?.name) return null;
  if (domain.includeWww === false || domain.name.startsWith("*.")) return domain.name;
  return `${domain.name} www.${domain.name}`;
}

function accountDeploymentServerNames(deployment: { domain?: { name: string; includeWww?: boolean } | null; domainBindings?: Array<{ domain?: { name: string; includeWww?: boolean } | null; subdomain?: { name: string; domain?: { name: string } | null } | null }> }) {
  const names = new Set<string>();
  for (const binding of deployment.domainBindings ?? []) {
    if (binding.subdomain?.domain?.name) {
      const serverName = accountDeploymentServerName({ name: `${binding.subdomain.name}.${binding.subdomain.domain.name}`, includeWww: false });
      if (serverName) names.add(serverName);
    } else if (binding.domain?.name) {
      const serverName = accountDeploymentServerName(binding.domain);
      if (serverName) names.add(serverName);
    }
  }
  const primary = accountDeploymentServerName(deployment.domain);
  if (primary) names.add(primary);
  return [...names];
}

function accountDeploymentLogCutoff() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

async function pruneAccountDeploymentLogs(deploymentId: string) {
  await prisma.deploymentLog.deleteMany({
    where: {
      deploymentId,
      createdAt: { lt: accountDeploymentLogCutoff() }
    }
  });
}

function safeChildPath(account: { homeRoot: string }, parentPath: string, name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || unsafeName.test(name)) {
    const error = new Error("Unsafe file or folder name");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  const parent = safeAccountPath(account, parentPath);
  return safeAccountPath(account, path.posix.join(parent.relative, name));
}

async function fileEntry(account: { homeRoot: string }, resolved: string) {
  const stats = await fs.stat(resolved);
  const relative = path.relative(path.resolve(account.homeRoot), resolved).replaceAll(path.sep, "/") || ".";
  const name = path.basename(resolved);
  const isDirectory = stats.isDirectory();
  const extension = isDirectory ? "" : path.extname(name).toLowerCase();
  const textExtensions = new Set([".css", ".env", ".go", ".html", ".ini", ".js", ".json", ".jsx", ".md", ".nginx", ".php", ".prisma", ".py", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
  const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
  return {
    name,
    path: relative,
    type: isDirectory ? "directory" : "file",
    kind: isDirectory ? "directory" : textExtensions.has(extension) ? "text" : imageExtensions.has(extension) ? "image" : extension === ".pdf" ? "pdf" : "binary",
    extension,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    createdAt: stats.birthtime.toISOString(),
    permissions: (stats.mode & 0o777).toString(8).padStart(3, "0"),
    mime: null,
    isHidden: name.startsWith("."),
    isReadonly: false
  };
}

function sortFileEntries(entries: Awaited<ReturnType<typeof fileEntry>>[], sort: "name" | "size" | "modifiedAt", direction: "asc" | "desc") {
  const factor = direction === "asc" ? 1 : -1;
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    if (sort === "size") return (a.size - b.size) * factor;
    if (sort === "modifiedAt") return (new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()) * factor;
    return a.name.localeCompare(b.name) * factor;
  });
}

async function buildFileTree(account: { homeRoot: string }, dir: string, depth: number, state: { count: number }): Promise<any[]> {
  if (depth <= 0 || state.count > 500) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const folders = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  const result = [];
  for (const entry of folders) {
    state.count += 1;
    const fullPath = path.join(dir, entry.name);
    result.push({ ...(await fileEntry(account, fullPath)), children: await buildFileTree(account, fullPath, depth - 1, state) });
  }
  return result;
}

function breadcrumbsFor(relative: string) {
  const parts = relative === "." ? [] : relative.split("/").filter(Boolean);
  const crumbs = [{ name: "root", path: "." }];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

function parentPath(value: string) {
  if (value === "." || !value.includes("/")) return ".";
  return value.split("/").slice(0, -1).join("/") || ".";
}

function failedCommand(result: unknown) {
  const value = result as { returncode?: number; stderr?: string };
  return typeof value?.returncode === "number" && value.returncode !== 0 ? value.stderr || `exit ${value.returncode}` : null;
}

function commandTreeFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const direct = failedCommand(result);
  if (direct) return direct;
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (key === "checks") continue;
    const nested = failedCommand(value);
    if (nested) return `${key}: ${nested}`;
  }
  return null;
}

function assertDatabaseResult(result: unknown, label: string) {
  const failure = commandTreeFailure(result);
  if (failure) throw new Error(`${label} failed: ${failure}`);
}

async function findAccountDatabase(request: any, engine: "POSTGRESQL" | "MYSQL", database: string) {
  return prisma.accountDatabase.findFirstOrThrow({
    where: { accountId: accountId(request), engine, database }
  });
}

async function assertAccountDatabaseUser(request: any, engine: "POSTGRESQL" | "MYSQL", username: string) {
  return prisma.accountDatabase.findFirstOrThrow({
    where: { accountId: accountId(request), engine, username }
  });
}

async function writeDatabaseUploadToTemp(payload: NodeJS.ReadableStream, filename?: string) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-account-db-import-"));
  const safeName = (filename || "database.sql").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(tmpDir, safeName.endsWith(".sql") ? safeName : `${safeName}.sql`);
  const output = createWriteStream(filePath);
  let sizeBytes = 0;

  payload.on("data", (chunk) => {
    sizeBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
    if (sizeBytes > maxImportUploadBytes) {
      (payload as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.(new Error("Database upload is too large. Maximum size is 3GB."));
    }
  });

  try {
    await pipeline(payload, output);
    return { tmpDir, filePath, sizeBytes };
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export const accountPanelRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/vnd.vps-panel.file-upload", { bodyLimit: fileUploadBodyLimitBytes }, (_request, payload, done) => {
    done(null, payload);
  });
  if (!app.hasContentTypeParser(importUploadContentType)) {
    app.addContentTypeParser(importUploadContentType, async (request: FastifyRequest, payload: NodeJS.ReadableStream) => {
      const query = databaseUploadQuerySchema.parse(request.query);
      return writeDatabaseUploadToTemp(payload, query.filename);
    });
  }
  app.addHook("preHandler", app.requireAccount);

  app.get("/me", async (request: any) => {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    return safeAccount(account);
  });

  app.get("/dashboard", async (request: any) => {
    const id = accountId(request);
    const [account, domains, deployments, mailAccounts, databases] = await Promise.all([
      prisma.account.findUniqueOrThrow({ where: { id }, include: { _count: { select: { domains: true, deployments: true, mailAccounts: true, databases: true } } } }),
      prisma.domain.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } }),
      prisma.deployment.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } }),
      prisma.mailAccount.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, include: { domain: true } }),
      prisma.accountDatabase.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" } })
    ]);
    const diskUsedMb = Math.ceil(await directorySizeBytes(account.homeRoot) / 1024 / 1024);
    return {
      account: safeAccount({ ...account, diskUsedMb }),
      usage: usageFrom({ ...account, diskUsedMb }),
      domains,
      deployments,
      mailAccounts,
      databases,
      fileRoot: account.homeRoot
    };
  });

  app.get("/domains", async (request: any) => {
    const query = z.object({
      search: z.string().optional(),
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(50)
    }).parse(request.query);
    const id = accountId(request);
    const subdomainSearch = query.search?.split(".")[0];
    const where = {
      accountId: id,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" as const } },
              ...(subdomainSearch ? [{ subdomains: { some: { name: { contains: subdomainSearch, mode: "insensitive" as const } } } }] : [])
            ]
          }
        : {})
    };
    const rawItems = await prisma.domain.findMany({
      where,
      orderBy: { name: "asc" },
      include: domainInclude()
    });
    const groupedItems = groupAccountDomainRows(rawItems);
    const start = (query.page - 1) * query.pageSize;
    const items = groupedItems.slice(start, start + query.pageSize);
    return { items, total: groupedItems.length, page: query.page, pageSize: query.pageSize };
  });

  app.post("/domains", async (request: any, reply) => {
    const body = createDomainSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    const subdomainShortcut = await createAccountSubdomainShortcut(account.id, body.name).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw Object.assign(new Error("Subdomain already exists"), { statusCode: 409 });
      }
      throw error;
    });
    if (!subdomainShortcut && body.name.startsWith("*.")) {
      throw Object.assign(new Error(`Add the parent domain ${body.name.slice(2)} before creating wildcard subdomain ${body.name}.`), { statusCode: 400 });
    }
    if (subdomainShortcut) {
      await audit(request, {
        action: "CREATE",
        resource: "subdomain",
        resourceId: subdomainShortcut.subdomain.id,
        description: `Account created subdomain ${subdomainShortcut.name}`,
        metadata: JSON.parse(JSON.stringify({
          parentDomainId: subdomainShortcut.parentDomain.id,
          dnsRecord: subdomainShortcut.dnsRecord,
          publishWarning: subdomainShortcut.publishWarning
        })) as Prisma.InputJsonValue
      });
      return reply.code(201).send(subdomainShortcut);
    }
    assertLimit(account._count.domains, account.domainLimit, "Domain");
    const documentRoot = normalizeDocumentRoot(body.documentRoot || "public_html");
    const redirectUrl = normalizeRedirectUrl(body.redirectUrl);
    await validateAccountHostingSettings(account.id, { ...body, redirectUrl });
    const vpsIp = await currentVpsIp();
    try {
      const domain = await prisma.$transaction(async (tx) => {
        const created = await tx.domain.create({
          data: {
            name: body.name,
            accountId: account.id,
            status: "ACTIVE",
            forceSsl: body.forceSsl,
            hostingMode: body.hostingMode,
            documentRoot,
            redirectUrl,
            hostingDeploymentId: body.hostingDeploymentId ?? null
          }
        });
        await tx.dnsRecord.createMany({ data: defaultRecords(created.id, created.name, [], vpsIp), skipDuplicates: true });
        return tx.domain.findUniqueOrThrow({ where: { id: created.id }, include: domainInclude() });
      });
      const sslJob = env.ACCOUNT_DOMAIN_AUTO_SSL_ENABLED && body.autoSsl && body.forceSsl
        ? await queueAccountAutoDomainSslJob(account, domain, body.autoSslIncludeWww)
        : null;
      let publishResult: Awaited<ReturnType<typeof publishAccountDomainRoute>> | null = null;
      let publishWarning: string | null = null;
      try {
        publishResult = await publishAccountDomainRoute(request, account, domain.id);
      } catch (error) {
        publishWarning = error instanceof Error ? error.message : "Domain publish failed";
      }
      await audit(request, {
        action: "CREATE",
        resource: "domain",
        resourceId: domain.id,
        description: `Account created domain ${domain.name}`,
        metadata: { autoSslQueued: Boolean(sslJob), sslJob, publishWarning } as any
      });
      return reply.code(201).send({
        ...domain,
        autoSslQueued: Boolean(sslJob),
        sslJob,
        publishWarning,
        publishResult: publishResult ? { dnsResult: publishResult.dnsResult, nginxResult: publishResult.nginxResult } : null
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "Domain already exists" });
      }
      throw error;
    }
  });

  app.post("/domains/bulk", async (request: any, reply) => {
    const body = bulkDomainSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true } } }
    });
    const uniqueDomains = [...new Set(body.domains)];
    const results: Array<{ input: string; name: string; status: "created" | "skipped" | "failed"; kind?: "domain" | "subdomain"; error?: string; publishWarning?: string }> = [];
    const sslTargets: Array<{ id: string; name: string; documentRoot?: string | null; forceSsl: boolean }> = [];
    let currentDomainCount = account._count.domains;

    for (const name of uniqueDomains) {
      try {
        const subdomainShortcut = await createAccountSubdomainShortcut(account.id, name);
        if (!subdomainShortcut && name.startsWith("*.")) {
          throw new Error(`Add the parent domain ${name.slice(2)} before creating wildcard subdomain ${name}.`);
        }
        if (subdomainShortcut) {
          await audit(request, {
            action: "CREATE",
            resource: "subdomain",
            resourceId: subdomainShortcut.subdomain.id,
            description: `Account bulk-created subdomain ${subdomainShortcut.name}`,
            metadata: JSON.parse(JSON.stringify({
              parentDomainId: subdomainShortcut.parentDomain.id,
              dnsRecord: subdomainShortcut.dnsRecord,
              publishWarning: subdomainShortcut.publishWarning
            })) as Prisma.InputJsonValue
          });
          results.push({ input: name, name: subdomainShortcut.name, status: "created", kind: "subdomain", publishWarning: subdomainShortcut.publishWarning });
          continue;
        }
        const vpsIp = await currentVpsIp();
        const existing = await prisma.domain.findUnique({ where: { name } });
        if (existing && body.skipExisting) {
          results.push({ input: name, name, status: "skipped", error: "Domain already exists" });
          continue;
        }
        assertLimit(currentDomainCount, account.domainLimit, "Domain");
        const domain = await prisma.$transaction(async (tx) => {
          const created = await tx.domain.create({
            data: {
              name,
              accountId: account.id,
              status: "ACTIVE",
              forceSsl: body.forceSsl,
              hostingMode: "PUBLIC_HTML",
              documentRoot: "public_html"
            }
          });
          await tx.dnsRecord.createMany({ data: defaultRecords(created.id, created.name, [], vpsIp), skipDuplicates: true });
          return tx.domain.findUniqueOrThrow({ where: { id: created.id }, include: domainInclude() });
        });
        currentDomainCount += 1;
        let publishWarning: string | undefined;
        if (body.publish) {
          try {
            const records = await prisma.dnsRecord.findMany({ where: { domainId: domain.id } });
            await sysagent.applyDnsZone({ domain: domain.name, zone: renderZone(domain.name, records) });
          } catch (error) {
            publishWarning = error instanceof Error ? error.message : "Domain DNS publish failed";
          }
        }
        await audit(request, { action: "CREATE", resource: "domain", resourceId: domain.id, description: `Account bulk-created domain ${domain.name}` });
        if (body.issueSsl) {
          sslTargets.push({ id: domain.id, name: domain.name, documentRoot: domain.documentRoot, forceSsl: domain.forceSsl });
        }
        results.push({ input: name, name: domain.name, status: "created", kind: "domain", publishWarning });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && body.skipExisting) {
          results.push({ input: name, name, status: "skipped", error: "Domain or subdomain already exists" });
          continue;
        }
        results.push({ input: name, name, status: "failed", error: error instanceof Error ? error.message : "Could not add domain" });
      }
    }
    const summary = {
      created: results.filter((result) => result.status === "created").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length
    };
    const sslJobs = body.issueSsl ? await queueAccountBulkDomainSslJobs(account, sslTargets) : [];
    const queueCounts = body.issueSsl ? await sslJobCounts() : undefined;
    return reply.code(summary.failed > 0 ? 207 : 201).send({ ...summary, total: results.length, results, sslQueued: sslJobs.length, sslJobs, queueCounts });
  });

  app.post("/domains/bulk-action", async (request: any) => {
    const body = bulkDomainActionSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const uniqueDomainIds = [...new Set(body.domainIds)];
    const domains = await prisma.domain.findMany({
      where: { id: { in: uniqueDomainIds }, accountId: account.id },
      select: { id: true, name: true, documentRoot: true, forceSsl: true }
    });
    const foundIds = new Set(domains.map((domain) => domain.id));
    const missing = uniqueDomainIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw app.httpErrors.notFound(`Could not find ${missing.length} selected domain(s).`);
    }

    if (body.action === "delete") {
      await prisma.domain.deleteMany({ where: { id: { in: uniqueDomainIds }, accountId: account.id } });
      await audit(request, {
        action: "DELETE",
        resource: "domain",
        description: `Account bulk deleted ${domains.length} domain(s)`,
        metadata: JSON.parse(JSON.stringify({ domains })) as Prisma.InputJsonValue
      });
      return { ok: true, action: body.action, affected: domains.length, sslQueued: 0, sslJobs: [] };
    }

    if (body.action === "activate" || body.action === "deactivate") {
      const status = body.action === "activate" ? "ACTIVE" : "SUSPENDED";
      await prisma.domain.updateMany({ where: { id: { in: uniqueDomainIds }, accountId: account.id }, data: { status } });
      await audit(request, {
        action: "UPDATE",
        resource: "domain",
        description: `Account bulk updated ${domains.length} domain(s) to ${status}`,
        metadata: JSON.parse(JSON.stringify({ domains, status })) as Prisma.InputJsonValue
      });
      return { ok: true, action: body.action, affected: domains.length, sslQueued: 0, sslJobs: [] };
    }

    if (body.action === "force_ssl") {
      await prisma.domain.updateMany({ where: { id: { in: uniqueDomainIds }, accountId: account.id }, data: { forceSsl: true } });
      await audit(request, {
        action: "UPDATE",
        resource: "domain",
        description: `Account bulk enabled Force SSL for ${domains.length} domain(s)`,
        metadata: JSON.parse(JSON.stringify({ domains })) as Prisma.InputJsonValue
      });
      return { ok: true, action: body.action, affected: domains.length, sslQueued: 0, sslJobs: [] };
    }

    await prisma.domain.updateMany({ where: { id: { in: uniqueDomainIds }, accountId: account.id }, data: { forceSsl: true } });
    const updatedDomains = await prisma.domain.findMany({
      where: { id: { in: uniqueDomainIds }, accountId: account.id },
      select: { id: true, name: true, documentRoot: true, forceSsl: true }
    });
    const sslJobs = await queueAccountBulkDomainSslJobs(account, updatedDomains);
    const queueCounts = await sslJobCounts();
    await audit(request, {
      action: "APPLY",
      resource: "ssl",
      description: `Account bulk queued SSL for ${sslJobs.length} domain(s)`,
      metadata: JSON.parse(JSON.stringify({ domains: updatedDomains, sslJobs })) as Prisma.InputJsonValue
    });
    return { ok: true, action: body.action, affected: domains.length, sslQueued: sslJobs.length, sslJobs, queueCounts };
  });

  app.get("/domains/:domainId", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({
      where: { id: domainId, accountId: accountId(request) },
      include: {
        dnsRecords: { orderBy: [{ type: "asc" as const }, { name: "asc" as const }] },
        subdomains: { orderBy: { name: "asc" as const } },
        mailAccounts: { orderBy: { username: "asc" as const } },
        deployments: { orderBy: { createdAt: "desc" as const }, take: 1 }
      }
    });
    const { deployments, ...rest } = domain;
    return { ...rest, deployment: deployments[0] ?? null };
  });

  app.patch("/domains/:domainId/status", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ status: z.enum(["ACTIVE", "PENDING", "SUSPENDED"]) }).parse(request.body);
    const domain = await prisma.domain.update({
      where: { id: (await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } })).id },
      data: { status: body.status },
      include: domainInclude()
    });
    await audit(request, { action: "UPDATE", resource: "domain", resourceId: domain.id, description: `Account updated ${domain.name} status to ${body.status}` });
    return domain;
  });

  app.patch("/domains/:domainId", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = domainUpdateSchema.parse(request.body);
    const existing = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const nextHostingMode = body.hostingMode ?? existing.hostingMode;
    const nextRedirectUrl = normalizeRedirectUrl(body.redirectUrl === undefined ? existing.redirectUrl : body.redirectUrl);
    const nextHostingDeploymentId = body.hostingDeploymentId === undefined ? existing.hostingDeploymentId : body.hostingDeploymentId;
    await validateAccountHostingSettings(accountId(request), { hostingMode: nextHostingMode, hostingDeploymentId: nextHostingDeploymentId, redirectUrl: nextRedirectUrl });
    const domain = await prisma.domain.update({
      where: { id: existing.id },
      data: {
        ...body,
        ...(body.documentRoot !== undefined ? { documentRoot: normalizeDocumentRoot(body.documentRoot) } : {}),
        ...(body.redirectUrl !== undefined ? { redirectUrl: nextRedirectUrl } : {})
      },
      include: domainInclude()
    });
    await audit(request, { action: "UPDATE", resource: "domain", resourceId: domain.id, description: `Account updated domain ${domain.name}` });
    return domain;
  });

  app.post("/domains/:domainId/publish", async (request: any, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({
      where: { id: domainId, accountId: accountId(request) },
      include: {
        dnsRecords: true,
        deployments: { orderBy: { createdAt: "desc" }, take: 1 },
        deploymentBindings: {
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
          take: 1,
          include: { deployment: true }
        }
      }
    });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    return reply.code(202).send(await publishAccountDomainRoute(request, account, domain.id));
  });

  app.delete("/domains/:domainId", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = z.object({ confirmName: z.string() }).parse(request.body ?? {});
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    if (body.confirmName !== domain.name) throw app.httpErrors.badRequest("Domain deletion requires exact domain name confirmation");
    await prisma.domain.delete({ where: { id: domain.id } });
    await audit(request, { action: "DELETE", resource: "domain", resourceId: domain.id, description: `Account deleted domain ${domain.name}` });
    return { ok: true };
  });

  app.post("/domains/:domainId/subdomains", async (request: any, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = subdomainSchema.parse(request.body);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const recordType = dnsRecordTypeForTarget(body.target);
    const result = await prisma.$transaction(async (tx) => {
      const subdomain = await tx.subdomain.create({ data: { domainId: domain.id, name: body.name, target: body.target, sslEnabled: body.sslEnabled } });
      await tx.dnsRecord.createMany({
        data: [{ domainId: domain.id, type: recordType, name: body.name, value: body.target }],
        skipDuplicates: true
      });
      return { subdomain, dnsRecord: { type: recordType, name: body.name, value: body.target } };
    });
    await audit(request, { action: "CREATE", resource: "subdomain", resourceId: result.subdomain.id, description: `Account created subdomain ${body.name}.${domain.name}` });
    return reply.code(201).send(result);
  });

  app.post("/domains/dns/bulk-zone-action", async (request: any, reply) => {
    const body = bulkZoneActionSchema.parse(request.body);
    const ownerAccountId = accountId(request);
    const uniqueDomainIds = [...new Set(body.domainIds)];
    const domains = await prisma.domain.findMany({
      where: { id: { in: uniqueDomainIds }, accountId: ownerAccountId },
      select: { id: true, name: true }
    });
    const foundIds = new Set(domains.map((domain) => domain.id));
    const missing = uniqueDomainIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) throw app.httpErrors.notFound(`Could not find ${missing.length} selected zone(s).`);

    if (body.action === "add") {
      if (!body.record) throw app.httpErrors.badRequest("Record data is required for bulk add.");
      const created = [];
      for (const domain of domains) {
        const record = await prisma.dnsRecord.create({
          data: {
            domainId: domain.id,
            type: body.record.type,
            name: body.record.name,
            value: body.record.value,
            ttl: body.record.ttl,
            priority: body.record.priority ?? null
          }
        });
        created.push(record);
        await removeAccountCnameConflicts(record);
      }
      const appliedZones = await Promise.all(domains.map((domain) => applyAccountDnsZone(domain.id, ownerAccountId)));
      await audit(request, { action: "CREATE", resource: "dns_record", description: `Account bulk added ${body.record.type} record to ${created.length} zone(s)`, metadata: { domains: domains.map((domain) => domain.name), record: body.record, applied: appliedZones.length } as any });
      return reply.code(201).send({ ok: true, action: body.action, affected: created.length, applied: appliedZones.length });
    }

    if (!body.match) throw app.httpErrors.badRequest("Record match type and name are required.");

    if (body.action === "delete") {
      const deleted = await prisma.dnsRecord.deleteMany({
        where: { domainId: { in: uniqueDomainIds }, type: body.match.type, name: body.match.name }
      });
      const appliedZones = await Promise.all(domains.map((domain) => applyAccountDnsZone(domain.id, ownerAccountId)));
      await audit(request, { action: "DELETE", resource: "dns_record", description: `Account bulk deleted ${body.match.type} ${body.match.name} record from ${deleted.count} zone(s)`, metadata: { domains: domains.map((domain) => domain.name), match: body.match, applied: appliedZones.length } as any });
      return { ok: true, action: body.action, affected: deleted.count, applied: appliedZones.length };
    }

    if (!body.patch || Object.keys(body.patch).length === 0) throw app.httpErrors.badRequest("Patch data is required for bulk edit.");
    const records = await prisma.dnsRecord.findMany({
      where: { domainId: { in: uniqueDomainIds }, type: body.match.type, name: body.match.name }
    });
    let updated = 0;
    for (const existing of records) {
      const merged = dnsRecordSchema.parse({ ...existing, ...body.patch });
      await prisma.dnsRecord.update({
        where: { id: existing.id },
        data: {
          type: merged.type,
          name: merged.name,
          value: merged.value,
          ttl: merged.ttl,
          priority: merged.priority ?? null
        }
      });
      await removeAccountCnameConflicts({ domainId: existing.domainId, id: existing.id, type: merged.type, name: merged.name });
      updated += 1;
    }
    const appliedZones = await Promise.all(domains.map((domain) => applyAccountDnsZone(domain.id, ownerAccountId)));
    await audit(request, { action: "UPDATE", resource: "dns_record", description: `Account bulk edited ${body.match.type} ${body.match.name} record in ${updated} zone(s)`, metadata: { domains: domains.map((domain) => domain.name), match: body.match, patch: body.patch, applied: appliedZones.length } as any });
    return { ok: true, action: body.action, affected: updated, applied: appliedZones.length };
  });

  app.get("/domains/:domainId/dns", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    return prisma.dnsRecord.findMany({ where: { domainId: domain.id }, orderBy: [{ type: "asc" }, { name: "asc" }] });
  });

  app.get("/domains/:domainId/dns/zone", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({
      where: { id: domainId, accountId: accountId(request) },
      include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
    });
    return {
      domain: domain.name,
      serial: new Date().toISOString().slice(0, 10).replace(/-/g, "") + "01",
      zone: renderZone(domain.name, domain.dnsRecords)
    };
  });

  app.post("/domains/:domainId/dns", async (request: any, reply) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = dnsRecordSchema.parse(request.body);
    const ownerAccountId = accountId(request);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: ownerAccountId } });
    const record = await prisma.dnsRecord.create({
      data: {
        domainId: domain.id,
        type: body.type,
        name: body.name,
        value: body.value,
        ttl: body.ttl,
        priority: body.priority ?? null
      }
    });
    await removeAccountCnameConflicts(record);
    const applied = await applyAccountDnsZone(domain.id, ownerAccountId);
    await audit(request, { action: "CREATE", resource: "dns_record", resourceId: record.id, description: `Account created ${record.type} record for ${domain.name}`, metadata: { applied: applied.result } as any });
    return reply.code(201).send(record);
  });

  app.patch("/domains/:domainId/dns/:recordId", async (request: any) => {
    const { domainId, recordId } = z.object({ domainId: z.string(), recordId: z.string() }).parse(request.params);
    const ownerAccountId = accountId(request);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: ownerAccountId } });
    const existing = await prisma.dnsRecord.findFirstOrThrow({ where: { id: recordId, domainId: domain.id } });
    const body = dnsRecordSchema.parse({ ...existing, ...dnsRecordSchema.partial().parse(request.body) });
    const record = await prisma.dnsRecord.update({
      where: { id: existing.id },
      data: {
        type: body.type,
        name: body.name,
        value: body.value,
        ttl: body.ttl,
        priority: body.priority ?? null
      }
    });
    await removeAccountCnameConflicts(record);
    const applied = await applyAccountDnsZone(domain.id, ownerAccountId);
    await audit(request, { action: "UPDATE", resource: "dns_record", resourceId: record.id, description: `Account updated ${record.type} record for ${domain.name}`, metadata: { applied: applied.result } as any });
    return record;
  });

  app.delete("/domains/:domainId/dns/:recordId", async (request: any) => {
    const { domainId, recordId } = z.object({ domainId: z.string(), recordId: z.string() }).parse(request.params);
    const ownerAccountId = accountId(request);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: ownerAccountId } });
    const deleted = await prisma.dnsRecord.deleteMany({ where: { id: recordId, domainId: domain.id } });
    if (deleted.count === 0) throw app.httpErrors.notFound("DNS record not found");
    const applied = await applyAccountDnsZone(domain.id, ownerAccountId);
    await audit(request, { action: "DELETE", resource: "dns_record", resourceId: recordId, description: `Account deleted DNS record for ${domain.name}`, metadata: { applied: applied.result } as any });
    return { ok: true };
  });

  app.get("/ssl/jobs/:jobId", async (request: any) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    return accountSslJobStatus(request, jobId);
  });

  app.post("/ssl/jobs/:jobId/kill", async (request: any) => {
    const { jobId } = z.object({ jobId: z.string() }).parse(request.params);
    return killAccountSslJob(request, jobId);
  });

  app.get("/ssl/domains/:domainId/status", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const effectiveExpiry = domain.sslEnabled ? domain.sslExpiry : null;
    return {
      domainId: domain.id,
      domain: domain.name,
      sslEnabled: domain.sslEnabled,
      sslExpiry: effectiveExpiry,
      forceSsl: domain.forceSsl,
      activeJobId: await activeAccountSslJobIdForResource({ domainId: domain.id }),
      ...expiryStatus(effectiveExpiry)
    };
  });

  app.get("/ssl/subdomains/:subdomainId/status", async (request: any) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    const target = await accountSubdomainSslTarget(request, subdomainId);
    const cert = await sysagent.certificateStatus(certbotCertificateName(target.fqdn)) as { exists?: boolean; expiry?: string | null };
    const expiry = cert.exists && cert.expiry ? new Date(cert.expiry) : null;
    return {
      subdomainId,
      domain: target.fqdn,
      sslEnabled: target.subdomain.sslEnabled && Boolean(cert.exists),
      sslExpiry: expiry,
      forceSsl: target.subdomain.sslEnabled,
      activeJobId: await activeAccountSslJobIdForResource({ subdomainId }),
      ...expiryStatus(expiry)
    };
  });

  app.post("/ssl/domains/:domainId/preflight", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const body = sslSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const preflight = await accountSslPreflight(request, domain, body.includeWww);
    return {
      webRoot: preflight.webRoot,
      includeWww: preflight.includeWww,
      dnsChecks: preflight.dnsChecks
    };
  });

  app.post("/ssl/subdomains/:subdomainId/preflight", async (request: any) => {
    const { subdomainId } = z.object({ subdomainId: z.string() }).parse(request.params);
    const preflight = await accountSubdomainSslPreflight(request, subdomainId);
    return {
      webRoot: preflight.webRoot,
      includeWww: preflight.includeWww,
      dnsChecks: preflight.dnsChecks
    };
  });

  app.post("/ssl/domains/:domainId/:action", async (request: any, reply) => {
    const { domainId, action } = z.object({ domainId: z.string(), action: z.enum(["issue", "renew"]) }).parse(request.params);
    const body = sslSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const preflight = await accountSslPreflight(request, domain, body.includeWww);
    const job = await sslQueue.add(action, {
      domainId: domain.id,
      domain: domain.name,
      email: body.email ?? `admin@${domain.name}`,
      webRoot: preflight.webRoot,
      includeWww: preflight.includeWww,
      dnsChallenge: preflight.dnsChallenge ?? false,
      parentDomain: preflight.parentDomain,
      certName: preflight.certName,
      forceSsl: domain.forceSsl,
      source: "account"
    });
    if (action === "issue") {
      await prisma.domain.update({ where: { id: domain.id }, data: { sslEnabled: false, sslExpiry: null } });
    }
    await audit(request, { action: "APPLY", resource: "ssl", resourceId: domain.id, description: `Account queued SSL ${action} for ${domain.name}` });
    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.post("/ssl/subdomains/:subdomainId/:action", async (request: any, reply) => {
    const { subdomainId, action } = z.object({ subdomainId: z.string(), action: z.enum(["issue", "renew"]) }).parse(request.params);
    const preflight = await accountSubdomainSslPreflight(request, subdomainId);
    const job = await sslQueue.add(action, {
      domainId: null,
      subdomainId,
      domain: preflight.fqdn,
      email: `admin@${preflight.parentDomain.name}`,
      webRoot: preflight.webRoot,
      includeWww: false,
      forceSsl: true,
      dnsChallenge: preflight.dnsChallenge,
      parentDomain: preflight.parentDomainName,
      certName: preflight.certName,
      source: "account-subdomain-ssl"
    });
    if (action === "issue") {
      await prisma.subdomain.update({ where: { id: subdomainId }, data: { sslEnabled: false } });
    }
    await audit(request, { action: "APPLY", resource: "ssl", resourceId: subdomainId, description: `Account queued SSL ${action} for ${preflight.fqdn}` });
    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.get("/domains/:domainId/ssl", async (request: any) => {
    const { domainId } = z.object({ domainId: z.string() }).parse(request.params);
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    return {
      domainId: domain.id,
      domain: domain.name,
      sslEnabled: domain.sslEnabled,
      sslExpiry: domain.sslExpiry,
      forceSsl: domain.forceSsl,
      ...expiryStatus(domain.sslEnabled ? domain.sslExpiry : null)
    };
  });

  app.post("/domains/:domainId/ssl/:action", async (request: any, reply) => {
    const { domainId, action } = z.object({ domainId: z.string(), action: z.enum(["issue", "renew"]) }).parse(request.params);
    const body = sslSchema.parse(request.body ?? {});
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: domainId, accountId: accountId(request) } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const webRoot = path.join(account.homeRoot, "public_html");
    const job = await sslQueue.add(action, {
      domainId: domain.id,
      domain: domain.name,
      email: body.email ?? `admin@${domain.name}`,
      webRoot,
      includeWww: body.includeWww,
      forceSsl: domain.forceSsl,
      source: "account"
    });
    await audit(request, { action: "APPLY", resource: "ssl", resourceId: domain.id, description: `Account queued SSL ${action} for ${domain.name}` });
    return reply.code(202).send({ queued: true, jobId: job.id });
  });

  app.get("/deployments", async (request: any) => {
    const query = z.object({
      search: z.string().default(""),
      status: z.string().default(""),
      sourceProvider: z.string().default(""),
      page: z.coerce.number().min(1).default(1),
      pageSize: z.coerce.number().min(1).max(100).default(50)
    }).parse(request.query);
    const where = {
      accountId: accountId(request),
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: "insensitive" as const } }, { slug: { contains: query.search, mode: "insensitive" as const } }] } : {}),
      ...(query.status ? { status: query.status as any } : {}),
      ...(query.sourceProvider ? { sourceProvider: query.sourceProvider as any } : {})
    };
    const [items, total] = await Promise.all([
      prisma.deployment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: includeAccountDeployment()
      }),
      prisma.deployment.count({ where })
    ]);
    return { items: items.map(serializeAccountDeployment), total, page: query.page, pageSize: query.pageSize };
  });

  app.get("/deployments/ports/next", async () => ({ port: await nextDeploymentPort() }));

  app.post("/deployments/detect", async () => ({
    detected: "STATIC",
    confidence: 0.4,
    reason: "Account-scoped framework detection uses the default static profile.",
    suggestions: { runtime: "STATIC", packageManager: null, installCommand: null, buildCommand: null, startCommand: null, outputDirectory: "public" }
  }));

  app.get("/deployments/github/connection", async (request: any) => {
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: accountGithubConnectionId(accountId(request)) } });
    return {
      connected: Boolean(connection?.tokenSecretRef || connection?.installationId),
      username: connection?.username ?? null,
      installationId: connection?.installationId ?? null,
      scopes: connection?.scopes ?? [],
      connectedAt: connection?.connectedAt ?? null
    };
  });

  app.put("/deployments/github/connection", async (request: any) => {
    const body = githubConnectionSchema.parse(request.body);
    const connectionId = accountGithubConnectionId(accountId(request));
    const tokenSecretRef = accountGithubTokenSecretRef(accountId(request));
    let verifiedUsername = body.username ?? null;
    let verifiedScopes = body.scopes;
    if (typeof body.token === "string") {
      const verified = await githubRequest<{ login: string }>("/user", body.token);
      verifiedUsername = verifiedUsername || verified.data.login;
      verifiedScopes = verified.scopes;
      await putSecret({
        ref: tokenSecretRef,
        value: body.token,
        kind: "GITHUB_TOKEN",
        label: verifiedUsername ? `${verifiedUsername} GitHub token` : "GitHub token",
        metadata: { username: verifiedUsername, scopes: verifiedScopes }
      });
    } else if (body.token === null) {
      await deleteSecret(tokenSecretRef);
    }
    const connection = await prisma.gitHubConnection.upsert({
      where: { id: connectionId },
      update: {
        username: verifiedUsername ?? undefined,
        tokenSecretRef: typeof body.token === "string" ? tokenSecretRef : body.token === null ? null : undefined,
        installationId: body.installationId ?? undefined,
        scopes: verifiedScopes,
        connectedAt: body.token || body.installationId ? new Date() : undefined
      },
      create: {
        id: connectionId,
        username: verifiedUsername ?? undefined,
        tokenSecretRef: typeof body.token === "string" ? tokenSecretRef : undefined,
        installationId: body.installationId ?? undefined,
        scopes: verifiedScopes,
        connectedAt: body.token || body.installationId ? new Date() : undefined
      }
    });
    return { connected: Boolean(connection.tokenSecretRef || connection.installationId), username: connection.username, scopes: connection.scopes };
  });

  app.get("/deployments/github/repos", async (request: any) => {
    const query = z.object({ search: z.string().optional() }).parse(request.query);
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: accountGithubConnectionId(accountId(request)) } });
    if (!connection?.tokenSecretRef && !connection?.installationId) {
      return {
        connected: false,
        dryRun: true,
        items: query.search
          ? [{ owner: "example", name: `${slugify(query.search)}-app`, fullName: `example/${slugify(query.search)}-app`, private: false, defaultBranch: "main" }]
          : []
      };
    }
    if (!connection.tokenSecretRef) return { connected: true, dryRun: true, items: [], note: "GitHub App installation listing is pending" };
    const token = await getSecret(connection.tokenSecretRef);
    if (!token) return { connected: false, dryRun: true, items: [], note: "GitHub token secret is missing" };
    const repos = await githubJson<Array<{ id: number; owner: { login: string }; name: string; full_name: string; private: boolean; default_branch: string; html_url: string; updated_at: string }>>("/user/repos?per_page=100&sort=updated", token);
    const search = query.search?.toLowerCase();
    const items = repos
      .filter((repo) => !search || repo.full_name.toLowerCase().includes(search) || repo.name.toLowerCase().includes(search))
      .map((repo) => ({
        id: String(repo.id),
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        url: repo.html_url,
        updatedAt: repo.updated_at
      }));
    return { connected: true, dryRun: false, items };
  });

  app.get("/deployments/github/repos/:owner/:repo/detect", async (request: any) => {
    const params = z.object({ owner: z.string(), repo: z.string() }).parse(request.params);
    const query = z.object({ branch: z.string().default("main"), rootDirectory: z.string().default(".") }).parse(request.query);
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: accountGithubConnectionId(accountId(request)) } });
    const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
    if (!token) {
      return {
        repository: `${params.owner}/${params.repo}`,
        dryRun: true,
        ...(detectDeploymentFiles(["package.json", "next.config.js"], null, null))
      };
    }
    const requestedPath = query.rootDirectory === "." ? "" : query.rootDirectory.replace(/^\/+|\/+$/g, "");
    const contentsPath = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${requestedPath}?ref=${encodeURIComponent(query.branch)}`;
    const contents = await githubJson<Array<{ name: string; type: string }>>(contentsPath, token);
    const files = Array.isArray(contents) ? contents.map((item) => item.name) : [];
    let packageJson: string | null = null;
    let composerJson: string | null = null;
    if (files.some((file) => file.toLowerCase() === "package.json")) {
      const packagePath = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${requestedPath ? `${requestedPath}/` : ""}package.json?ref=${encodeURIComponent(query.branch)}`;
      const packageFile = await githubJson<{ content: string; encoding: string }>(packagePath, token);
      if (packageFile.encoding === "base64") packageJson = Buffer.from(packageFile.content, "base64").toString("utf8");
    }
    if (files.some((file) => file.toLowerCase() === "composer.json")) {
      const composerPath = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${requestedPath ? `${requestedPath}/` : ""}composer.json?ref=${encodeURIComponent(query.branch)}`;
      const composerFile = await githubJson<{ content: string; encoding: string }>(composerPath, token);
      if (composerFile.encoding === "base64") composerJson = Buffer.from(composerFile.content, "base64").toString("utf8");
    }
    return {
      repository: `${params.owner}/${params.repo}`,
      dryRun: false,
      ...detectDeploymentFiles(files, packageJson, composerJson)
    };
  });

  app.post("/deployments", async (request: any, reply) => {
    const body = deploymentSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true, databases: true } } }
    });
    assertLimit(account._count.deployments, account.deploymentLimit, "Deployment");
    const bindingTarget = body.domainId ? await resolveAccountBindingTarget(account.id, body.domainId) : null;
    const slug = await uniqueDeploymentSlug(body.slug || body.name);
    const rootPath = accountDeploymentRootPath(account, body.rootPath, slug);
    await fs.mkdir(rootPath, { recursive: true });
    const deployment = await prisma.deployment.create({
      data: {
        accountId: account.id,
        domainId: bindingTarget?.domainId ?? null,
        name: body.name,
        slug,
        framework: body.framework,
        runtime: body.framework === "STATIC" ? "STATIC" : null,
        sourceProvider: body.sourceProvider,
        repoUrl: body.repoUrl ?? (body.githubOwner && body.githubRepo ? `https://github.com/${body.githubOwner}/${body.githubRepo}` : null),
        gitUrl: body.gitUrl ?? null,
        githubOwner: body.githubOwner ?? null,
        githubRepo: body.githubRepo ?? null,
        githubRepoId: body.githubRepoId ?? null,
        githubVisibility: body.githubVisibility ?? null,
        branch: body.branch,
        rootDirectory: body.rootDirectory,
        rootPath,
        installCommand: body.installCommand ?? null,
        buildCommand: body.buildCommand ?? null,
        startCommand: body.startCommand ?? null,
        outputDirectory: body.outputDirectory ?? null,
        publicDirectory: body.publicDirectory ?? null,
        dbType: body.dbType ?? null,
        dbName: body.dbName ?? null,
        dbUser: body.dbUser ?? null,
        processManager: defaultProcessManagerByFramework[body.framework],
        port: body.port ?? await nextDeploymentPort(),
        autoDeployEnabled: body.autoDeployEnabled,
        status: "STOPPED",
        env: {
          create: Object.entries(body.envVars).map(([key, value], index) => ({ key: key.toUpperCase(), value, isSecret: false, createdAt: new Date(Date.now() + index) }))
        }
      }
    });
    await syncAccountPrimaryBinding(deployment.id, account.id, body.domainId ?? null);
    if (body.autoDeployEnabled && body.sourceProvider === "GITHUB") {
      const webhook = await ensureAccountGithubWebhook(account.id, deployment);
      if (!webhook.configured) {
        await prisma.deployment.update({ where: { id: deployment.id }, data: { autoDeployEnabled: false } });
        await prisma.deploymentLog.create({
          data: {
            deploymentId: deployment.id,
            step: "QUEUED",
            message: "Auto deploy disabled because GitHub webhook could not be configured",
            metadata: webhook as Prisma.InputJsonObject
          }
        });
      } else {
        await prisma.deploymentLog.create({
          data: {
            deploymentId: deployment.id,
            step: "QUEUED",
            message: webhook.manualSetupRequired ? "Auto deploy enabled; manual GitHub webhook setup required" : "Auto deploy GitHub webhook configured",
            metadata: webhook as Prisma.InputJsonObject
          }
        });
      }
    }
    await audit(request, { action: "CREATE", resource: "deployment", resourceId: deployment.id, description: `Account created deployment ${deployment.slug}` });
    const created = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id }, include: includeAccountDeployment() });
    return reply.code(201).send(serializeAccountDeployment(created));
  });

  app.patch("/deployments/:deploymentId", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = deploymentUpdateSchema.parse(request.body);
    const existing = await findAccountDeployment(request, deploymentId);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const bindingTarget = body.domainId ? await resolveAccountBindingTarget(account.id, body.domainId) : null;
    const rootPath = body.rootPath === undefined ? undefined : accountDeploymentRootPath(account, body.rootPath, body.slug ?? existing.slug);
    if (rootPath) await fs.mkdir(rootPath, { recursive: true });
    const { envVars: _envVars, domainId: _domainId, rootPath: _rootPath, autoDeployEnabled: _autoDeployEnabled, ...data } = body;
    if (body.autoDeployEnabled === true) {
      const webhookTarget = {
        id: existing.id,
        slug: body.slug ?? existing.slug,
        githubOwner: body.githubOwner ?? existing.githubOwner,
        githubRepo: body.githubRepo ?? existing.githubRepo,
        webhookSecretHash: existing.webhookSecretHash
      };
      if ((body.sourceProvider ?? existing.sourceProvider) !== "GITHUB" || !webhookTarget.githubOwner || !webhookTarget.githubRepo) {
        throw app.httpErrors.badRequest("Auto deploy requires a GitHub source with owner and repository configured.");
      }
      const webhook = await ensureAccountGithubWebhook(account.id, webhookTarget);
      if (!webhook.configured) {
        throw app.httpErrors.badRequest(`Auto deploy could not be enabled: ${webhook.reason ?? "GitHub webhook could not be configured"}`);
      }
      await prisma.deploymentLog.create({
        data: {
          deploymentId: existing.id,
          step: "QUEUED",
          message: webhook.manualSetupRequired ? "Auto deploy enabled; manual GitHub webhook setup required" : "Auto deploy GitHub webhook configured",
          metadata: webhook as Prisma.InputJsonObject
        }
      });
    }
    const deployment = await prisma.deployment.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(body.autoDeployEnabled !== undefined ? { autoDeployEnabled: body.autoDeployEnabled } : {}),
        ...(rootPath !== undefined ? { rootPath } : {}),
        ...(body.domainId !== undefined ? { domainId: bindingTarget?.domainId ?? null } : {}),
        gitUrl: body.gitUrl ?? undefined,
        repoUrl: (body as any).repoUrl ?? undefined,
        processManager: body.framework ? defaultProcessManagerByFramework[body.framework] : undefined
      },
      include: includeAccountDeployment()
    });
    if (body.domainId !== undefined) {
      await syncAccountPrimaryBinding(deployment.id, account.id, body.domainId);
    }
    if (body.envVars !== undefined) {
      const importedAt = Date.now();
      for (const [index, [key, value]] of Object.entries(body.envVars).entries()) {
        await prisma.deploymentEnvVar.upsert({
          where: { deploymentId_key: { deploymentId: deployment.id, key: key.toUpperCase() } },
          update: { value, isSecret: false, createdAt: new Date(importedAt + index) },
          create: { deploymentId: deployment.id, key: key.toUpperCase(), value, isSecret: false, createdAt: new Date(importedAt + index) }
        });
      }
    }
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Account updated deployment ${deployment.slug}` });
    const updated = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id }, include: includeAccountDeployment() });
    return serializeAccountDeployment(updated);
  });

  app.get("/deployments/:deploymentId/releases", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    return prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "desc" }, take: 50 });
  });

  app.get("/deployments/:deploymentId/metrics", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    await pruneAccountDeploymentLogs(deployment.id);
    const appPath = accountDeploymentAppPath(deployment);
    const [metrics, buildLogs] = await Promise.all([
      sysagent.deploymentMetrics({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        port: deployment.port,
        processManager: deployment.processManager,
        logDir: accountDeploymentLogDir(deployment.slug),
        dbType: deployment.dbType,
        dbName: deployment.dbName,
        serverNames: accountDeploymentServerNames(deployment),
        logLines: 300
      }).catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        process: { cpuPercent: 0, memoryBytes: 0, processes: [], processCount: 0 },
        history: [],
        storage: { rootPath: appPath, bytes: 0 },
        database: { engine: deployment.dbType, name: deployment.dbName, sizeBytes: 0, available: false },
        traffic: { incomingBytes: 0, outgoingBytes: 0, bandwidthBytes: 0, requests: 0, sources: [], windowHours: 24 },
        logs: { ok: false, text: "", stdout: "", stderr: "", laravel: "" }
      })),
      prisma.deploymentLog.findMany({
        where: { deploymentId: deployment.id, createdAt: { gte: accountDeploymentLogCutoff() } },
        orderBy: { createdAt: "desc" },
        take: 300
      })
    ]);
    return { ...(metrics as Record<string, unknown>), buildLogs };
  });

  app.get("/deployments/:deploymentId/workers", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const processConfig = deployment.processConfig && typeof deployment.processConfig === "object" && !Array.isArray(deployment.processConfig)
      ? deployment.processConfig as Record<string, unknown>
      : {};
    const config = accountLaravelWorkersSchema.parse(processConfig.laravelWorkers ?? {});
    const status = deployment.framework === "LARAVEL"
      ? await sysagent.deploymentLaravelWorkers({
          name: `${deployment.slug}-queue`,
          rootPath: accountDeploymentAppPath(deployment),
          action: "status",
          desiredWorkers: config.enabled ? config.desiredWorkers : 0,
          queueCommand: config.queueCommand,
          logDir: accountDeploymentLogDir(deployment.slug)
        }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
      : null;
    return { config, status };
  });

  app.patch("/deployments/:deploymentId/workers", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ laravelWorkers: accountLaravelWorkersSchema }).parse(request.body ?? {});
    const deployment = await findAccountDeployment(request, deploymentId);
    if (deployment.framework !== "LARAVEL") throw app.httpErrors.badRequest("Laravel workers are only available for Laravel deployments.");
    const desiredWorkers = body.laravelWorkers.enabled ? body.laravelWorkers.desiredWorkers : 0;
    const result = await sysagent.deploymentLaravelWorkers({
      name: `${deployment.slug}-queue`,
      rootPath: accountDeploymentAppPath(deployment),
      action: desiredWorkers > 0 ? "apply" : "stop",
      desiredWorkers,
      queueCommand: body.laravelWorkers.queueCommand,
      env: Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string])),
      logDir: accountDeploymentLogDir(deployment.slug)
    });
    const processConfig = deployment.processConfig && typeof deployment.processConfig === "object" && !Array.isArray(deployment.processConfig)
      ? deployment.processConfig as Record<string, unknown>
      : {};
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { processConfig: { ...processConfig, laravelWorkers: { ...body.laravelWorkers, desiredWorkers } } as Prisma.InputJsonValue }
    });
    return reply.code(202).send({ config: { ...body.laravelWorkers, desiredWorkers }, result });
  });

  app.get("/deployments/:deploymentId/laravel-processes", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const processConfig = deployment.processConfig && typeof deployment.processConfig === "object" && !Array.isArray(deployment.processConfig)
      ? deployment.processConfig as Record<string, unknown>
      : {};
    const envVars = Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string]));
    return inferredLaravelManagedProcesses(envVars, processConfig.laravelManagedProcesses);
  });

  app.patch("/deployments/:deploymentId/laravel-processes", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ laravelManagedProcesses: laravelManagedProcessesSchema }).parse(request.body ?? {});
    const deployment = await findAccountDeployment(request, deploymentId);
    if (deployment.framework !== "LARAVEL") throw app.httpErrors.badRequest("Laravel managed processes are only available for Laravel deployments.");
    const envVars = Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string]));
    const config = inferredLaravelManagedProcesses(envVars, body.laravelManagedProcesses);
    const previousProcessConfig = deployment.processConfig && typeof deployment.processConfig === "object" && !Array.isArray(deployment.processConfig)
      ? deployment.processConfig as Record<string, unknown>
      : {};
    const previous = inferredLaravelManagedProcesses(envVars, previousProcessConfig.laravelManagedProcesses);
    const currentGroupIds = new Set(config.queueGroups.map((group) => group.id));
    const definitions = [
      { key: "scheduler", ...config.scheduler },
      { key: "horizon", ...config.horizon },
      { key: "reverb", ...config.reverb },
      ...config.queueGroups.map((group) => ({ key: `queue-${group.id}`, enabled: group.enabled, instances: group.desiredWorkers, command: queueGroupCommand(group) })),
      ...previous.queueGroups.filter((group) => !currentGroupIds.has(group.id)).map((group) => ({ key: `queue-${group.id}`, enabled: false, instances: 0, command: queueGroupCommand(group) }))
    ];
    const results: Record<string, unknown> = {};
    for (const definition of definitions) {
      results[definition.key] = await sysagent.deploymentLaravelWorkers({
        name: laravelManagedProgramName(deployment.slug, definition.key),
        rootPath: accountDeploymentAppPath(deployment),
        action: definition.enabled && definition.instances > 0 ? "apply" : "stop",
        desiredWorkers: definition.enabled ? definition.instances : 0,
        queueCommand: renderLaravelProcessCommand(definition.command, deployment.port),
        env: envVars,
        logDir: accountDeploymentLogDir(deployment.slug),
        logPrefix: definition.key
      });
    }
    const processConfig = deployment.processConfig && typeof deployment.processConfig === "object" && !Array.isArray(deployment.processConfig)
      ? deployment.processConfig as Record<string, unknown>
      : {};
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { processConfig: { ...processConfig, laravelManagedProcesses: config } as Prisma.InputJsonValue }
    });
    return reply.code(202).send({ config, results });
  });

  app.get("/deployments/:deploymentId/logs", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    return prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id },
      orderBy: { createdAt: "asc" },
      take: 200
    });
  });

  app.get("/deployments/:deploymentId/logs/export", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const query = z.object({
      type: z.enum(["build", "running"]).default("build"),
      limit: z.coerce.number().int().min(1).max(1000).default(500)
    }).parse(request.query);
    const deployment = await findAccountDeployment(request, deploymentId);

    if (query.type === "running") {
      const runtime = await sysagent.deploymentRuntimeLogs({
        name: deployment.slug,
        logDir: accountDeploymentLogDir(deployment.slug),
        rootPath: accountDeploymentAppPath(deployment),
        lines: query.limit
      });
      reply.type("text/plain");
      return [
        `Deployment: ${deployment.name} (${deployment.slug})`,
        "Log type: running",
        `Runtime log directory: ${runtime.logDir ?? accountDeploymentLogDir(deployment.slug)}`,
        `Status: ${deployment.status}`,
        `Exported: ${new Date().toISOString()}`,
        "",
        runtime.text || "No runtime logs yet."
      ].join("\n");
    }

    const logs = await prisma.deploymentLog.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" }, take: query.limit });
    reply.type("text/plain");
    return logs.map((log) => `[${log.createdAt.toISOString()}] ${log.step}: ${log.message}${logMetadataText(log.metadata)}`).join("\n") || "No logs yet.";
  });

  app.post("/deployments/:deploymentId/domains", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ domainId: z.string(), primary: z.boolean().default(false) }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const target = await resolveAccountBindingTarget(accountId(request), body.domainId);
    if (body.primary) await prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id }, data: { role: "alias" } });
    const binding = target.subdomainId
      ? await prisma.deploymentDomain.upsert({
          where: { deploymentId_subdomainId: { deploymentId: deployment.id, subdomainId: target.subdomainId } },
          update: { role: body.primary ? "primary" : "alias" },
          create: { deploymentId: deployment.id, subdomainId: target.subdomainId, role: body.primary ? "primary" : "alias" },
          include: { domain: true, subdomain: { include: { domain: true } } }
        })
      : await prisma.deploymentDomain.upsert({
          where: { deploymentId_domainId: { deploymentId: deployment.id, domainId: target.domainId ?? "" } },
          update: { role: body.primary ? "primary" : "alias" },
          create: { deploymentId: deployment.id, domainId: target.domainId, role: body.primary ? "primary" : "alias" },
          include: { domain: true, subdomain: { include: { domain: true } } }
        });
    if (target.domainId) await prisma.domain.update({ where: { id: target.domainId }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } });
    if (body.primary || !deployment.domainId) {
      await syncAccountPrimaryBinding(deployment.id, accountId(request), body.domainId);
    }
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Account bound domain ${target.displayName} to ${deployment.slug}` });
    return reply.code(201).send(serializeAccountDeploymentBinding(binding));
  });

  app.patch("/deployments/:deploymentId/domains/:domainId/primary", async (request: any) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    await resolveAccountBindingTarget(accountId(request), domainId);
    await syncAccountPrimaryBinding(deployment.id, accountId(request), domainId);
    return { ok: true };
  });

  app.delete("/deployments/:deploymentId/domains/:domainId", async (request: any) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const target = await resolveAccountBindingTarget(accountId(request), domainId);
    const deleted = target.subdomainId
      ? await prisma.deploymentDomain.deleteMany({ where: { deploymentId: deployment.id, subdomainId: target.subdomainId } })
      : await prisma.deploymentDomain.deleteMany({ where: { deploymentId: deployment.id, domainId: target.domainId } });
    if (deleted.count === 0) throw app.httpErrors.notFound("Domain binding not found");
    if (deployment.domainId === domainId || deployment.domainId === target.domainId) await prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: null } });
    return { ok: true };
  });

  app.get("/deployments/:deploymentId/env/:key/reveal", async (request: any) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const item = await prisma.deploymentEnvVar.findUniqueOrThrow({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    return { key: item.key, value: item.value ?? "", isSecret: item.isSecret };
  });

  app.put("/deployments/:deploymentId/env/:key", async (request: any) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const body = envVarSchema.omit({ key: true }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    return prisma.deploymentEnvVar.upsert({
      where: { deploymentId_key: { deploymentId: deployment.id, key } },
      update: { value: body.value ?? "", isSecret: body.isSecret, secretRef: body.secretRef ?? null },
      create: { deploymentId: deployment.id, key, value: body.value ?? "", isSecret: body.isSecret, secretRef: body.secretRef ?? null }
    });
  });

  app.post("/deployments/:deploymentId/env/bulk", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ env: z.array(envVarSchema).max(200) }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const items = [];
    const importedAt = Date.now();
    for (const [index, item] of body.env.entries()) {
      items.push(await prisma.deploymentEnvVar.upsert({
        where: { deploymentId_key: { deploymentId: deployment.id, key: item.key } },
        update: { value: item.value ?? "", isSecret: item.isSecret, secretRef: item.secretRef ?? null, createdAt: new Date(importedAt + index) },
        create: { deploymentId: deployment.id, key: item.key, value: item.value ?? "", isSecret: item.isSecret, secretRef: item.secretRef ?? null, createdAt: new Date(importedAt + index) }
      }));
    }
    return { ok: true, items };
  });

  app.delete("/deployments/:deploymentId/env/:key", async (request: any) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    return { ok: true };
  });

  app.post("/deployments/:deploymentId/env/bulk-delete", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const removed: string[] = [];
    for (const key of [...new Set(body.keys.map((item) => item.trim().toUpperCase()).filter(Boolean))]) {
      await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } }).then(() => removed.push(key)).catch(() => undefined);
    }
    return { ok: true, removed };
  });

  app.post("/deployments/:deploymentId/env/clear-database-overrides", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    const keys = ["DB_PASSWORD", "DATABASE_URL"];
    const removed: string[] = [];
    for (const key of keys) {
      await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } }).then(() => removed.push(key)).catch(() => undefined);
    }
    return { ok: true, removed };
  });

  app.post("/deployments/:deploymentId/rollback", async (request: any, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ releaseId: z.string() }).parse(request.body);
    const deployment = await findAccountDeployment(request, deploymentId);
    const release = await prisma.deploymentRelease.findFirstOrThrow({ where: { id: body.releaseId, deploymentId: deployment.id } });
    const queue = await deployQueue.add("rollback", { deploymentId: deployment.id, releaseId: release.id });
    return reply.code(202).send({ queue: { queued: true, jobId: queue.id }, release });
  });

  app.post("/deployments/:deploymentId/doctor/repair", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    await prisma.deploymentLog.create({ data: { deploymentId: deployment.id, step: "HEALTH_CHECK", message: "Account Guardian repair requested." } });
    return { ok: true, status: "queued", summary: "Guardian repair requested for this account deployment." };
  });

  app.get("/deployments/:deploymentId/runtime-review", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findAccountDeployment(request, deploymentId);
    return deploymentRuntimeReview(deployment);
  });

  app.delete("/deployments/:deploymentId", async (request: any) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ confirmSlug: z.string() }).parse(request.body ?? {});
    const deployment = await findAccountDeployment(request, deploymentId);
    if (body.confirmSlug !== deployment.slug) throw app.httpErrors.badRequest("Deployment deletion requires exact slug confirmation");
    await prisma.deployment.delete({ where: { id: deployment.id } });
    await audit(request, { action: "DELETE", resource: "deployment", resourceId: deployment.id, description: `Account deleted deployment ${deployment.slug}` });
    return { ok: true };
  });

  app.post("/deployments/:deploymentId/:action", async (request: any, reply) => {
    const params = z.object({
      deploymentId: z.string(),
      action: z.enum(["deploy", "redeploy", "start", "stop", "restart"])
    }).parse(request.params);
    const body = runtimeInstallSelectionSchema.parse(request.body ?? {});
    const deployment = await findAccountDeployment(request, params.deploymentId);
    if (["deploy", "redeploy", "start", "restart"].includes(params.action)) {
      const runtime = await prepareDeploymentRuntimeTools(deployment, body.approvedRuntimeTools);
      if (!runtime.ready) {
        return reply.code(409).send({ error: `Required server runtime tools need approval before ${params.action}.`, runtimeReview: runtime.review, install: runtime.install });
      }
      if (runtime.install) {
        await prisma.deploymentLog.create({
          data: {
            deploymentId: deployment.id,
            step: "PREFLIGHT",
            message: "Approved runtime tools installed before deployment",
            metadata: runtime.install as unknown as Prisma.InputJsonObject
          }
        });
      }
    }
    const release = ["deploy", "redeploy"].includes(params.action)
      ? await prisma.deploymentRelease.create({
          data: {
            deploymentId: deployment.id,
            status: "QUEUED",
            commitSha: null,
            sourcePath: deployment.rootPath,
            envSnapshot: deployment.envVars === null ? {} : deployment.envVars as Prisma.InputJsonValue,
            processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
          }
        })
      : null;
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: params.action === "stop" ? "STOPPED" : "QUEUED",
        healthStatus: params.action === "stop" ? "DOWN" : "UNKNOWN"
      }
    });
    const queue = await deployQueue.add(params.action, { deploymentId: deployment.id, releaseId: release?.id });
    await audit(request, { action: params.action === "stop" ? "STOP" : params.action === "restart" ? "RESTART" : "DEPLOY", resource: "deployment", resourceId: deployment.id, description: `Account queued ${params.action} for ${deployment.slug}` });
    return reply.code(202).send({ queue: { queued: true, jobId: queue.id }, release });
  });

  app.get("/databases", async (request: any) => {
    const databases = await prisma.accountDatabase.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" } });
    let systemOverview: DatabaseOverview | null = null;
    try {
      systemOverview = await sysagent.databaseOverview() as DatabaseOverview;
    } catch {
      systemOverview = null;
    }
    const engines = (["POSTGRESQL", "MYSQL"] as const).map((engine) => {
      const items = databases.filter((database) => database.engine === engine);
      const systemEngine = systemOverview?.engines?.find((item) => item.engine === engine);
      const statsByName = new Map((systemEngine?.databases ?? []).map((database) => [database.name, database]));
      const usersByName = new Map((systemEngine?.users ?? []).map((user) => [user.name, user]));
      return {
        engine,
        installed: systemEngine?.installed ?? true,
        databases: items.map((database) => {
          const stats = statsByName.get(database.database);
          return {
            name: database.database,
            owner: stats?.owner ?? database.username,
            tableCount: stats?.tableCount ?? 0,
            rowCount: stats?.rowCount ?? 0,
            sizeBytes: stats?.sizeBytes ?? 0
          };
        }),
        users: items.map((database) => {
          const user = usersByName.get(database.username);
          return { name: database.username, host: user?.host ?? null };
        }),
        checks: systemEngine?.checks ?? {}
      };
    });
    return { engines };
  });

  app.post("/databases", async (request: any, reply) => {
    const body = databaseSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true, databases: true } } }
    });
    assertLimit(account._count.databases, account.databaseLimit, "Database");
    const prefix = `${cleanDatabaseIdentifier(account.username)}_`.slice(0, 24);
    const provision = {
      ...body,
      database: accountDatabaseIdentifier(prefix, body.database),
      username: accountDatabaseIdentifier(prefix, body.username)
    };
    const result = await sysagent.provisionDatabase(provision);
    assertDatabaseResult((result as { result?: unknown }).result, "Database create");
    const accountDatabase = await prisma.accountDatabase.create({
      data: {
        accountId: account.id,
        engine: provision.engine,
        database: provision.database,
        username: provision.username
      }
    });
    await audit(request, { action: "CREATE", resource: "database", resourceId: accountDatabase.id, description: `Account created ${provision.engine} database ${provision.database}`, metadata: { result } as any });
    return reply.code(201).send({ engine: provision.engine, database: accountDatabase.database, username: accountDatabase.username, password: (result as { password?: string }).password, result });
  });

  app.post("/databases/password", async (request: any) => {
    const body = databasePasswordSchema.parse(request.body);
    const accountDatabase = await assertAccountDatabaseUser(request, body.engine, body.username);
    const result = await sysagent.databasePassword(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database password change");
    await audit(request, { action: "UPDATE", resource: "database-user", resourceId: accountDatabase.id, description: `Account changed DB password for ${body.username}`, metadata: { result } as any });
    return { engine: body.engine, username: body.username, password: (result as { password?: string }).password ?? body.password, result };
  });

  app.post("/databases/grant", async (request: any) => {
    const body = databaseGrantSchema.parse(request.body);
    const accountDatabase = await findAccountDatabase(request, body.engine, body.database);
    await assertAccountDatabaseUser(request, body.engine, body.username);
    const result = await sysagent.databaseGrant(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database grant");
    await audit(request, { action: "UPDATE", resource: "database", resourceId: accountDatabase.id, description: `Account granted ${body.username} access to ${body.database}`, metadata: { result } as any });
    return result;
  });

  app.delete("/databases", async (request: any) => {
    const body = databaseTargetSchema.parse(request.body);
    const accountDatabase = await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseDelete(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database delete");
    await prisma.accountDatabase.delete({ where: { id: accountDatabase.id } });
    await audit(request, { action: "DELETE", resource: "database", resourceId: accountDatabase.id, description: `Account deleted database ${accountDatabase.database}`, metadata: { result } as any });
    return result;
  });

  app.post("/databases/export", async (request: any) => {
    const body = databaseTargetSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseExport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database export");
    await audit(request, { action: "APPLY", resource: "database", resourceId: body.database, description: `Account exported ${body.engine} database ${body.database}` });
    return { engine: result.engine, database: result.database, dump: result.dump };
  });

  app.post("/databases/import", async (request: any) => {
    const body = databaseImportSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseImport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database import");
    await audit(request, { action: "APPLY", resource: "database", resourceId: body.database, description: `Account imported SQL into ${body.engine} database ${body.database}` });
    return result;
  });

  app.post("/databases/import/upload", { bodyLimit: maxImportUploadBytes }, async (request: any) => {
    const query = databaseUploadQuerySchema.parse(request.query);
    await findAccountDatabase(request, query.engine, query.database);
    const upload = request.body as { tmpDir: string; filePath: string; sizeBytes: number };
    try {
      const result = await sysagent.databaseImportFile({ engine: query.engine, database: query.database, path: upload.filePath });
      assertDatabaseResult((result as { result?: unknown }).result, "Database import");
      await audit(request, {
        action: "APPLY",
        resource: "database",
        resourceId: query.database,
        description: `Account imported uploaded SQL into ${query.engine} database ${query.database}`,
        metadata: { sizeBytes: upload.sizeBytes, filename: query.filename ?? path.basename(upload.filePath) }
      });
      return Object.assign({}, result as Record<string, unknown>, {
        sizeBytes: upload.sizeBytes,
        filename: query.filename ?? path.basename(upload.filePath)
      });
    } finally {
      await fs.rm(upload.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.post("/databases/tables", async (request: any) => {
    const body = databaseTargetSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseTables(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table list");
    return result;
  });

  app.post("/databases/columns", async (request: any) => {
    const body = databaseTableSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseColumns(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Column list");
    return result;
  });

  app.post("/databases/rows", async (request: any) => {
    const body = databaseRowsSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseRows(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row preview");
    return result;
  });

  app.post("/databases/table/export", async (request: any) => {
    const body = databaseTableSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseTableExport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table export");
    await audit(request, { action: "APPLY", resource: "database-table", resourceId: `${body.database}.${body.table}`, description: `Account exported ${body.engine} table ${body.database}.${body.table}` });
    return { engine: result.engine, database: result.database, table: result.table, dump: result.dump };
  });

  app.post("/databases/table/export-csv", async (request: any) => {
    const body = databaseTableSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseTableExportCsv(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table CSV export");
    await audit(request, { action: "APPLY", resource: "database-table", resourceId: `${body.database}.${body.table}`, description: `Account exported ${body.engine} table ${body.database}.${body.table} as ${result.format}` });
    return { engine: result.engine, database: result.database, table: result.table, format: result.format, content: result.content };
  });

  app.post("/databases/table/import", async (request: any) => {
    const body = databaseTableImportSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseTableImport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table import");
    await audit(request, { action: "APPLY", resource: "database-table", resourceId: `${body.database}.${body.table}`, description: `Account imported ${body.format} into ${body.engine} table ${body.database}.${body.table}` });
    return result;
  });

  app.post("/databases/row", async (request: any) => {
    const body = databaseRowCreateSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseRowCreate(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row create");
    await audit(request, { action: "CREATE", resource: "database-row", resourceId: `${body.database}.${body.table}`, description: `Account inserted row into ${body.engine} table ${body.database}.${body.table}` });
    return result;
  });

  app.patch("/databases/row", async (request: any) => {
    const body = databaseRowUpdateSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseRowUpdate(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row update");
    await audit(request, { action: "UPDATE", resource: "database-row", resourceId: `${body.database}.${body.table}`, description: `Account updated row in ${body.engine} table ${body.database}.${body.table}` });
    return result;
  });

  app.delete("/databases/row", async (request: any) => {
    const body = databaseRowTargetSchema.parse(request.body);
    await findAccountDatabase(request, body.engine, body.database);
    const result = await sysagent.databaseRowDelete(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row delete");
    await audit(request, { action: "DELETE", resource: "database-row", resourceId: `${body.database}.${body.table}`, description: `Account deleted row from ${body.engine} table ${body.database}.${body.table}` });
    return result;
  });

  app.post("/databases/:databaseId/password", async (request: any) => {
    const { databaseId } = z.object({ databaseId: z.string() }).parse(request.params);
    const body = z.object({ password: z.string().min(12).max(500) }).parse(request.body);
    const accountDatabase = await prisma.accountDatabase.findFirstOrThrow({ where: { id: databaseId, accountId: accountId(request) } });
    const result = await sysagent.databasePassword({ engine: accountDatabase.engine, username: accountDatabase.username, password: body.password });
    await audit(request, { action: "UPDATE", resource: "database-user", resourceId: accountDatabase.id, description: `Account changed DB password for ${accountDatabase.username}`, metadata: { result } as any });
    return { ok: true, result };
  });

  app.delete("/databases/:databaseId", async (request: any) => {
    const { databaseId } = z.object({ databaseId: z.string() }).parse(request.params);
    const accountDatabase = await prisma.accountDatabase.findFirstOrThrow({ where: { id: databaseId, accountId: accountId(request) } });
    const result = await sysagent.databaseDelete({ engine: accountDatabase.engine, database: accountDatabase.database });
    await prisma.accountDatabase.delete({ where: { id: accountDatabase.id } });
    await audit(request, { action: "DELETE", resource: "database", resourceId: accountDatabase.id, description: `Account deleted database ${accountDatabase.database}`, metadata: { result } as any });
    return { ok: true, result };
  });

  app.get("/mail", async (request: any) =>
    prisma.mailAccount.findMany({ where: { accountId: accountId(request) }, orderBy: { createdAt: "desc" }, include: { domain: true } })
  );

  app.post("/mail", async (request: any, reply) => {
    const body = mailboxSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: accountId(request) },
      include: { _count: { select: { domains: true, deployments: true, mailAccounts: true } } }
    });
    assertLimit(account._count.mailAccounts, account.mailboxLimit, "Mailbox");
    const domain = await prisma.domain.findFirstOrThrow({ where: { id: body.domainId, accountId: account.id } });
    const mailbox = await prisma.mailAccount.create({
      data: {
        accountId: account.id,
        domainId: domain.id,
        username: body.username,
        passwordHash: await bcrypt.hash(body.password, 12),
        quotaMb: body.quotaMb
      }
    });
    await audit(request, { action: "CREATE", resource: "mail_account", resourceId: mailbox.id, description: `Account created mailbox ${mailbox.username}@${domain.name}` });
    return reply.code(201).send({ ...mailbox, domain });
  });

  app.patch("/mail/:mailboxId", async (request: any) => {
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const body = mailboxUpdateSchema.parse(request.body);
    const data = {
      quotaMb: body.quotaMb,
      enabled: body.enabled,
      ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 12) } : {})
    };
    const mailbox = await prisma.mailAccount.updateMany({
      where: { id: mailboxId, accountId: accountId(request) },
      data
    });
    if (mailbox.count === 0) throw app.httpErrors.notFound("Mailbox not found");
    await audit(request, { action: "UPDATE", resource: "mail_account", resourceId: mailboxId, description: "Account updated mailbox" });
    return { ok: true };
  });

  app.delete("/mail/:mailboxId", async (request: any) => {
    const { mailboxId } = z.object({ mailboxId: z.string() }).parse(request.params);
    const mailbox = await prisma.mailAccount.findFirst({ where: { id: mailboxId, accountId: accountId(request) } });
    if (!mailbox) throw app.httpErrors.notFound("Mailbox not found");
    await prisma.mailAccount.delete({ where: { id: mailbox.id } });
    await audit(request, { action: "DELETE", resource: "mail_account", resourceId: mailbox.id, description: "Account deleted mailbox" });
    return { ok: true };
  });

  app.get("/files/overview", async (request: any) => {
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    await fs.mkdir(account.homeRoot, { recursive: true });
    return { root: account.homeRoot, platform: os.platform(), pathSeparator: path.sep, textReadLimit: 1024 * 1024, uploadLimit: configuredFileUploadLimitBytes, uploadChunkLimit: fileUploadChunkBytes, writable: true };
  });

  app.get("/files/list", async (request: any) => {
    const query = listFileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved, relative } = safeAccountPath(account, query.path);
    await fs.mkdir(resolved, { recursive: true });
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) throw app.httpErrors.badRequest("Path is not a directory");
    const names = await fs.readdir(resolved);
    let items = await Promise.all(names.map((name) => fileEntry(account, path.join(resolved, name))));
    if (query.search) items = items.filter((item) => item.name.toLowerCase().includes(query.search.toLowerCase()));
    items = sortFileEntries(items, query.sort, query.direction);
    const start = (query.page - 1) * query.pageSize;
    return {
      current: await fileEntry(account, resolved),
      breadcrumbs: breadcrumbsFor(relative),
      root: account.homeRoot,
      items: items.slice(start, start + query.pageSize),
      total: items.length,
      page: query.page,
      pageSize: query.pageSize
    };
  });

  app.get("/files/tree", async (request: any) => {
    const query = z.object({ path: z.string().default("."), depth: z.coerce.number().int().min(0).max(5).default(2) }).parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    return { root: await fileEntry(account, resolved), children: await buildFileTree(account, resolved, query.depth, { count: 0 }) };
  });

  app.get("/files/read", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    if (stats.size > 1024 * 1024) throw app.httpErrors.payloadTooLarge("File is too large for account editor");
    return { file: await fileEntry(account, resolved), content: await fs.readFile(resolved, "utf8") };
  });

  app.put("/files/write", async (request: any) => {
    const body = fileWriteSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, body.path);
    await fs.writeFile(resolved, body.content, "utf8");
    await audit(request, { action: "UPDATE", resource: "account_file", resourceId: account.id, description: `Account updated ${body.path}` });
    return { ok: true, file: await fileEntry(account, resolved) };
  });

  app.post("/files/files", async (request: any, reply) => {
    const body = fileCreateSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeChildPath(account, body.parentPath, body.name);
    await fs.writeFile(resolved, body.content, { encoding: "utf8", flag: "wx" });
    await audit(request, { action: "CREATE", resource: "account_file", resourceId: account.id, description: `Account created ${body.name}` });
    return reply.code(201).send(await fileEntry(account, resolved));
  });

  app.post("/files/folders", async (request: any, reply) => {
    const body = folderCreateSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeChildPath(account, body.parentPath, body.name);
    await fs.mkdir(resolved);
    await audit(request, { action: "CREATE", resource: "account_file", resourceId: account.id, description: `Account created folder ${body.name}` });
    return reply.code(201).send(await fileEntry(account, resolved));
  });

  app.post("/files/domain-scaffold", async (request: any, reply) => {
    const body = z.object({ domain: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    await prisma.domain.findFirstOrThrow({ where: { accountId: account.id, name: body.domain } });
    const root = safeAccountPath(account, path.posix.join(body.domain, "public_html"));
    await fs.mkdir(root.resolved, { recursive: true });
    return reply.code(201).send({ root: await fileEntry(account, root.resolved), scaffold: { domain: body.domain, relativeRoot: root.relative, folders: [root.relative] } });
  });

  app.post("/files/subdomain-scaffold", async (request: any, reply) => {
    const body = z.object({ domain: z.string(), subdomain: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const domain = await prisma.domain.findFirstOrThrow({ where: { accountId: account.id, name: body.domain } });
    await prisma.subdomain.findFirstOrThrow({ where: { domainId: domain.id, name: body.subdomain } });
    const root = safeAccountPath(account, path.posix.join(body.domain, "subdomains", body.subdomain, "public_html"));
    await fs.mkdir(root.resolved, { recursive: true });
    return reply.code(201).send({ root: await fileEntry(account, root.resolved), scaffold: { domain: body.domain, subdomain: body.subdomain, relativeRoot: root.relative, folders: [root.relative] } });
  });

  app.patch("/files/rename", async (request: any) => {
    const body = fileRenameSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const source = safeAccountPath(account, body.path);
    const target = safeChildPath(account, parentPath(source.relative), body.name);
    await fs.rename(source.resolved, target.resolved);
    return { ok: true, file: await fileEntry(account, target.resolved) };
  });

  app.post("/files/copy", async (request: any) => {
    const body = fileCopyMoveSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const source = safeAccountPath(account, body.sourcePath);
    const targetParent = safeAccountPath(account, body.targetParentPath);
    const target = safeChildPath(account, targetParent.relative, body.name ?? path.basename(source.resolved));
    if (!body.overwrite) {
      await fs.access(target.resolved).then(() => { throw app.httpErrors.conflict("Target already exists"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    await fs.cp(source.resolved, target.resolved, { recursive: true, force: body.overwrite, errorOnExist: !body.overwrite });
    return { ok: true, file: await fileEntry(account, target.resolved) };
  });

  app.post("/files/move", async (request: any) => {
    const body = fileCopyMoveSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const source = safeAccountPath(account, body.sourcePath);
    const targetParent = safeAccountPath(account, body.targetParentPath);
    const target = safeChildPath(account, targetParent.relative, body.name ?? path.basename(source.resolved));
    if (!body.overwrite) {
      await fs.access(target.resolved).then(() => { throw app.httpErrors.conflict("Target already exists"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    await fs.rename(source.resolved, target.resolved);
    return { ok: true, file: await fileEntry(account, target.resolved) };
  });

  app.delete("/files/delete", async (request: any) => {
    const body = fileDeleteSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const paths = body.paths ?? (body.path ? [body.path] : []);
    const movedToTrash: string[] = [];
    const permanentlyRemoved: string[] = [];
    const trashRoot = safeAccountPath(account, ".trash");
    for (const itemPath of paths) {
      const { resolved, relative } = safeAccountPath(account, itemPath);
      if (relative === "." || relative === ".trash") throw app.httpErrors.badRequest("Account root cannot be deleted");
      if (body.permanent || relative.startsWith(".trash/")) {
        await fs.rm(resolved, { recursive: true, force: true });
        permanentlyRemoved.push(itemPath);
      } else {
        await fs.mkdir(trashRoot.resolved, { recursive: true });
        const trashTarget = safeAccountPath(account, path.posix.join(".trash", `${Date.now()}-${randomUUID().slice(0, 8)}-${path.basename(resolved)}`));
        await fs.rename(resolved, trashTarget.resolved);
        movedToTrash.push(itemPath);
      }
    }
    await audit(request, { action: "DELETE", resource: "account_file", resourceId: account.id, description: `Account processed ${paths.length} delete request(s)` });
    return { ok: true, movedToTrash, permanentlyRemoved };
  });

  app.get("/files/download", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    return { file: await fileEntry(account, resolved), contentBase64: (await fs.readFile(resolved)).toString("base64") };
  });

  app.get("/files/checksum", async (request: any) => {
    const query = fileQuerySchema.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, query.path);
    const stats = await fs.stat(resolved);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    return { hash: createHash("sha256").update(await fs.readFile(resolved)).digest("hex") };
  });

  app.post("/files/chmod", async (request: any) => {
    const body = chmodSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved } = safeAccountPath(account, body.path);
    await fs.chmod(resolved, Number.parseInt(body.mode, 8));
    return { ok: true, file: await fileEntry(account, resolved) };
  });

  app.post("/files/git/status", async (request: any) => {
    const body = z.object({ path: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { resolved, relative } = safeAccountPath(account, body.path);
    const gitDir = path.join(resolved, ".git");
    const isRepo = await fs.stat(gitDir).then((stats) => stats.isDirectory()).catch(() => false);
    return { ok: true, path: relative, isRepo };
  });

  app.post("/files/git/pull", async (request: any) => {
    const body = z.object({ path: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { relative } = safeAccountPath(account, body.path);
    return { ok: true, path: relative, stdout: "Git pull is disabled in account file manager.", stderr: "", returncode: 0 };
  });

  app.post("/files/git/github/pull", async (request: any) => {
    const body = z.object({ owner: z.string(), repo: z.string(), branch: z.string().default("main"), targetParentPath: z.string() }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const { relative } = safeAccountPath(account, body.targetParentPath);
    return { ok: true, path: relative, owner: body.owner, repo: body.repo, branch: body.branch };
  });

  app.post("/files/archive/create", async (request: any) => {
    const body = archiveCreateSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    for (const sourcePath of body.sourcePaths) safeAccountPath(account, sourcePath);
    const archive = safeAccountPath(account, body.archivePath);
    await fs.writeFile(archive.resolved, "");
    return { ok: true, file: await fileEntry(account, archive.resolved) };
  });

  app.post("/files/archive/extract", async (request: any) => {
    const body = archiveExtractSchema.parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    safeAccountPath(account, body.archivePath);
    const target = safeAccountPath(account, body.targetPath);
    await fs.mkdir(target.resolved, { recursive: true });
    return { ok: true, targetPath: target.relative, overwrite: body.overwrite };
  });

  app.post("/files/upload", { config: { rateLimit: false }, bodyLimit: fileUploadBodyLimitBytes }, async (request: any, reply) => {
    const query = z.object({
      parentPath: z.string().default("."),
      name: z.string(),
      overwrite: z.coerce.boolean().default(false)
    }).parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const target = safeChildPath(account, query.parentPath, query.name);
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (contentLength > fileUploadLimitBytes) throw app.httpErrors.payloadTooLarge("Upload is too large");
    if (!query.overwrite) {
      await fs.access(target.resolved).then(() => {
        throw app.httpErrors.conflict("Target already exists");
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await fs.mkdir(path.dirname(target.resolved), { recursive: true });
    const tempFile = path.join(path.dirname(target.resolved), `.upload-${process.pid}-${randomUUID()}.tmp`);
    let bytes = 0;
    try {
      await pipeline(
        request.body as Readable,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            bytes += chunk.byteLength;
            if (bytes > fileUploadLimitBytes) throw app.httpErrors.payloadTooLarge("Upload is too large");
            yield chunk;
          }
        },
        createWriteStream(tempFile, { flags: "wx" })
      );
      if (query.overwrite) {
        await fs.rename(tempFile, target.resolved);
      } else {
        await fs.link(tempFile, target.resolved);
        await fs.rm(tempFile, { force: true });
      }
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
    return reply.code(201).send({ ok: true, file: await fileEntry(account, target.resolved) });
  });

  app.post("/files/upload/chunk", { config: { rateLimit: false }, bodyLimit: fileUploadChunkBodyLimitBytes }, async (request: any, reply) => {
    const query = chunkUploadQuery.parse(request.query);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const target = safeChildPath(account, query.parentPath, query.name);
    if (query.index === 0 && !query.overwrite) {
      await fs.access(target.resolved).then(() => { throw app.httpErrors.conflict("Target already exists"); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    await fs.mkdir(path.dirname(target.resolved), { recursive: true });
    const result = await writeUploadChunk({
      body: request.body as Readable,
      parentDir: path.dirname(target.resolved),
      filePath: target.resolved,
      query,
      httpErrors: app.httpErrors,
      uploadLimit: fileUploadLimitBytes,
      uploadChunkLimit: fileUploadChunkBytes
    });
    const file = await fileEntry(account, target.resolved);
    if (!result.complete) {
      return reply.code(202).send({ ok: true, uploadId: result.uploadId, receivedBytes: result.receivedBytes, complete: false });
    }
    return reply.code(201).send({ ok: true, uploadId: result.uploadId, receivedBytes: result.receivedBytes, complete: true, file });
  });

  app.post("/password", async (request: any) => {
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(10).max(500)
    }).parse(request.body);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const ok = await bcrypt.compare(body.currentPassword, account.passwordHash);
    if (!ok) throw app.httpErrors.unauthorized("Current password is incorrect");
    await prisma.account.update({
      where: { id: account.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12) }
    });
    await audit(request, { action: "UPDATE", resource: "account", resourceId: account.id, description: "Account changed own password" });
    return { ok: true };
  });

  app.post("/api-token", async (request: any) => {
    const body = z.object({
      expiresInSeconds: z.coerce.number().int().min(3600).max(60 * 60 * 24 * 365).default(env.JWT_EXPIRY)
    }).parse(request.body ?? {});
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId(request) } });
    const token = app.jwt.sign(
      { sub: account.username, role: "account", accountId: account.id },
      { expiresIn: body.expiresInSeconds }
    );
    await audit(request, {
      action: "CREATE",
      resource: "account_api_token",
      resourceId: account.id,
      description: `Account generated API token for ${account.username}`
    });
    return {
      token,
      tokenType: "Bearer",
      expiresInSeconds: body.expiresInSeconds,
      apiBaseUrl: `http://${env.VPS_IP}:${env.PANEL_PORT}/api/v1`
    };
  });
};
