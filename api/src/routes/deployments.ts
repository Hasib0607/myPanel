import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { DeploymentFramework, DeploymentProcessManager, Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { deployQueue } from "../jobs/queues.js";
import { laravelPublicCwdMissing, nginxProxyMissingDomainFailure, nodePackageBinaryMissing, supervisorStartStillStarting } from "../lib/deploymentFailureRuntimeRepairs.js";
import { detectComposerPlatformIssue, detectFrontendModuleNotFound, formatFrontendModuleNotFoundMessage, isComposerPlatformCheckInconclusive, requiredRuntimeExecutables, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables } from "../lib/deploymentRuntimeTools.js";
import { deploymentRuntimeReview, prepareDeploymentRuntimeTools } from "../lib/deploymentRuntimeReview.js";
import { audit } from "../lib/audit.js";
import { githubApiErrorMessage, isGithubWebhookPermissionError } from "../lib/githubApiErrors.js";
import { deploymentHasLaravelPublicIndex, detectDeploymentFiles, detectDeploymentSource, findDeploymentAppRoot } from "../lib/deploymentDetection.js";
import {
  boundDomainFromBinding,
  buildDeploymentNginxRequest,
  deploymentFallbackRootPath,
  deploymentIsRoutable,
  publishDeploymentProxyNginx,
  publishPublicHtmlNginxVhost
} from "../lib/deploymentDomainSsl.js";
import { prisma } from "../lib/prisma.js";
import { deleteSecret, getSecret, putSecret } from "../lib/secrets.js";
import { sysagent } from "../lib/sysagent.js";
import {
  deploymentWorkerMax,
  inferredLaravelManagedProcesses,
  laravelManagedProcessesSchema,
  laravelManagedProgramName,
  queueGroupCommand,
  renderLaravelProcessCommand
} from "../lib/laravelProcesses.js";
import { deploymentPriorityDefaults, normalizeDeploymentResourcePolicy } from "../lib/deploymentResourcePolicy.js";

const frameworkSchema = z.enum(["LARAVEL", "NEXTJS", "NODEJS", "PYTHON", "GO", "STATIC"]);
const statusSchema = z.enum(["QUEUED", "RUNNING", "STOPPED", "DEPLOYING", "BUILDING", "FAILED"]);
const sourceProviderSchema = z.enum(["MANUAL", "GIT_URL", "GITHUB", "FILE_MANAGER", "UPLOAD"]);
const runtimeSchema = z.enum(["NODE", "PHP", "PYTHON", "GO", "STATIC"]).nullable().optional();
const packageManagerSchema = z.enum(["NPM", "PNPM", "YARN", "COMPOSER", "PIP", "UV", "GO", "NONE"]).nullable().optional();
const processManagerSchema = z.enum(["PM2", "SUPERVISOR", "SYSTEMD", "STATIC", "NONE"]).nullable().optional();
const deploymentPortSchema = z.number().int().min(1).max(65535);
const laravelWorkerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  autoscale: z.boolean().default(false),
  desiredWorkers: z.number().int().min(0).max(deploymentWorkerMax).default(0),
  minWorkers: z.number().int().min(0).max(deploymentWorkerMax).default(0),
  maxWorkers: z.number().int().min(1).max(deploymentWorkerMax).default(deploymentWorkerMax),
  queueCommand: z.string().trim().min(1).max(500).default("php artisan queue:work --sleep=3 --tries=3 --timeout=90"),
  currentWorkers: z.number().int().min(0).max(deploymentWorkerMax).optional(),
  lastScaledAt: z.string().datetime().optional(),
  lastScaleReason: z.string().max(500).optional()
}).transform((value) => ({
  ...value,
  maxWorkers: Math.min(deploymentWorkerMax, Math.max(value.maxWorkers, value.minWorkers, value.desiredWorkers)),
  desiredWorkers: value.enabled ? Math.max(value.minWorkers, Math.min(value.desiredWorkers, Math.max(value.maxWorkers, value.minWorkers))) : 0
}));
const resourcePolicySchema = z.object({
  priorityTier: z.enum(["P1", "P2", "P3"]).default("P2"),
  memoryMaxMb: z.number().int().min(256).max(16384).optional(),
  cpuQuotaPercent: z.number().int().min(25).max(1600).optional(),
  workersMax: z.number().int().min(0).max(16).optional(),
  restartDelayMs: z.number().int().min(500).max(60000).optional(),
  healthStrict: z.boolean().optional()
}).transform((value) => ({
  ...deploymentPriorityDefaults[value.priorityTier],
  ...value
}));
const processConfigSchema = z.object({
  resourcePolicy: resourcePolicySchema.optional(),
  laravelWorkers: laravelWorkerConfigSchema.optional(),
  laravelManagedProcesses: laravelManagedProcessesSchema.optional()
}).passthrough().default({});
const projectDomainApiTokenSchema = z.object({
  expiresInSeconds: z.coerce.number().int().min(3600).max(60 * 60 * 24 * 365).default(env.JWT_EXPIRY)
});

const baseDeploymentSchema = z.object({
  domainId: z.string().nullable().optional(),
  name: z.string().min(1),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+$/).optional(),
  framework: frameworkSchema,
  runtime: runtimeSchema,
  sourceProvider: sourceProviderSchema.default("MANUAL"),
  repoUrl: z.string().url().nullable().optional(),
  gitUrl: z.string().url().nullable().optional(),
  githubOwner: z.string().nullable().optional(),
  githubRepo: z.string().nullable().optional(),
  githubRepoId: z.string().nullable().optional(),
  githubVisibility: z.string().nullable().optional(),
  branch: z.string().default("main"),
  commitSha: z.string().nullable().optional(),
  rootDirectory: z.string().default("."),
  rootPath: z.string().min(1),
  packageManager: packageManagerSchema,
  installCommand: z.string().nullable().optional(),
  buildCommand: z.string().nullable().optional(),
  startCommand: z.string().nullable().optional(),
  outputDirectory: z.string().nullable().optional(),
  publicDirectory: z.string().nullable().optional(),
  runtimeVersion: z.string().nullable().optional(),
  processManager: processManagerSchema,
  processConfig: processConfigSchema.optional(),
  healthUrl: z.string().url().nullable().optional(),
  port: deploymentPortSchema,
  envVars: z.record(z.string()).default({}),
  dbType: z.enum(["POSTGRESQL", "MYSQL"]).nullable().optional(),
  dbName: z.string().nullable().optional(),
  dbUser: z.string().nullable().optional(),
  persistentPaths: z.array(z.string()).default([]),
  autoDeployEnabled: z.boolean().default(false)
});

const updateDeploymentSchema = baseDeploymentSchema.partial().extend({
  status: statusSchema.optional(),
  healthStatus: z.enum(["UNKNOWN", "HEALTHY", "DEGRADED", "DOWN"]).optional()
});

const envVarSchema = z.object({
  key: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/i),
  value: z.string().nullable().optional(),
  isSecret: z.boolean().default(false),
  secretRef: z.string().nullable().optional()
});

const githubConnectionSchema = z.object({
  username: z.string().trim().min(1).nullable().optional(),
  token: z.string().min(8).nullable().optional(),
  installationId: z.string().nullable().optional(),
  scopes: z.array(z.string()).default([])
});

const detectSchema = z.object({
  rootPath: z.string().optional(),
  files: z.array(z.string()).optional()
});
const doctorRepairSchema = z.object({
  action: z.enum(["auto", "sync-runtime", "health", "restart", "redeploy", "rollback", "set-node-memory", "sync-public-env", "rewrite-nginx", "request-approval"])
});
const approvalActionSchema = z.object({ approvalId: z.string().min(1) });
const runtimeInstallSelectionSchema = z.object({
  approvedRuntimeTools: z.array(z.string().min(1)).max(50).default([])
});

const preflightSchema = z.object({
  domainId: z.string().nullable().optional(),
  rootPath: z.string().min(1),
  port: deploymentPortSchema,
  dbType: z.enum(["POSTGRESQL", "MYSQL"]).nullable().optional(),
  gitUrl: z.string().url().nullable().optional()
});

const defaultProcessManagerByFramework: Record<DeploymentFramework, DeploymentProcessManager> = {
  LARAVEL: "SUPERVISOR",
  NEXTJS: "PM2",
  NODEJS: "PM2",
  PYTHON: "SUPERVISOR",
  GO: "SUPERVISOR",
  STATIC: "STATIC"
};

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function includeFullDeployment() {
  return {
    domain: true,
    domainBindings: { include: { domain: true, subdomain: { include: { domain: true } } }, orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }] },
    env: { orderBy: [{ createdAt: "asc" as const }, { key: "asc" as const }] },
    releases: { orderBy: { createdAt: "desc" as const }, take: 10 },
    logs: { orderBy: { createdAt: "desc" as const }, take: 100 }
  };
}

const subdomainSelectionPrefix = "subdomain:";

function subdomainSelectionId(subdomainId: string) {
  return `${subdomainSelectionPrefix}${subdomainId}`;
}

function isSubdomainSelectionId(value: string) {
  return value.startsWith(subdomainSelectionPrefix);
}

function subdomainFqdn(subdomain: { name: string; domain: { name: string } }) {
  return `${subdomain.name}.${subdomain.domain.name}`;
}

function serializeDomainBinding(binding: any) {
  if (binding.subdomain) {
    const id = subdomainSelectionId(binding.subdomain.id);
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

function serializeDeployment<T extends { domainBindings?: any[]; domainId?: string | null }>(deployment: T) {
  const domainBindings = deployment.domainBindings?.map(serializeDomainBinding);
  const primary = domainBindings?.find((binding) => binding.role === "primary") ?? domainBindings?.[0];
  return {
    ...deployment,
    domainId: primary?.domainId ?? deployment.domainId ?? null,
    domainBindings
  };
}

async function findDeployment(idOrSlug: string) {
  const deployment = await prisma.deployment.findFirstOrThrow({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: includeFullDeployment()
  });
  return serializeDeployment(deployment);
}

async function syncPrimaryDomainBinding(deploymentId: string, domainId: string | null | undefined) {
  if (!domainId) return;
  if (isSubdomainSelectionId(domainId)) {
    await syncPrimaryBindingTarget(deploymentId, domainId);
    return;
  }
  await prisma.$transaction([
    prisma.deploymentDomain.upsert({
      where: { deploymentId_domainId: { deploymentId, domainId } },
      update: { role: "primary" },
      create: { deploymentId, domainId, role: "primary" }
    }),
    prisma.deploymentDomain.updateMany({ where: { deploymentId, domainId: { not: domainId }, role: "primary" }, data: { role: "alias" } }),
    prisma.deploymentDomain.updateMany({ where: { deploymentId, subdomainId: { not: null }, role: "primary" }, data: { role: "alias" } }),
    prisma.domain.update({
      where: { id: domainId },
      data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deploymentId }
    })
  ]);
}

async function resolveBindingTarget(selectionId: string) {
  if (isSubdomainSelectionId(selectionId)) {
    const subdomainId = selectionId.slice(subdomainSelectionPrefix.length);
    const subdomain = await prisma.subdomain.findUniqueOrThrow({
      where: { id: subdomainId },
      include: { domain: true }
    });
    return {
      selectionId,
      domainId: null,
      subdomainId: subdomain.id,
      displayName: subdomainFqdn(subdomain)
    };
  }

  const domain = await prisma.domain.findUniqueOrThrow({ where: { id: selectionId } });
  return {
    selectionId,
    domainId: domain.id,
    subdomainId: null,
    displayName: domain.name
  };
}

async function findDeploymentBindingBySelection(deploymentId: string, selectionId: string) {
  const target = await resolveBindingTarget(selectionId);
  return prisma.deploymentDomain.findUniqueOrThrow({
    where: target.subdomainId
      ? { deploymentId_subdomainId: { deploymentId, subdomainId: target.subdomainId } }
      : { deploymentId_domainId: { deploymentId, domainId: target.domainId ?? "" } },
    include: { domain: true, subdomain: { include: { domain: true } } }
  });
}

function deploymentRouteRootPath(deployment: { rootPath: string; rootDirectory?: string | null }) {
  const cleanRootDirectory = (deployment.rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? path.join(deployment.rootPath, cleanRootDirectory) : deployment.rootPath;
}

async function publishDomainRouteForBinding(
  deployment: {
    id: string;
    status?: string | null;
    port: number;
    rootPath: string;
    rootDirectory?: string | null;
    framework: DeploymentFramework;
    startCommand?: string | null;
    publicDirectory?: string | null;
    outputDirectory?: string | null;
  },
  binding: { domain?: any; subdomain?: any }
) {
  const domain = boundDomainFromBinding(binding);
  if (!domain) return null;
  if (!deploymentIsRoutable(deployment)) {
    return publishPublicHtmlNginxVhost(domain);
  }
  return publishDeploymentProxyNginx({
    deploymentId: deployment.id,
    fqdn: deploymentServerName(domain) ?? domain.name,
    upstreamPort: deployment.port,
    rootPath: deploymentRouteRootPath(deployment),
    framework: deployment.framework,
    startCommand: deployment.startCommand,
    publicDirectory: deployment.publicDirectory,
    outputDirectory: deployment.outputDirectory,
    fallbackRootPath: deploymentFallbackRootPath(domain),
    forceHttps: domain.forceSsl
  });
}

async function reconcileSelectedDomainRoute(deploymentId: string, selectionId: string | null | undefined) {
  if (!selectionId) return null;
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  const binding = await findDeploymentBindingBySelection(deploymentId, selectionId);
  return publishDomainRouteForBinding(deployment, binding);
}

async function rewriteDeploymentDomainRoute(deployment: Awaited<ReturnType<typeof findDeployment>>) {
  const binding = deployment.domainBindings?.find((item) => item.role === "primary") ?? deployment.domainBindings?.[0] ?? null;
  if (binding) return publishDomainRouteForBinding(deployment, binding);
  if (deployment.domain) {
    return publishDomainRouteForBinding(deployment, { domain: deployment.domain });
  }
  return { skipped: true, reason: "No domain is linked to this deployment" };
}

function publicRouteNeedsProcessRestart(value: unknown) {
  const detail = commandDetail(value).toLowerCase();
  const httpCode = (value as { httpCode?: number })?.httpCode;
  return [502, 503, 504].includes(httpCode ?? 0)
    || detail.includes("http 502")
    || detail.includes("http 503")
    || detail.includes("http 504")
    || detail.includes("bad gateway")
    || detail.includes("connect() failed")
    || detail.includes("upstream");
}

async function syncPrimaryBindingTarget(deploymentId: string, selectionId: string | null | undefined) {
  if (!selectionId) return;
  const target = await resolveBindingTarget(selectionId);
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
    return;
  }

  await syncPrimaryDomainBinding(deploymentId, target.domainId);
}

async function detectFramework(input: z.infer<typeof detectSchema>) {
  if (input.rootPath) {
    try {
      return detectDeploymentSource(input.rootPath);
    } catch (error) {
      return {
        detected: "STATIC",
        confidence: 0.2,
        reason: error instanceof Error ? `Path is not readable locally: ${error.message}` : "Path is not readable locally",
        suggestions: detectDeploymentFiles([]).suggestions
      };
    }
  }
  return detectDeploymentFiles(input.files ?? []);
}

function deploymentPortRange() {
  const start = env.DEPLOYMENT_PORT_START;
  const end = env.DEPLOYMENT_PORT_END;
  if (start > end) {
    throw new Error("DEPLOYMENT_PORT_START must be lower than or equal to DEPLOYMENT_PORT_END");
  }
  return { start, end };
}

function reservedDeploymentPorts() {
  const ports = new Set<number>();
  const rawPorts = env.DEPLOYMENT_RESERVED_PORTS.split(",");
  for (const rawPort of rawPorts) {
    const port = Number(rawPort.trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }

  ports.add(env.PANEL_PORT);
  const loginPort = Number(env.PANEL_LOGIN_PORT ?? 8453);
  if (Number.isInteger(loginPort) && loginPort > 0 && loginPort <= 65535) ports.add(loginPort);
  const accountPort = Number(env.CPANEL_LOGIN_PORT ?? 3138);
  if (Number.isInteger(accountPort) && accountPort > 0 && accountPort <= 65535) ports.add(accountPort);
  return ports;
}

function deploymentPortPolicyError(port: number) {
  const { start, end } = deploymentPortRange();
  if (port < start || port > end) {
    return `Deployment port ${port} is outside the managed project range ${start}-${end}`;
  }
  if (reservedDeploymentPorts().has(port)) {
    return `Deployment port ${port} is reserved for panel or system services`;
  }
  return null;
}

async function assertDeploymentPortAvailable(port: number, existingDeploymentId?: string) {
  const policyError = deploymentPortPolicyError(port);
  if (policyError) {
    const error = new Error(policyError);
    Object.assign(error, { statusCode: 400 });
    throw error;
  }

  const owner = await prisma.deployment.findFirst({
    where: {
      port,
      ...(existingDeploymentId ? { id: { not: existingDeploymentId } } : {})
    },
    select: { name: true }
  });

  if (owner) {
    const error = new Error(`Deployment port ${port} is already used by ${owner.name}`);
    Object.assign(error, { statusCode: 409 });
    throw error;
  }
}

async function nextAvailablePort() {
  const deployments = await prisma.deployment.findMany({ select: { port: true }, orderBy: { port: "asc" } });
  const used = new Set(deployments.map((deployment) => deployment.port));
  const reserved = reservedDeploymentPorts();
  const { start, end } = deploymentPortRange();
  for (let port = start; port <= end; port += 1) {
    if (!used.has(port) && !reserved.has(port)) return port;
  }
  throw new Error(`No available deployment ports in ${start}-${end}`);
}

async function uniqueDeploymentSlug(base: string, existingDeploymentId?: string) {
  const normalized = slugify(base || "app") || "app";
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? normalized : `${normalized}-${index + 1}`;
    const existing = await prisma.deployment.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!existing || existing.id === existingDeploymentId) return candidate;
  }
  return `${normalized}-${Date.now()}`;
}

async function preflight(body: z.infer<typeof preflightSchema>, deploymentId?: string) {
  const checks = [];
  const rootExists = await fs.stat(body.rootPath).then((stats) => stats.isDirectory()).catch(() => false);
  checks.push({ key: "root_path", label: "Root directory", ok: rootExists, detail: rootExists ? "Directory exists" : "Directory not readable locally" });

  const portOwner = await prisma.deployment.findFirst({
    where: {
      port: body.port,
      ...(deploymentId ? { id: { not: deploymentId } } : {})
    },
    select: { id: true, name: true }
  });
  const policyError = deploymentPortPolicyError(body.port);
  checks.push({
    key: "port",
    label: "Port",
    ok: !policyError && !portOwner,
    detail: policyError ?? (portOwner ? `Port used by ${portOwner.name}` : `Port is available in managed range ${env.DEPLOYMENT_PORT_START}-${env.DEPLOYMENT_PORT_END}`)
  });

  const domain = body.domainId ? await prisma.domain.findUnique({ where: { id: body.domainId } }) : null;
  checks.push({ key: "domain", label: "Domain", ok: !body.domainId || Boolean(domain), detail: body.domainId ? (domain ? domain.name : "Domain not found") : "No domain selected yet" });

  checks.push({ key: "source", label: "Source", ok: Boolean(body.gitUrl || rootExists), detail: body.gitUrl ? "Git URL configured" : "Local source path configured" });
  checks.push({ key: "database", label: "Database", ok: true, detail: body.dbType ? `${body.dbType} provisioning requested` : "No database requested" });

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

async function addLog(deploymentId: string, step: "QUEUED" | "PREFLIGHT" | "STARTING" | "ROLLBACK" | "HEALTH_CHECK", message: string, releaseId?: string, metadata: Prisma.InputJsonObject = {}) {
  await pruneDeploymentLogs(deploymentId);
  return prisma.deploymentLog.create({
    data: {
      deploymentId,
      releaseId,
      step,
      message,
      metadata
    }
  });
}

function deploymentLogCutoff() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

async function pruneDeploymentLogs(deploymentId: string) {
  await prisma.deploymentLog.deleteMany({
    where: {
      deploymentId,
      createdAt: { lt: deploymentLogCutoff() }
    }
  });
}

async function enqueueDeployAction(deploymentId: string, action: string, releaseId?: string) {
  try {
    const job = await Promise.race([
      deployQueue.add(action, { deploymentId, releaseId }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Deploy queue timed out")), 2000);
      })
    ]);
    return { queued: true, jobId: job.id };
  } catch (error) {
    await addLog(deploymentId, "QUEUED", `Queue unavailable; ${action} recorded in dry-run mode`, releaseId, {
      dryRun: true,
      error: error instanceof Error ? error.message : "queue unavailable"
    });
    return { queued: false, dryRun: true, reason: "Deploy queue unavailable" };
  }
}

function githubTokenSecretRef() {
  return "github:superadmin:token";
}

function deploymentEnvSecretRef(deploymentSlug: string, key: string) {
  return `deployment:${deploymentSlug}:env:${key}`;
}

function deploymentWebhookSecretRef(deploymentSlug: string) {
  return `deployment:${deploymentSlug}:webhook`;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEnvValue(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function normalizeEnvSecret(deploymentSlug: string, item: z.infer<typeof envVarSchema>) {
  const value = normalizeEnvValue(item.value);
  if (!item.isSecret) {
    if (item.secretRef) await deleteSecret(item.secretRef);
    return { value, isSecret: false, secretRef: null };
  }

  const secretRef = item.secretRef ?? deploymentEnvSecretRef(deploymentSlug, item.key);
  if (typeof value === "string") {
    await putSecret({
      ref: secretRef,
      value,
      kind: "DEPLOYMENT_ENV",
      label: item.key,
      metadata: { deploymentSlug, key: item.key }
    });
  }

  return { value: null, isSecret: true, secretRef };
}

async function githubJson<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "vps-panel",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub API failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function githubRequest<T>(path: string, token: string, init?: RequestInit): Promise<{ data: T; scopes: string[] }> {
  const response = await fetch(`https://api.github.com${path}`, {
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

async function ensureGithubWebhook(deployment: { id: string; slug: string; githubOwner: string | null; githubRepo: string | null; webhookSecretHash: string | null }, token: string | null) {
  if (!token || !deployment.githubOwner || !deployment.githubRepo) return { configured: false, reason: "GitHub token or repository is missing" };
  const existingSecret = await getSecret(deploymentWebhookSecretRef(deployment.slug));
  const secret = existingSecret ?? crypto.randomBytes(32).toString("hex");
  if (!existingSecret) {
    await putSecret({
      ref: deploymentWebhookSecretRef(deployment.slug),
      value: secret,
      kind: "WEBHOOK_SECRET",
      label: `${deployment.slug} GitHub webhook secret`,
      metadata: { deploymentId: deployment.id, deploymentSlug: deployment.slug }
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
      // Return the original hook creation error below.
    }
    return { configured: false, webhookUrl, reason: error instanceof Error ? error.message : "Could not create GitHub webhook" };
  }
}

function logMetadataText(metadata: Prisma.JsonValue | null) {
  if (!metadata) return "";
  try {
    return `\n${JSON.stringify(metadata, null, 2)}`;
  } catch {
    return "";
  }
}

function deploymentLogDir(slug: string) {
  return path.join(env.DEPLOYMENT_LOG_ROOT, slug);
}

type LaravelWorkerConfig = z.infer<typeof laravelWorkerConfigSchema>;

function deploymentProcessConfig(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, any>) } : {};
}

function normalizeLaravelWorkerConfig(input: unknown, fallback?: Partial<LaravelWorkerConfig>): LaravelWorkerConfig {
  const base = {
    enabled: false,
    autoscale: false,
    desiredWorkers: 0,
    minWorkers: 0,
    maxWorkers: 8,
    queueCommand: "php artisan queue:work --sleep=3 --tries=3 --timeout=90",
    ...(fallback ?? {}),
    ...(input && typeof input === "object" ? input as Record<string, unknown> : {})
  };
  return laravelWorkerConfigSchema.parse(base);
}

function laravelWorkerProgramName(slug: string) {
  return `${slug}-queue`;
}

async function applyLaravelWorkers(deployment: Awaited<ReturnType<typeof findDeployment>>, config: LaravelWorkerConfig, reason: string) {
  if (deployment.framework !== "LARAVEL") {
    throw Object.assign(new Error("Laravel workers are only available for Laravel deployments."), { statusCode: 400 });
  }
  const desiredWorkers = config.enabled ? config.desiredWorkers : 0;
  const result = await sysagent.deploymentLaravelWorkers({
    name: laravelWorkerProgramName(deployment.slug),
    rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
    action: desiredWorkers > 0 ? "apply" : "stop",
    desiredWorkers,
    queueCommand: config.queueCommand,
    env: Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string])),
    logDir: deploymentLogDir(deployment.slug)
  });
  const runningWorkers = result.runningWorkers ?? result.status?.running ?? 0;
  const current = normalizeLaravelWorkerConfig({
    ...config,
    desiredWorkers,
    currentWorkers: runningWorkers,
    lastScaledAt: new Date().toISOString(),
    lastScaleReason: reason
  });
  const processConfig = {
    ...deploymentProcessConfig(deployment.processConfig),
    laravelWorkers: current
  };
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { processConfig: processConfig as Prisma.InputJsonValue }
  });
  await addLog(deployment.id, "STARTING", `Laravel queue workers ${desiredWorkers > 0 ? "applied" : "stopped"}`, undefined, { reason, config: current, result } as Prisma.InputJsonObject);
  return { config: current, result };
}

async function applyLaravelManagedProcesses(deployment: Awaited<ReturnType<typeof findDeployment>>, input: unknown) {
  if (deployment.framework !== "LARAVEL") {
    throw Object.assign(new Error("Laravel managed processes are only available for Laravel deployments."), { statusCode: 400 });
  }
  const envVars = Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string]));
  const config = inferredLaravelManagedProcesses(envVars, input);
  const previous = inferredLaravelManagedProcesses(envVars, deploymentProcessConfig(deployment.processConfig).laravelManagedProcesses);
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
      rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
      action: definition.enabled && definition.instances > 0 ? "apply" : "stop",
      desiredWorkers: definition.enabled ? definition.instances : 0,
      queueCommand: renderLaravelProcessCommand(definition.command, deployment.port),
      env: envVars,
      logDir: deploymentLogDir(deployment.slug),
      logPrefix: definition.key
    });
  }
  const processConfig = { ...deploymentProcessConfig(deployment.processConfig), laravelManagedProcesses: config };
  await prisma.deployment.update({ where: { id: deployment.id }, data: { processConfig: processConfig as Prisma.InputJsonValue } });
  return { config, results };
}

function deploymentAppPath(rootPath: string, rootDirectory: string | null | undefined) {
  const cleanRootDirectory = (rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? path.join(rootPath, cleanRootDirectory) : rootPath;
}

function deploymentServerName(domain: { name: string; includeWww?: boolean } | null | undefined) {
  if (!domain?.name) return null;
  if (domain.includeWww === false) return domain.name;
  return `${domain.name} www.${domain.name}`;
}

function deploymentServerNames(deployment: Awaited<ReturnType<typeof findDeployment>>) {
  const names = new Set<string>();
  for (const binding of deployment.domainBindings ?? []) {
    if (binding.subdomain?.domain?.name) {
      names.add(deploymentServerName({ name: `${binding.subdomain.name}.${binding.subdomain.domain.name}`, includeWww: false })!);
    } else if (binding.domain?.name) {
      names.add(deploymentServerName({ name: binding.domain.name })!);
    }
  }
  if (deployment.domain?.name) names.add(deploymentServerName({ name: deployment.domain.name })!);
  return [...names];
}

function commandFailed(value: unknown) {
  const result = value as { degraded?: boolean; dryRun?: boolean; returncode?: number };
  return Boolean(result?.degraded || result?.dryRun || (typeof result?.returncode === "number" && result.returncode !== 0));
}

function commandDetail(value: unknown) {
  const result = value as { dryRun?: boolean; stdout?: string; stderr?: string; reason?: string; returncode?: number };
  if (result?.dryRun) return "Command did not run live because sysagent live commands are disabled";
  return result?.stderr || result?.reason || result?.stdout || (typeof result?.returncode === "number" ? `exit ${result.returncode}` : "");
}

function commandTreeFailure(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if (commandFailed(value)) return commandDetail(value);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (!nested || typeof nested !== "object") continue;
    if (commandFailed(nested)) return `${key}: ${commandDetail(nested)}`;
  }
  return null;
}

function knownErrorHint(text: string): { message: string; repairAction: "set-node-memory" | "sync-public-env" | "sync-runtime" | "redeploy" | "restart" | "rewrite-nginx" | "request-approval"; category: string } | null {
  const lower = text.toLowerCase();
  const phpPeclAbiConflict = /php-pecl-[a-z0-9_-]+/i.test(text)
    && (lower.includes("requires php(api)") || lower.includes("requires php(zend-abi)"))
    && lower.includes("cannot install both php-common");
  const phpRedisAbiConflict = /php-pecl-redis[0-9-]*/i.test(text)
    && (lower.includes("requires php(api)") || lower.includes("requires php(zend-abi)"))
    && lower.includes("filtered out by modular filtering");
  if (lower.includes("eresolve") || lower.includes("unable to resolve dependency tree") || lower.includes("peer dep")) return { message: "NPM dependency resolution failed. Review peer dependencies or use a compatible lockfile before redeploying.", repairAction: "redeploy", category: "npm_peer_dependency" };
  if (lower.includes("package-lock.json") && lower.includes("yarn.lock")) return { message: "Multiple lockfiles detected. Keep one package manager lockfile to avoid inconsistent installs.", repairAction: "redeploy", category: "lockfile_conflict" };
  if (lower.includes("unsupported engine") || lower.includes("node version") || lower.includes("requires node")) return { message: "Node version mismatch. Set a compatible runtime version or update the app engines field.", repairAction: "redeploy", category: "node_version" };
  if (lower.includes("prisma") && (lower.includes("migration") || lower.includes("p100") || lower.includes("database"))) return { message: "Prisma/database migration failed. Check DATABASE_URL, database grants, and migration state.", repairAction: "redeploy", category: "prisma_migration" };
  if (supervisorStartStillStarting(text)) return { message: "Supervisor returned an abnormal start result while the program was still STARTING. Deployment Doctor now waits for health before marking the deploy failed.", repairAction: "restart", category: "supervisor_starting_race" };
  if (nginxProxyMissingDomainFailure(text)) return { message: "The deployment has no linked domain, so Nginx proxy publishing must be skipped. Deployment Doctor now keeps no-domain deployments running on their managed internal port; redeploy to apply the corrected flow.", repairAction: "redeploy", category: "nginx_proxy_missing_domain" };
  if (lower.includes("ensure-acme-webroot") && lower.includes("string_pattern_mismatch") && text.includes("*.")) {
    return {
      message: "Wildcard deployments must use DNS-01 SSL validation, not HTTP ACME webroot validation. Redeploy so Guardian skips webroot prep and queues wildcard DNS SSL.",
      repairAction: "redeploy",
      category: "wildcard_acme_webroot"
    };
  }
  if (lower.includes("another nginx config still claims server_name") || (lower.includes("conflicting server name") && lower.includes("server_name"))) {
    return {
      message: "A stale Nginx vhost still claims this deployment hostname. Deployment Doctor will rewrite the vhost and scrub conflicting server_name configs, including wildcard hosts.",
      repairAction: "rewrite-nginx",
      category: "nginx_server_name_conflict"
    };
  }
  if (lower.includes("403 forbidden") && lower.includes("nginx")) return { message: "Nginx published a directory without a valid index or the wrong Laravel web root. Deployment Doctor will prefer a nested Laravel root containing public/index.php and will not publish an empty public_html fallback.", repairAction: "redeploy", category: "nginx_static_root_403" };
  if (lower.includes("http 404") && lower.includes("not found") && (lower.includes("laravel") || lower.includes("x-powered-by: php") || lower.includes("laravel log tail"))) {
    return {
      message: "Laravel is reachable through the public domain, but GET / returns 404. Add a Laravel route or redirect for /, or set the deployment health/public check URL to an existing route such as /login, /admin, or the app's real entry path.",
      repairAction: "request-approval",
      category: "laravel_root_route_missing"
    };
  }
  if (lower.includes("502 bad gateway") || lower.includes("http 502") || lower.includes("connect() failed") || lower.includes("upstream")) return { message: "Nginx cannot reach the deployment upstream. Guardian will rewrite the deployment vhost, scrub stale server_name configs, and restart the process if the route still returns 502.", repairAction: "rewrite-nginx", category: "nginx_upstream_502" };
  if (
    lower.includes("sqlstate[hy000]")
    && lower.includes("access denied for user")
    && (lower.includes("[1045]") || lower.includes("[1698]") || lower.includes("using password"))
  ) {
    return {
      message: "MySQL/MariaDB rejected the deployment credentials. Check exact DB_DATABASE/DB_USERNAME case, DB_HOST user host (localhost vs 127.0.0.1), password, grants, then clear Laravel config cache and redeploy.",
      repairAction: "request-approval",
      category: "mysql_access_denied"
    };
  }
  if (lower.includes("client_encoding") && lower.includes("utf8mb4") && (lower.includes("postgres") || lower.includes("pgsql"))) return { message: "PostgreSQL deployment is using a MySQL charset value. Set DB_CHARSET=utf8 and clear DB_COLLATION, then redeploy.", repairAction: "request-approval", category: "postgres_charset" };
  if (/class\s+["']redis["']\s+not\s+found/i.test(text)) return { message: "Laravel is configured to use Redis but the PHP redis extension is not installed. Install php-redis on the VPS or set CACHE_DRIVER=file and SESSION_DRIVER=file, then redeploy.", repairAction: "request-approval", category: "php_redis_extension" };
  if (phpRedisAbiConflict) return { message: "PHP Redis extension install is blocked by old EPEL Redis PECL RPMs for the PHP 8.0 ABI. Guardian will rebuild ext-redis with PECL for the active PHP runtime, then redeploy.", repairAction: "request-approval", category: "php_redis_abi_conflict" };
  if (lower.includes("not secure") || (lower.includes("certificate") && lower.includes("invalid"))) return { message: "HTTPS is not active for this domain. Redeploy to issue Let's Encrypt SSL, or use Deployment Doctor to queue an SSL certificate.", repairAction: "redeploy", category: "ssl_missing" };
  if (lower.includes("unsupported operand type") && lower.includes("for |") && lower.includes("nonetype") && lower.includes("python3.9")) return { message: "Python app uses Python 3.10+ type syntax but the VPS started it with Python 3.9. Guardian will install/use Python 3.11, rebuild .venv, and restart.", repairAction: "redeploy", category: "python_runtime_version" };
  if (lower.includes("error loading asgi app") && lower.includes("could not import module")) return { message: "Python ASGI start command points to the wrong module. Guardian now detects app.py/main.py/server.py/api.py and rewrites the uvicorn module before redeploy.", repairAction: "redeploy", category: "python_asgi_module" };
  if (lower.includes("flask.__call__() missing") || (lower.includes("exception in asgi application") && lower.includes("flask"))) return { message: "This Python app is Flask/WSGI but was started with Uvicorn/ASGI. Guardian now detects Flask and uses Gunicorn with the same managed port.", repairAction: "redeploy", category: "python_flask_wsgi" };
  if (lower.includes("ssl handshake failed") || lower.includes("invalid ssl response") || lower.includes("err_ssl_protocol")) return { message: "HTTPS works on the VPS locally but fails on the public internet path. Turn off browser VPN, set DNS A record to this VPS, use Cloudflare DNS-only or SSL Full, then redeploy.", repairAction: "redeploy", category: "ssl_protocol_error" };
  if (lower.includes("public internet path") || lower.includes("local nginx https")) return { message: "DNS or CDN does not reach this server's nginx HTTPS. Fix DNS A record, disable orange-cloud proxy, turn off browser VPN, then redeploy.", repairAction: "redeploy", category: "ssl_public_path" };
  if (lower.includes("please provide a valid cache path") || lower.includes("bootstrap/cache") || lower.includes("storage/framework")) return { message: "Laravel writable/cache directories are missing or not writable. Repair the Laravel storage/bootstrap cache paths, then redeploy.", repairAction: "request-approval", category: "laravel_writable_paths" };
  if (lower.includes("symlink(): no such file or directory") && lower.includes("storagelinkcommand")) return { message: "Laravel storage:link failed because the public web root is missing. Redeploy will now skip storage:link for backend-only Laravel projects; add public/index.php if this domain should serve web traffic.", repairAction: "redeploy", category: "laravel_storage_link_public_missing" };
  if (laravelPublicCwdMissing(text)) return { message: "Laravel process was started from a missing public directory. Guardian will correct the deployment root to the Laravel app root and start artisan from there.", repairAction: "redeploy", category: "laravel_public_cwd_missing" };
  if ((lower.includes("module not found") || lower.includes("can't resolve")) && (lower.includes("laravel frontend asset build") || lower.includes("webpack") || lower.includes("mix") || lower.includes(".vue"))) return { message: "Laravel frontend build cannot find an application source file. Commit the missing file, fix the import path/case, or commit pre-built public assets, then redeploy.", repairAction: "redeploy", category: "laravel_frontend_source_missing" };
  if (lower.includes("artisan package:discover") || lower.includes("laravel package discovery")) return { message: "Laravel package discovery failed while bootstrapping the app. Check the deployment environment values and the package discovery error output, then redeploy.", repairAction: "request-approval", category: "laravel_package_discovery" };
  if (lower.includes("vendor/autoload.php") && lower.includes("artisan")) return { message: "Laravel vendor dependencies are missing. Guardian now auto-runs composer install before restart; retry deploy/restart.", repairAction: "redeploy", category: "laravel_vendor_missing" };
  if (lower.includes("the home or composer_home environment variable must be set")) return { message: "Composer runtime HOME/COMPOSER_HOME was missing on sysagent. Guardian/sysagent now auto-sets fallback HOME paths; retry deploy.", repairAction: "redeploy", category: "composer_home_missing" };
  if (phpPeclAbiConflict) return { message: "PHP 8.2 upgrade is blocked by older PHP 8.0 PECL extension RPMs. Guardian will remove incompatible PECL RPMs, switch the PHP 8.2 module stream, reinstall Laravel PHP extensions, then redeploy.", repairAction: "request-approval", category: "php_pecl_abi_conflict" };
  if (isComposerPlatformCheckInconclusive(text)) return { message: "Composer platform preflight could not produce actionable details because vendor is not installed yet. Redeploy will continue to composer install, where exact PHP/extension issues can be repaired.", repairAction: "redeploy", category: "composer_platform_check_inconclusive" };
  const composerPlatform = detectComposerPlatformIssue(text);
  const phpVersionMismatch = Boolean(
    composerPlatform?.requiredPhpVersion
    && (!composerPlatform.currentPhpVersion || Number((composerPlatform.currentPhpVersion.split(".")[0] ?? "0")) < Number((composerPlatform.requiredPhpVersion.split(".")[0] ?? "0"))
      || (
        Number((composerPlatform.currentPhpVersion.split(".")[0] ?? "0")) === Number((composerPlatform.requiredPhpVersion.split(".")[0] ?? "0"))
        && Number((composerPlatform.currentPhpVersion.split(".")[1] ?? "0")) < Number((composerPlatform.requiredPhpVersion.split(".")[1] ?? "0"))
      ))
  );
  if (phpVersionMismatch) {
    const requiredPhpVersion = composerPlatform?.requiredPhpVersion ?? "unknown";
    const currentPhpVersion = composerPlatform?.currentPhpVersion ?? "unknown";
    return { message: `Composer lockfile requires PHP ${requiredPhpVersion}+ but the VPS CLI runtime is ${currentPhpVersion}. Upgrade PHP on the VPS, then redeploy.`, repairAction: "request-approval", category: "php_runtime_version" };
  }
  if (composerPlatform?.maxSupportedPhpVersion && composerPlatform.currentPhpVersion) {
    return {
      message: `Composer lockfile only supports PHP up to ${composerPlatform.maxSupportedPhpVersion}.x, but the VPS CLI runtime is ${composerPlatform.currentPhpVersion}. Switch the deployment runtime back to PHP ${composerPlatform.maxSupportedPhpVersion} or update composer.lock on PHP ${composerPlatform.currentPhpVersion}, then redeploy.`,
      repairAction: "request-approval",
      category: "php_runtime_version_too_new"
    };
  }
  if (composerPlatform?.composerLockOutdated) {
    return {
      message: "Composer lockfile is out of date with composer.json or incompatible with this PHP runtime. Regenerate composer.lock on a compatible PHP version, commit it, then redeploy.",
      repairAction: "redeploy",
      category: "composer_lock_outdated"
    };
  }
  if (composerPlatform?.missingExtensions.includes("gd")) return { message: "Composer is missing the PHP GD extension. Install/enable GD on the VPS, then redeploy.", repairAction: "request-approval", category: "php_extension_gd" };
  if (composerPlatform?.missingExtensions.includes("soap")) return { message: "Composer is missing the PHP SOAP extension. Install/enable SOAP on the VPS, then redeploy.", repairAction: "request-approval", category: "php_extension_soap" };
  if (lower.includes("composer") && (lower.includes("ext-") || lower.includes("requires php extension"))) return { message: "Composer is missing a required PHP extension. Install the extension on the VPS, then redeploy.", repairAction: "request-approval", category: "php_extension" };
  if (lower.includes("\"middleware\" file convention is deprecated") || lower.includes("middleware-to-proxy")) return { message: "Next.js deprecated the middleware file convention for this app version. Guardian will convert middleware.* to proxy.* in the deployment workspace and retry the build.", repairAction: "redeploy", category: "next_middleware_to_proxy" };
  if (lower.includes("next.js") && lower.includes("turbopack") && (lower.includes("exit code 1") || lower.includes("creating an optimized production build"))) return { message: "Next.js 16 uses Turbopack by default and this build failed before a useful compiler diagnostic was emitted. Guardian will retry the same build with the official --webpack fallback.", repairAction: "redeploy", category: "next_turbopack_fallback" };
  if (lower.includes("max-old-space-size=") && (lower.includes("exit code 143") || lower.includes("sigterm"))) return { message: "The build script sets a Node heap larger than the protected deploy budget. Guardian will cap inline and package.json NODE_OPTIONS to the dynamic budget, then retry with fewer Next workers.", repairAction: "set-node-memory", category: "node_inline_heap_budget" };
  if (nodePackageBinaryMissing(text)) {
    return {
      message: "Frontend build could not find a local package binary such as Mix, Vite, webpack, or Next. Guardian will reinstall Node dependencies with devDependencies and retry the build on redeploy.",
      repairAction: "redeploy",
      category: "node_package_bin_missing"
    };
  }
  const frontendModule = detectFrontendModuleNotFound(text);
  if (frontendModule) {
    return {
      message: formatFrontendModuleNotFoundMessage(frontendModule),
      repairAction: "redeploy",
      category: "frontend_module_not_found"
    };
  }
  if ((lower.includes("no such file or directory") || lower.includes("command not found") || lower.includes("unsupported deployment executable")) && (lower.includes("composer") || lower.includes("php") || lower.includes("python") || lower.includes("pip") || lower.includes("uv") || lower.includes("uvicorn") || lower.includes("gunicorn") || lower.includes("node") || lower.includes("npm") || lower.includes("pnpm") || lower.includes("yarn") || lower.includes("next") || lower.includes("vite") || lower.includes("pm2") || lower.includes("supervisor"))) {
    return { message: "A required runtime tool is missing on the VPS. Use Deployment Doctor to request approval for the missing tool install, then redeploy.", repairAction: "request-approval", category: "missing_runtime_tool" };
  }
  if (lower.includes("no runnable start command")) return { message: "Vite/React apps need preview or static serve. Sync runtime from package.json, then redeploy.", repairAction: "sync-runtime", category: "missing_start_command" };
  if (lower.includes("cannot find module") || lower.includes("module_not_found")) return { message: "Missing package or wrong build output. Run dependency install, verify package.json, then redeploy.", repairAction: "redeploy", category: "missing_module" };
  if (lower.includes("pm2 process") && lower.includes("bound to port=") && lower.includes("expected")) return { message: "PM2 started with an app-provided PORT instead of the panel-assigned port. Guardian now forces the managed PORT during PM2 start; redeploy to rewrite the saved PM2 environment.", repairAction: "redeploy", category: "pm2_port_env_mismatch" };
  if (lower.includes("eaddrinuse") || lower.includes("address already in use")) return { message: "Port conflict. Let the doctor redeploy so the worker can move the app to a free managed port.", repairAction: "redeploy", category: "port_conflict" };
  if (lower.includes("heap out of memory") || lower.includes("javascript heap out of memory") || lower.includes("sigkill") || lower.includes("sigterm") || lower.includes("exit code 143") || lower.includes("killed")) return { message: "Server memory pressure. Deployment Doctor will show the dynamic deploy budget; increase DEPLOY_MAX_MEMORY_MB or add swap if the protected budget is still too small.", repairAction: "set-node-memory", category: "memory" };
  if (lower.includes("dubious ownership") || lower.includes("source sync safe.directory") || lower.includes("safe.directory")) {
    return { message: "Git safe.directory failed inside the deployment runtime. Guardian/sysagent now injects a safe Git config for deployment and Composer commands; retry deploy.", repairAction: "redeploy", category: "git_safe_directory" };
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) return { message: "File permission issue. Ensure the panel user owns the deployment directory and runtime log directory.", repairAction: "redeploy", category: "permission" };
  if (lower.includes("env") && (lower.includes("missing") || lower.includes("required"))) return { message: "Missing environment variable. Add required env keys in the deployment Env tab, then redeploy.", repairAction: "redeploy", category: "missing_env" };
  if (lower.includes("localhost") || lower.includes("127.0.0.1")) return { message: "App may be generating internal localhost URLs. Sync public URL env values to the linked domain.", repairAction: "sync-public-env", category: "localhost_url" };
  return null;
}

function isLocalhostValue(value: string | null | undefined) {
  return Boolean(value && /(^|\/\/|\.)localhost(?::\d+)?(\/|$)|(^|\/\/)127\.0\.0\.1(?::\d+)?(\/|$)|(^|\/\/)0\.0\.0\.0(?::\d+)?(\/|$)/i.test(value));
}

function publicUrlEnv(domain: { name: string } | null | undefined) {
  if (!domain?.name) return {};
  const url = `https://${domain.name}`;
  return {
    APP_URL: url,
    ASSET_URL: url,
    APP_ORIGIN: url,
    AUTH_URL: url,
    BASE_URL: url,
    NEXTAUTH_URL: url,
    NEXT_PUBLIC_APP_URL: url,
    NEXT_PUBLIC_APP_ORIGIN: url,
    NEXT_PUBLIC_BASE_URL: url,
    NEXT_PUBLIC_DOMAIN: domain.name,
    NEXT_PUBLIC_SITE_URL: url,
    PUBLIC_URL: url,
    SITE_URL: url,
    URL: url,
    SESSION_SECURE_COOKIE: "true",
    SESSION_SAME_SITE: "lax",
    TRUSTED_PROXIES: "*"
  };
}

async function inspectLaravelFrontendAssets(appPath: string, publicDirectory: string | null | undefined) {
  const entries = await fs.readdir(appPath).catch(() => []);
  const names = new Set(entries.map((entry) => entry.toLowerCase()));
  const packageJsonText = await fs.readFile(path.join(appPath, "package.json"), "utf8").catch(() => null);
  if (!packageJsonText) return null;

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(packageJsonText) as typeof pkg;
  } catch {
    pkg = {};
  }
  const scripts = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasFrontendMarkers = Boolean(
    names.has("vite.config.js")
    || names.has("vite.config.ts")
    || names.has("vite.config.mjs")
    || names.has("vite.config.cjs")
    || names.has("webpack.mix.js")
    || deps.vite
    || deps["laravel-vite-plugin"]
    || deps["laravel-mix"]
    || scripts.build
    || scripts.production
    || scripts.prod
  );
  if (!hasFrontendMarkers) return null;

  const publicRoot = path.join(appPath, publicDirectory || "public");
  const candidates = [
    path.join(publicRoot, "build", "manifest.json"),
    path.join(publicRoot, "mix-manifest.json"),
    path.join(publicRoot, "admin", "assets", "css"),
    path.join(publicRoot, "css"),
    path.join(publicRoot, "js")
  ];
  const hasBuiltAssets = await Promise.all(
    candidates.map((candidate) => fs.access(candidate).then(() => true).catch(() => false))
  ).then((results) => results.some(Boolean));
  const buildScript = scripts.build ? "build" : scripts.production ? "production" : scripts.prod ? "prod" : null;
  return {
    hasBuiltAssets,
    buildScript,
    detail: hasBuiltAssets
      ? `Laravel frontend assets exist under ${publicRoot}.`
      : `Laravel frontend markers exist but no built assets were found under ${publicRoot}.`
  };
}

function extractFirstPartyAssetPaths(html: string | undefined, domainName: string | null | undefined) {
  if (!html || !domainName) return [];
  const paths = new Set<string>();
  const domainFamily = domainName.toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
  const belongsToDomainFamily = (hostname: string) =>
    hostname === domainName || (domainFamily.length > 0 && hostname.toLowerCase().split(".").filter(Boolean).slice(-2).join(".") === domainFamily);
  const assetPattern = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|otf)(?:[?#][^"'\s<>]*)?$/i;
  const attrPattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(html))) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    let pathValue: string | null = null;
    if (raw.startsWith("//")) {
      try {
        const parsed = new URL(`https:${raw}`);
        if (belongsToDomainFamily(parsed.hostname)) pathValue = `${parsed.pathname}${parsed.search}`;
      } catch {
        pathValue = null;
      }
    } else if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        if (belongsToDomainFamily(parsed.hostname)) pathValue = `${parsed.pathname}${parsed.search}`;
      } catch {
        pathValue = null;
      }
    } else if (raw.startsWith("/")) {
      pathValue = raw;
    }
    if (pathValue && assetPattern.test(pathValue)) paths.add(pathValue);
  }
  return [...paths].sort((a, b) => {
    const score = (value: string) => value.endsWith(".css") || value.includes(".css?") ? 0 : value.endsWith(".js") || value.includes(".js?") ? 1 : 2;
    return score(a) - score(b);
  }).slice(0, 16);
}

function evidenceLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("== STDOUT") && !line.startsWith("== STDERR"))
    .slice(-12)
    .map((line) => line.slice(0, 500));
}

async function upsertPlainEnv(deploymentId: string, key: string, value: string) {
  return prisma.deploymentEnvVar.upsert({
    where: { deploymentId_key: { deploymentId, key } },
    update: { value, isSecret: false, secretRef: null },
    create: { deploymentId, key, value, isSecret: false, secretRef: null }
  });
}

async function applyNodeMemoryEnv(deployment: Awaited<ReturnType<typeof findDeployment>>) {
  const existing = deployment.env.find((item) => item.key === "NODE_OPTIONS");
  const current = existing?.value ?? "";
  const value = current.includes("--max-old-space-size=")
    ? current
    : [current, "--max-old-space-size=512"].filter(Boolean).join(" ").trim();
  const envVar = await upsertPlainEnv(deployment.id, "NODE_OPTIONS", value);
  return { env: [envVar], value };
}

async function applyPublicUrlEnv(deployment: Awaited<ReturnType<typeof findDeployment>>) {
  const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
  const values = publicUrlEnv(domain);
  const changed = [];
  for (const [key, value] of Object.entries(values)) {
    const existing = deployment.env.find((item) => item.key === key);
    if (existing?.isSecret) continue;
    if (!existing?.value || isLocalhostValue(existing.value)) {
      changed.push(await upsertPlainEnv(deployment.id, key, value));
    }
  }
  return { domain: domain?.name ?? null, changed };
}

async function createDoctorApprovals(deploymentId: string, actions: Array<{ key: string; label: string; command: string; reason: string }>) {
  const created = [];
  for (const action of actions) {
    created.push(await prisma.deploymentDoctorApproval.create({
      data: {
        deploymentId,
        actionKey: action.key,
        label: action.label,
        command: action.command,
        reason: action.reason
      }
    }));
  }
  return created;
}

function uniqueRiskyActions(actions: Array<{ key: string; label: string; command: string; reason: string; approvalRequired: true }>) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.key)) return false;
    seen.add(action.key);
    return true;
  });
}

async function executeDoctorApproval(deployment: Awaited<ReturnType<typeof findDeployment>>, approval: { actionKey: string }) {
  if (approval.actionKey.startsWith("install-")) {
    const toolMap: Record<string, string> = {
      "install-composer": "composer",
      "install-php-runtime": "php",
      "install-php": "php",
      "install-php82": "php82",
      "install-php-extension-gd": "php-gd",
      "install-php-gd": "php-gd",
      "install-php-extension-soap": "php-soap",
      "install-php-soap": "php-soap",
      "install-php-extension-redis": "php-redis",
      "install-php-redis": "php-redis",
      "install-php-extension-mbstring": "php-mbstring",
      "install-php-extension-xml": "php-xml",
      "install-php-extension-curl": "php-curl",
      "install-php-extension-zip": "php-zip",
      "install-php-extension-mysql": "php-mysql",
      "install-php-extension-pgsql": "php-pgsql",
      "install-python": "python",
      "install-python311": "python311",
      "install-nodejs": "nodejs",
      "install-pnpm": "pnpm",
      "install-yarn": "yarn",
      "install-uv": "uv",
      "install-go": "go",
      "install-supervisor": "supervisor",
      "install-pm2": "pm2"
    };
    const tool = toolMap[approval.actionKey];
    if (!tool) throw new Error(`Unsupported runtime tool approval: ${approval.actionKey}`);
    return sysagent.deploymentInstallRuntimeTool({ tool });
  }
  if (approval.actionKey === "repair-permissions") {
    return sysagent.deploymentRepairPermissions({ rootPath: deployment.rootPath, logDir: deploymentLogDir(deployment.slug) });
  }
  if (approval.actionKey === "supervisor-config") {
    return sysagent.deploymentRepairSupervisor({ name: deployment.slug });
  }
  if (approval.actionKey === "rewrite-nginx") {
    const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
    return sysagent.deploymentNginx(
      buildDeploymentNginxRequest({
        deploymentId: deployment.id,
        fqdn: deploymentServerName(domain) ?? deployment.slug,
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        framework: deployment.framework,
        startCommand: deployment.startCommand,
        publicDirectory: deployment.publicDirectory,
        outputDirectory: deployment.outputDirectory,
        fallbackRootPath: deploymentFallbackRootPath(domain),
        forceSsl: domain?.forceSsl ?? false
      })
    );
  }
  if (approval.actionKey === "database-provision") {
    if (!deployment.dbType || !deployment.dbName || !deployment.dbUser) {
      throw new Error("Deployment database metadata is incomplete");
    }
    const result = await sysagent.provisionDatabase({
      engine: deployment.dbType,
      database: deployment.dbName,
      username: deployment.dbUser,
      passwordSecretRef: deployment.dbPasswordSecretRef
    }) as { password?: string; result?: unknown };
    const failure = commandTreeFailure(result.result);
    if (failure) throw new Error(`Database provision failed: ${failure}`);
    const secretRef = deployment.dbPasswordSecretRef ?? `deployment:${deployment.id}:database-password`;
    if (result.password) {
      await putSecret({
        ref: secretRef,
        value: result.password,
        kind: "DATABASE_PASSWORD",
        label: `${deployment.dbUser}@${deployment.dbName}`,
        metadata: { deploymentId: deployment.id, engine: deployment.dbType, database: deployment.dbName, username: deployment.dbUser }
      });
      if (deployment.dbPasswordSecretRef !== secretRef) {
        await prisma.deployment.update({ where: { id: deployment.id }, data: { dbPasswordSecretRef: secretRef } });
      }
    }
    return result;
  }
  if (approval.actionKey === "normalize-postgres-charset") {
    const changed = [];
    changed.push(await upsertPlainEnv(deployment.id, "DB_CHARSET", "utf8"));
    changed.push(await upsertPlainEnv(deployment.id, "DB_COLLATION", ""));
    return { changed };
  }
  if (approval.actionKey === "install-php-extension") {
    throw new Error("Exact PHP extension is unknown. Install the required extension manually after reviewing Composer output.");
  }
  throw new Error(`Unsupported approval action: ${approval.actionKey}`);
}

async function syncDeploymentRuntime(deployment: Awaited<ReturnType<typeof findDeployment>>) {
  const detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      framework: detection.detected,
      runtime: detection.suggestions.runtime,
      packageManager: detection.suggestions.packageManager,
      installCommand: detection.suggestions.installCommand,
      buildCommand: detection.suggestions.buildCommand,
      startCommand: detection.suggestions.startCommand,
      outputDirectory: detection.suggestions.outputDirectory,
      processManager: detection.suggestions.processManager
    }
  });
  return { detection, updated };
}

function doctorBytesToMb(value: unknown) {
  const bytes = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.round(bytes / 1024 / 1024));
}

function doctorClampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function calculateDoctorDeployBudget(snapshot: any) {
  const totalMemoryMb = doctorBytesToMb(snapshot?.memory?.totalBytes);
  const availableMemoryMb = doctorBytesToMb(snapshot?.memory?.availableBytes);
  const runningAppsMemoryMb = doctorBytesToMb(snapshot?.runningApps?.memoryBytes);
  const cpuCount = Math.max(1, Number(snapshot?.cpu?.count || 1));
  const defaults = snapshot?.defaults?.resourceLimits ?? {};
  const systemReserveMb = Number(env.DEPLOY_SYSTEM_RESERVE_MB || 4096);
  const minAppReserveMb = Number(env.DEPLOY_MIN_APP_RESERVE_MB || 8192);
  const appReserveMultiplier = Number(env.DEPLOY_APP_RESERVE_MULTIPLIER || 2);
  const minDeployMemoryMb = Number(env.DEPLOY_MIN_MEMORY_MB || 3072);
  const maxDeployMemoryMb = Number(env.DEPLOY_MAX_MEMORY_MB || 4096);
  const freeCpuCores = Number(env.DEPLOY_FREE_CPU_CORES || 2);
  const appReserveMb = Math.max(minAppReserveMb, Math.ceil(runningAppsMemoryMb * appReserveMultiplier));
  const budgetByTotal = totalMemoryMb > 0 ? totalMemoryMb - appReserveMb - systemReserveMb : Number(defaults.memoryMaxMb || 4096);
  const budgetByAvailable = availableMemoryMb > 0 ? availableMemoryMb - systemReserveMb : budgetByTotal;
  const rawDeployMemoryMb = Math.min(budgetByTotal, budgetByAvailable);
  const deployMemoryMb = rawDeployMemoryMb >= minDeployMemoryMb
    ? doctorClampNumber(Math.floor(rawDeployMemoryMb), minDeployMemoryMb, maxDeployMemoryMb)
    : Math.max(1536, Math.floor(rawDeployMemoryMb || Number(defaults.memoryMaxMb || 4096)));
  const usableCpuCores = Math.max(1, cpuCount - freeCpuCores);
  const cpuQuotaPercent = doctorClampNumber(usableCpuCores * 100, 100, Math.min(600, cpuCount * 100));
  const nodeHeapMb = Math.max(512, deployMemoryMb - 1536);
  const nextWorkers = doctorClampNumber(Math.floor(deployMemoryMb / 2048), 1, usableCpuCores);
  return {
    totalMemoryMb,
    availableMemoryMb,
    runningAppsMemoryMb,
    appReserveMb,
    systemReserveMb,
    deployMemoryMb,
    cpuCount,
    cpuQuotaPercent,
    nodeHeapMb,
    nextWorkers,
    swapFreeMb: doctorBytesToMb(snapshot?.swap?.freeBytes),
    runningProcessCount: Number(snapshot?.runningApps?.processCount || 0)
  };
}

async function deploymentDoctor(deployment: Awaited<ReturnType<typeof findDeployment>>) {
  const checks: Array<{ key: string; label: string; status: "pass" | "warn" | "fail"; detail: string; fix?: string; repairAction?: string }> = [];
  const envSuggestions: Array<{ key: string; value: string; reason: string; repairAction: string }> = [];
  const riskyActions: Array<{ key: string; label: string; command: string; reason: string; approvalRequired: true }> = [];
  const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
  const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
  const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
  const serverName = deploymentServerName(domain);
  let resourceBudget: ReturnType<typeof calculateDoctorDeployBudget> | null = null;
  try {
    const resourceSnapshot = await sysagent.deploymentResourceSnapshot({ rootPath: appPath });
    resourceBudget = calculateDoctorDeployBudget(resourceSnapshot);
    checks.push({
      key: "deploy_resource_budget",
      label: "Deploy resource budget",
      status: resourceBudget.deployMemoryMb < Number(env.DEPLOY_MIN_MEMORY_MB || 3072) ? "warn" : "pass",
      detail: `Deploy gets ${resourceBudget.deployMemoryMb}MB RAM, ${resourceBudget.cpuQuotaPercent}% CPU, Node heap ${resourceBudget.nodeHeapMb}MB, Next workers ${resourceBudget.nextWorkers}. Running apps use ${resourceBudget.runningAppsMemoryMb}MB and reserve is ${resourceBudget.appReserveMb}MB; system reserve is ${resourceBudget.systemReserveMb}MB.`,
      fix: resourceBudget.deployMemoryMb < Number(env.DEPLOY_MIN_MEMORY_MB || 3072) ? "Increase DEPLOY_MAX_MEMORY_MB, lower app reserve only if safe, or add swap before redeploying heavy Next builds." : undefined,
      repairAction: resourceBudget.deployMemoryMb < Number(env.DEPLOY_MIN_MEMORY_MB || 3072) ? "set-node-memory" : undefined
    });
  } catch (error) {
    checks.push({
      key: "deploy_resource_budget",
      label: "Deploy resource budget",
      status: "warn",
      detail: error instanceof Error ? error.message : "Could not read deploy resource budget.",
      fix: "Restart sysagent and rerun Deployment Doctor."
    });
  }

  const rootExists = await fs.stat(appPath).then((stats) => stats.isDirectory()).catch(() => false);
  checks.push({
    key: "source",
    label: "Source path",
    status: rootExists ? "pass" : "fail",
    detail: rootExists ? `Readable at ${appPath}` : `Source directory is not readable at ${appPath}`,
    fix: rootExists ? undefined : "Run source sync/redeploy or correct the root directory.",
    repairAction: rootExists ? undefined : "redeploy"
  });

  let detection: Awaited<ReturnType<typeof detectDeploymentSource>> | null = null;
  if (rootExists) {
    try {
      detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
      const commandMismatch = detection.suggestions.startCommand !== deployment.startCommand
        || detection.suggestions.buildCommand !== deployment.buildCommand
        || detection.suggestions.packageManager !== deployment.packageManager
        || detection.detected !== deployment.framework;
      checks.push({
        key: "runtime",
        label: "Runtime detection",
        status: commandMismatch ? "warn" : "pass",
        detail: `${detection.detected} (${Math.round(detection.confidence * 100)}%): ${detection.reason}`,
        fix: commandMismatch ? "Sync detected runtime commands before the next deploy." : undefined,
        repairAction: commandMismatch ? "sync-runtime" : undefined
      });
    } catch (error) {
      checks.push({
        key: "runtime",
        label: "Runtime detection",
        status: "fail",
        detail: error instanceof Error ? error.message : "Could not inspect source files",
        fix: "Check root directory and source permissions."
      });
    }
  }

  if (deployment.framework !== "STATIC" && processManager !== "STATIC" && !deployment.startCommand && !detection?.suggestions.startCommand) {
    checks.push({
      key: "start_command",
      label: "Start command",
      status: "fail",
      detail: "No runnable start command was detected.",
      fix: "Add a package.json start script or set a manual start command.",
      repairAction: "sync-runtime"
    });
  } else {
    checks.push({ key: "start_command", label: "Start command", status: "pass", detail: deployment.startCommand || detection?.suggestions.startCommand || "Static deployment" });
  }

  const outputDirectory = deployment.outputDirectory ?? detection?.suggestions.outputDirectory ?? null;
  if (deployment.buildCommand && outputDirectory && outputDirectory !== ".") {
    const outputPath = path.join(appPath, outputDirectory);
    const outputExists = await fs.stat(outputPath).then((stats) => stats.isDirectory()).catch(() => false);
    checks.push({
      key: "build_output",
      label: "Build output",
      status: outputExists ? "pass" : "fail",
      detail: outputExists ? `Found at ${outputPath}` : `Missing build output at ${outputPath}`,
      fix: outputExists ? undefined : "Redeploy to rerun the build, then verify the output directory setting and build command.",
      repairAction: outputExists ? undefined : "redeploy"
    });
  }

  const runtimeTools = requiredRuntimeExecutables({
    framework: detection?.detected ?? deployment.framework,
    packageManager: detection?.suggestions.packageManager ?? deployment.packageManager,
    runtime: detection?.suggestions.runtime ?? deployment.runtime,
    processManager: deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework],
    installCommand: deployment.installCommand ?? detection?.suggestions.installCommand,
    buildCommand: deployment.buildCommand ?? detection?.suggestions.buildCommand,
    startCommand: deployment.startCommand ?? detection?.suggestions.startCommand
  });
  let toolsResult: Awaited<ReturnType<typeof sysagent.deploymentRuntimeTools>> | null = null;
  if (runtimeTools.length) {
    try {
      toolsResult = await sysagent.deploymentRuntimeTools({ tools: runtimeTools });
      const missing = toolsResult.items.filter((tool) => !tool.installed);
      checks.push({
        key: "runtime_tools",
        label: "Runtime tools",
        status: missing.length ? "fail" : "pass",
        detail: missing.length ? `Missing ${missing.map((tool) => tool.name).join(", ")}` : `Installed: ${toolsResult.items.map((tool) => tool.name).join(", ")}`,
        fix: missing.length ? "Install missing runtime tools on the VPS, then redeploy." : undefined,
        repairAction: missing.length ? "request-approval" : undefined
      });
      for (const target of runtimeInstallTargetsForMissingExecutables(missing.map((tool) => tool.name))) {
        riskyActions.push({
          key: target.actionKey,
          label: target.label,
          command: target.command,
          reason: target.reason,
          approvalRequired: true
        });
      }
    } catch (error) {
      checks.push({ key: "runtime_tools", label: "Runtime tools", status: "warn", detail: error instanceof Error ? error.message : "Could not inspect runtime tools" });
    }
  }

  const policyError = deploymentPortPolicyError(deployment.port);
  const dbOwner = await prisma.deployment.findFirst({ where: { port: deployment.port, id: { not: deployment.id } }, select: { name: true, slug: true } });
  let livePort: unknown = null;
  try {
    livePort = await sysagent.deploymentPortStatus({ rootPath: appPath, port: deployment.port, processName: deployment.slug, processManager });
  } catch (error) {
    livePort = { returncode: 1, stderr: error instanceof Error ? error.message : "Port check failed" };
  }
  const portBlocked = Boolean(policyError || dbOwner || ((livePort as { occupied?: boolean; reusable?: boolean }).occupied && !(livePort as { reusable?: boolean }).reusable));
  const expectsRuntimeListener = deployment.status === "RUNNING" && deployment.framework !== "STATIC" && processManager !== "STATIC" && processManager !== "NONE";
  const portNotListening = expectsRuntimeListener && !commandFailed(livePort) && !(livePort as { occupied?: boolean; reusable?: boolean }).occupied && !(livePort as { reusable?: boolean }).reusable;
  checks.push({
    key: "port",
    label: "Port",
    status: portBlocked || portNotListening ? "fail" : "pass",
    detail: policyError
      ?? (dbOwner
        ? `Port used by ${dbOwner.name || dbOwner.slug}`
        : portNotListening
          ? `Deployment is marked RUNNING but nothing is listening on port ${deployment.port}.`
          : commandDetail(livePort) || `Port ${deployment.port} is available/reusable`),
    fix: portBlocked
      ? "Redeploy to let the worker move this app to a free managed port."
      : portNotListening
        ? "Restart the deployment process; if the port stays closed, redeploy and inspect running logs."
        : undefined,
    repairAction: portBlocked ? "redeploy" : portNotListening ? "restart" : undefined
  });

  let health: unknown = null;
  try {
    health = await sysagent.deploymentHealth({ deploymentId: deployment.id, port: deployment.port, healthUrl: deployment.healthUrl, processName: deployment.slug, processManager, rootPath: appPath, logDir: deploymentLogDir(deployment.slug), strictHealth: normalizeDeploymentResourcePolicy(deployment.processConfig).healthStrict });
  } catch (error) {
    health = { returncode: 1, stderr: error instanceof Error ? error.message : "Health check failed" };
  }
  const healthDown = commandFailed(health);
  checks.push({
    key: "health",
    label: "Runtime health",
    status: healthDown ? "fail" : "pass",
    detail: commandDetail(health) || "Local runtime health check passed",
    fix: healthDown ? "Restart first; if it still fails, redeploy so install/build/start can be repaired." : undefined,
    repairAction: healthDown ? "restart" : undefined
  });

  if (deployment.dbType) {
    const envKeys = new Set(deployment.env.map((item) => item.key));
    const missingDbMeta = !deployment.dbName || !deployment.dbUser || !deployment.dbPasswordSecretRef;
    let dbDetail = missingDbMeta ? "Database name, user, or password secret is missing." : `${deployment.dbType} metadata is configured.`;
    let dbStatus: "pass" | "warn" | "fail" = missingDbMeta ? "fail" : "pass";
    try {
      const overview = await sysagent.databaseOverview() as { engines?: Array<{ engine: string; installed: boolean; databases: Array<{ name: string }>; users: Array<{ name: string }> }> };
      const engine = overview.engines?.find((item) => item.engine === deployment.dbType);
      const dbExists = Boolean(engine?.databases?.some((item) => item.name === deployment.dbName));
      const userExists = Boolean(engine?.users?.some((item) => item.name === deployment.dbUser));
      if (!engine?.installed) {
        dbStatus = "fail";
        dbDetail = `${deployment.dbType} service or CLI is not reachable.`;
      } else if (!dbExists || !userExists) {
        dbStatus = "fail";
        dbDetail = `${deployment.dbName ?? "database"} ${dbExists ? "exists" : "is missing"}, ${deployment.dbUser ?? "user"} ${userExists ? "exists" : "is missing"}.`;
      }
    } catch (error) {
      dbStatus = dbStatus === "fail" ? "fail" : "warn";
      dbDetail = error instanceof Error ? error.message : "Could not inspect deployment database.";
    }
    if (!envKeys.has("DATABASE_URL")) {
      dbStatus = dbStatus === "fail" ? "fail" : "warn";
      dbDetail += " DATABASE_URL env is not configured.";
    }
    checks.push({
      key: "database",
      label: "Database",
      status: dbStatus,
      detail: dbDetail,
      fix: dbStatus !== "pass" ? "Provision database credentials and set DATABASE_URL before redeploying." : undefined,
      repairAction: dbStatus !== "pass" ? "request-approval" : undefined
    });
    if (dbStatus !== "pass") {
      riskyActions.push({
        key: "database-provision",
        label: "Provision/fix deployment database",
        command: `create/grant ${deployment.dbType} database ${deployment.dbName ?? "<db>"} for ${deployment.dbUser ?? "<user>"} and set DATABASE_URL`,
        reason: "Database creation/grants and secrets affect application data access and require admin approval.",
        approvalRequired: true
      });
    }
  }

  if (processManager === "SUPERVISOR") {
    riskyActions.push({
      key: "supervisor-config",
      label: "Rewrite Supervisor config",
      command: `supervisorctl reread && supervisorctl update && supervisorctl restart ${deployment.slug}`,
      reason: "Supervisor-backed deployments may need a generated program config before start/restart can be trusted.",
      approvalRequired: true
    });
    checks.push({
      key: "supervisor",
      label: "Supervisor readiness",
      status: healthDown ? "warn" : "pass",
      detail: healthDown ? "Supervisor process/config may need admin-approved rewrite." : "Supervisor-backed health check passed.",
      fix: healthDown ? "Approve Supervisor config rewrite after reviewing the generated command." : undefined,
      repairAction: healthDown ? "request-approval" : undefined
    });
  }

  let runtimeLogs = "";
  try {
    const logs = await sysagent.deploymentRuntimeLogs({ name: deployment.slug, logDir: deploymentLogDir(deployment.slug), rootPath: appPath, lines: 160 });
    runtimeLogs = logs.text || "";
  } catch {
    runtimeLogs = "";
  }
  const recentErrors = [
    ...deployment.logs.filter((log) => log.level === "error" || log.step === "FAILED").slice(0, 8).map((log) => `${log.message}${logMetadataText(log.metadata)}`),
    runtimeLogs
  ].join("\n");
  const hint = knownErrorHint(recentErrors);

  if ((detection?.detected ?? deployment.framework) === "LARAVEL" && rootExists) {
    const hasCurrentPublicIndex = await deploymentHasLaravelPublicIndex(appPath);
    const detectedLaravelRoot = await findDeploymentAppRoot(deployment.rootPath, deployment.rootDirectory, "LARAVEL");
    const betterLaravelRoot = !hasCurrentPublicIndex && detectedLaravelRoot?.hasLaravelPublicIndex
      ? detectedLaravelRoot.appPath
      : null;
    checks.push({
      key: "laravel_public_root",
      label: "Laravel public web root",
      status: betterLaravelRoot || (serverName && !hasCurrentPublicIndex) ? "fail" : hasCurrentPublicIndex ? "pass" : "warn",
      detail: betterLaravelRoot
        ? `Current root ${appPath} has no public/index.php; web root detected at ${betterLaravelRoot}.`
        : hasCurrentPublicIndex
          ? `Found ${path.join(appPath, "public", "index.php")}`
          : serverName
            ? `No Laravel public/index.php exists, but ${serverName} is routed to this deployment. Nginx needs a web entrypoint or a running upstream process, otherwise it returns 502.`
            : "No Laravel public/index.php exists. Deployment can still run as backend-only/worker-safe when no public domain is routed to it.",
      fix: betterLaravelRoot
        ? "Redeploy so Deployment Doctor corrects rootDirectory before publishing Nginx."
        : serverName && !hasCurrentPublicIndex
          ? "Add/restore Laravel public/index.php or change this deployment to a worker/API process with a real HTTP start command, then redeploy."
          : undefined,
      repairAction: betterLaravelRoot ? "redeploy" : serverName && !hasCurrentPublicIndex ? "redeploy" : undefined
    });
    const frontendAssets = await inspectLaravelFrontendAssets(appPath, deployment.publicDirectory);
    const frontendModuleIssue = detectFrontendModuleNotFound(recentErrors);
    if (frontendAssets) {
      checks.push({
        key: "laravel_frontend_assets",
        label: "Laravel frontend assets",
        status: frontendModuleIssue ? "fail" : frontendAssets.hasBuiltAssets ? "pass" : "warn",
        detail: frontendModuleIssue
          ? formatFrontendModuleNotFoundMessage(frontendModuleIssue)
          : frontendAssets.detail,
        fix: frontendModuleIssue
          ? formatFrontendModuleNotFoundMessage(frontendModuleIssue)
          : frontendAssets.hasBuiltAssets ? undefined : frontendAssets.buildScript ? "Redeploy so Guardian runs the Laravel frontend asset build before publishing Nginx." : "Add a Laravel frontend build script or commit the compiled public assets.",
        repairAction: frontendModuleIssue || !frontendAssets.hasBuiltAssets ? "redeploy" : undefined
      });
    }
  }

  if (hint?.repairAction === "set-node-memory") {
    envSuggestions.push({ key: "NODE_OPTIONS", value: "--max-old-space-size=512", reason: "Reduce Node build/runtime memory pressure", repairAction: "set-node-memory" });
  }
  if (hint?.repairAction === "sync-public-env" && domain?.name) {
    for (const [key, value] of Object.entries(publicUrlEnv(domain))) {
      const existing = deployment.env.find((item) => item.key === key);
      if (!existing?.value || isLocalhostValue(existing.value)) {
        envSuggestions.push({ key, value, reason: "Replace localhost/internal public URL with the deployment domain", repairAction: "sync-public-env" });
      }
    }
  }
  if (hint?.category === "mysql_access_denied" && deployment.dbType === "MYSQL") {
    riskyActions.push({
      key: "database-provision",
      label: "Repair MySQL database grants",
      command: `grant ${deployment.dbName ?? "<db>"} to ${deployment.dbUser ?? "<user>"}, rotate/sync password if needed, and rebuild Laravel database env`,
      reason: "Laravel received MySQL access denied. The database user, host, password, or grants need to be reconciled before redeploy.",
      approvalRequired: true
    });
  }
  if (hint?.category === "permission") {
    riskyActions.push({
      key: "repair-permissions",
      label: "Repair deployment ownership",
      command: `chown -R panel:panel ${deployment.rootPath} ${deploymentLogDir(deployment.slug)}`,
      reason: "Ownership/permission repairs affect files recursively and require explicit approval.",
      approvalRequired: true
    });
  }
  if (hint?.category === "laravel_writable_paths") {
    riskyActions.push({
      key: "repair-permissions",
      label: "Repair Laravel writable paths",
      command: `mkdir -p ${path.join(appPath, "bootstrap/cache")} ${path.join(appPath, "storage/framework/cache/data")} ${path.join(appPath, "storage/framework/sessions")} ${path.join(appPath, "storage/framework/views")} ${path.join(appPath, "storage/logs")} && chown -R panel:panel ${path.join(appPath, "storage")} ${path.join(appPath, "bootstrap/cache")} && chmod -R ug+rwX ${path.join(appPath, "storage")} ${path.join(appPath, "bootstrap/cache")}`,
      reason: "Laravel needs writable storage and bootstrap cache directories before package discovery can run.",
      approvalRequired: true
    });
  }
  if (hint?.category === "postgres_charset") {
    riskyActions.push({
      key: "normalize-postgres-charset",
      label: "Normalize PostgreSQL Laravel charset env",
      command: "Set DB_CHARSET=utf8 and clear DB_COLLATION for PostgreSQL deployments",
      reason: "Laravel is sending a MySQL-only utf8mb4 client_encoding to PostgreSQL.",
      approvalRequired: true
    });
  }
  if (hint?.category === "php_redis_extension" || hint?.category === "php_redis_abi_conflict") {
    riskyActions.push({
      key: "install-php-extension-redis",
      label: "Install PHP Redis extension",
      command: "Install php-redis via panel runtime-tools",
      reason: "Laravel is configured for Redis but PHP cannot load the Redis class.",
      approvalRequired: true
    });
  }
  if (hint?.category === "python_runtime_version") {
    riskyActions.push({
      key: "install-python311",
      label: "Install Python 3.10+ runtime",
      command: "Install Python 3.10+/3.11 via panel runtime-tools, rebuild .venv, and redeploy",
      reason: "The app uses Python 3.10+ syntax but the VPS started it with Python 3.9.",
      approvalRequired: true
    });
  }
  const composerRepairTargets = runtimeInstallTargetsForComposerPlatformIssue(recentErrors);
  if (hint?.category === "php_extension" || hint?.category === "php_extension_gd" || hint?.category === "php_extension_soap" || hint?.category === "php_runtime_version" || hint?.category === "php_runtime_version_too_new" || hint?.category === "php_pecl_abi_conflict") {
    for (const target of composerRepairTargets) {
      riskyActions.push({
        key: target.actionKey,
        label: target.label,
        command: target.command,
        reason: target.reason,
        approvalRequired: true
      });
    }
  }
  if (hint?.category === "php_extension" && composerRepairTargets.length === 0) {
    riskyActions.push({
      key: "install-php-extension",
      label: "Install missing PHP extension",
      command: "Install missing PHP extension via system packages (Ubuntu: apt install php-<ext>; AlmaLinux: dnf install php-<ext>)",
      reason: "Composer reported a missing PHP extension. Admin should confirm exact extension before installing.",
      approvalRequired: true
    });
  }
  checks.push({
    key: "error_hints",
    label: "Error analysis",
    status: hint ? "warn" : "pass",
    detail: hint?.message ?? "No known build/runtime error pattern found in recent logs.",
    fix: hint?.message,
    repairAction: hint?.repairAction
  });

  const doctorFramework = detection?.detected ?? deployment.framework;
  const doctorLaravelHasPublicIndex = doctorFramework === "LARAVEL" ? await deploymentHasLaravelPublicIndex(appPath) : true;
  if (serverName) {
    let publicRoute: unknown = null;
    try {
      publicRoute = await sysagent.deploymentPublicRoute({ serverName });
    } catch (error) {
      publicRoute = { returncode: 1, stderr: error instanceof Error ? error.message : "Public route check failed" };
    }
    const publicFailed = commandFailed(publicRoute);
    checks.push({
      key: "public_route",
      label: "Public website",
      status: publicFailed ? "warn" : "pass",
      detail: commandDetail(publicRoute) || "Public route resolved through Nginx",
      fix: publicFailed ? "Rewrite the generated Nginx vhost, scrub stale server_name configs, then restart the process if the route still returns 502/503/504." : undefined,
      repairAction: publicFailed ? "rewrite-nginx" : undefined
    });
    if (!publicFailed && doctorFramework === "LARAVEL" && doctorLaravelHasPublicIndex && domain?.name) {
      const assetPaths = extractFirstPartyAssetPaths((publicRoute as { stdout?: string }).stdout, domain.name);
      const missingAssets: string[] = [];
      for (const assetPath of assetPaths) {
        let assetResult: unknown = null;
        try {
          assetResult = await sysagent.deploymentPublicRoute({
            serverName,
            path: assetPath,
            rootPath: appPath,
            framework: deployment.framework
          });
        } catch (error) {
          assetResult = { returncode: 1, stderr: error instanceof Error ? error.message : "Asset check failed" };
        }
        if (commandFailed(assetResult)) {
          const code = (assetResult as { httpCode?: number }).httpCode;
          missingAssets.push(`${assetPath}${code ? ` (${code})` : ""}`);
        }
      }
      checks.push({
        key: "public_static_assets",
        label: "Public static assets",
        status: missingAssets.length ? "warn" : "pass",
        detail: missingAssets.length ? `Missing through Nginx: ${missingAssets.slice(0, 8).join(", ")}` : assetPaths.length ? `Checked ${assetPaths.length} first-party asset URL(s).` : "No first-party static assets found in the public page.",
        fix: missingAssets.length ? `Ensure the files exist under ${path.join(appPath, deployment.publicDirectory || "public")} or fix the app asset paths/source repo, then redeploy.` : undefined,
        repairAction: missingAssets.length ? "redeploy" : undefined
      });
    }
    let nginxInspect: unknown = null;
    try {
      nginxInspect = await sysagent.deploymentNginxInspect({ deploymentId: deployment.id, serverName, upstreamPort: deployment.port, rootPath: deployment.rootPath });
    } catch (error) {
      nginxInspect = { returncode: 1, stderr: error instanceof Error ? error.message : "Nginx inspect failed" };
    }
    const nginxMismatch = commandFailed(nginxInspect);
    checks.push({
      key: "nginx_config",
      label: "Nginx upstream",
      status: nginxMismatch ? "warn" : "pass",
      detail: commandDetail(nginxInspect) || `Nginx config points to ${(nginxInspect as { expectedUpstream?: string }).expectedUpstream}`,
      fix: nginxMismatch ? "Rewrite the generated deployment vhost after reviewing the expected upstream. This also removes stale static account vhosts that claim the same hostname." : undefined,
      repairAction: nginxMismatch ? "request-approval" : undefined
    });
    if (nginxMismatch) {
      riskyActions.push({
        key: "rewrite-nginx",
        label: "Rewrite generated Nginx vhost",
        command: `write deployment vhost for ${serverName} -> 127.0.0.1:${deployment.port}; nginx -t; systemctl reload nginx`,
        reason: "Nginx rewrite changes public routing and should be approved after reviewing the target upstream.",
        approvalRequired: true
      });
    }
  } else {
    checks.push({ key: "public_route", label: "Public website", status: "warn", detail: "No domain is linked yet.", fix: "Bind a domain to enable public route checks." });
  }

  const lastGoodRelease = await prisma.deploymentRelease.findFirst({
    where: { deploymentId: deployment.id, status: "SUCCEEDED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, commitSha: true, createdAt: true }
  });
  if ((deployment.status === "FAILED" || healthDown) && lastGoodRelease) {
    checks.push({
      key: "rollback",
      label: "Rollback candidate",
      status: "warn",
      detail: `Last successful release ${lastGoodRelease.commitSha ?? lastGoodRelease.id} is available.`,
      fix: "Rollback is available if redeploy keeps failing.",
      repairAction: "rollback"
    });
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const recommendedAction = checks.find((check) => check.repairAction)?.repairAction ?? (failed || deployment.status === "FAILED" ? "redeploy" : healthDown ? "restart" : null);
  return {
    status: failed ? "fail" : warnings ? "warn" : "pass",
    summary: failed ? `${failed} blocking issue(s) found` : warnings ? `${warnings} warning(s) found` : "Deployment looks healthy",
    recommendedAction,
    checks,
    evidence: evidenceLines(recentErrors),
    envSuggestions,
    riskyActions: uniqueRiskyActions(riskyActions),
    resourceBudget,
    generatedAt: new Date().toISOString()
  };
}

export const deploymentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (request) => {
    const query = z.object({
      search: z.string().optional(),
      status: statusSchema.optional(),
      sourceProvider: sourceProviderSchema.optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50)
    }).parse(request.query);
    const where = {
      ...(query.search ? { OR: [{ name: { contains: query.search, mode: "insensitive" as const } }, { slug: { contains: query.search, mode: "insensitive" as const } }] } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.sourceProvider ? { sourceProvider: query.sourceProvider } : {})
    };
    const [items, total] = await Promise.all([
      prisma.deployment.findMany({
        where,
        include: { domain: true, domainBindings: { include: { domain: true, subdomain: { include: { domain: true } } }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] }, env: { orderBy: [{ createdAt: "asc" }, { key: "asc" }] }, releases: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { releases: true, logs: true, env: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      prisma.deployment.count({ where })
    ]);
    return { items: items.map(serializeDeployment), total, page: query.page, pageSize: query.pageSize };
  });

  app.get("/ports/next", async () => ({ port: await nextAvailablePort() }));

  app.post("/detect", async (request) => detectFramework(detectSchema.parse(request.body)));

  app.post("/preflight", async (request) => preflight(preflightSchema.parse(request.body)));

  app.get("/github/connection", async () => {
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
    return {
      connected: Boolean(connection?.tokenSecretRef || connection?.installationId),
      username: connection?.username ?? null,
      installationId: connection?.installationId ?? null,
      scopes: connection?.scopes ?? [],
      connectedAt: connection?.connectedAt ?? null
    };
  });

  app.put("/github/connection", async (request) => {
    const body = githubConnectionSchema.parse(request.body);
    const tokenSecretRef = githubTokenSecretRef();
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
      where: { id: "superadmin" },
      update: {
        username: verifiedUsername ?? undefined,
        tokenSecretRef: typeof body.token === "string" ? tokenSecretRef : body.token === null ? null : undefined,
        installationId: body.installationId ?? undefined,
        scopes: verifiedScopes,
        connectedAt: body.token || body.installationId ? new Date() : undefined
      },
      create: {
        id: "superadmin",
        username: verifiedUsername ?? undefined,
        tokenSecretRef: typeof body.token === "string" ? tokenSecretRef : undefined,
        installationId: body.installationId ?? undefined,
        scopes: verifiedScopes,
        connectedAt: body.token || body.installationId ? new Date() : undefined
      }
    });
    return { connected: Boolean(connection.tokenSecretRef || connection.installationId), username: connection.username, scopes: connection.scopes };
  });

  app.get("/github/repos", async (request) => {
    const query = z.object({ search: z.string().optional() }).parse(request.query);
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
    if (!connection?.tokenSecretRef && !connection?.installationId) {
      return {
        connected: false,
        dryRun: true,
        items: query.search
          ? [{ owner: "example", name: `${slugify(query.search)}-app`, fullName: `example/${slugify(query.search)}-app`, private: false, defaultBranch: "main" }]
          : []
      };
    }
    if (!connection.tokenSecretRef) {
      return { connected: true, dryRun: true, items: [], note: "GitHub App installation listing is pending" };
    }

    const token = await getSecret(connection.tokenSecretRef);
    if (!token) {
      return { connected: false, dryRun: true, items: [], note: "GitHub token secret is missing" };
    }

    const repos = await githubJson<Array<{
      id: number;
      owner: { login: string };
      name: string;
      full_name: string;
      private: boolean;
      default_branch: string;
      html_url: string;
      updated_at: string;
    }>>("/user/repos?per_page=100&sort=updated", token);
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

  app.get("/github/repos/:owner/:repo/branches", async (request) => {
    const params = z.object({ owner: z.string(), repo: z.string() }).parse(request.params);
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
    const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
    if (!token) {
      return {
        dryRun: true,
        repository: `${params.owner}/${params.repo}`,
        items: [{ name: "main", protected: false }, { name: "develop", protected: false }]
      };
    }
    const branches = await githubJson<Array<{ name: string; protected: boolean }>>(
      `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/branches?per_page=100`,
      token
    );
    return {
      dryRun: false,
      repository: `${params.owner}/${params.repo}`,
      items: branches.map((branch) => ({ name: branch.name, protected: branch.protected }))
    };
  });

  app.get("/github/repos/:owner/:repo/detect", async (request) => {
    const params = z.object({ owner: z.string(), repo: z.string() }).parse(request.params);
    const query = z.object({ branch: z.string().default("main"), rootDirectory: z.string().default(".") }).parse(request.query);
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
    const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
    if (!token) {
      return {
        repository: `${params.owner}/${params.repo}`,
        dryRun: true,
        ...(await detectFramework({ files: ["package.json", "next.config.js"] }))
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

  app.post("/github/import", async (request, reply) => {
    const rawBody = request.body as { autoDeployEnabled?: boolean } | null;
    const body = baseDeploymentSchema.extend({
      githubOwner: z.string(),
      githubRepo: z.string(),
      rootPath: z.string().optional(),
      port: deploymentPortSchema.optional()
    }).parse(request.body);
    const autoDeployEnabled = rawBody?.autoDeployEnabled ?? true;
    const port = body.port ?? await nextAvailablePort();
    const rootPath = body.rootPath ?? path.join(env.FILE_MANAGER_ROOT, "deployments", body.githubRepo);
    const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
    const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
    const existingDeployment = await prisma.deployment.findFirst({
      where: {
        sourceProvider: "GITHUB",
        githubOwner: { equals: body.githubOwner, mode: "insensitive" },
        githubRepo: { equals: body.githubRepo, mode: "insensitive" }
      }
    });

    await assertDeploymentPortAvailable(body.port ?? existingDeployment?.port ?? port, existingDeployment?.id);
    const selectedDomainId = body.domainId ?? null;
    const bindingTarget = selectedDomainId ? await resolveBindingTarget(selectedDomainId) : null;
    const deploymentData = {
      ...body,
      domainId: bindingTarget?.domainId ?? null,
      processConfig: (body.processConfig ?? {}) as Prisma.InputJsonValue
    };

    const deployment = existingDeployment
      ? await prisma.deployment.update({
          where: { id: existingDeployment.id },
          data: {
            ...deploymentData,
            slug: await uniqueDeploymentSlug(body.slug || body.name || body.githubRepo, existingDeployment.id),
            sourceProvider: "GITHUB",
            gitUrl: body.gitUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}.git`,
            repoUrl: body.repoUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}`,
            rootPath,
            port: body.port ?? existingDeployment.port,
            autoDeployEnabled,
            status: "STOPPED"
          }
        })
      : await prisma.deployment.create({
          data: {
            ...deploymentData,
            slug: await uniqueDeploymentSlug(body.slug || body.name || body.githubRepo),
            sourceProvider: "GITHUB",
            gitUrl: body.gitUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}.git`,
            repoUrl: body.repoUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}`,
            rootPath,
            port,
            autoDeployEnabled,
            status: "STOPPED"
          }
        });
    const webhook = autoDeployEnabled ? await ensureGithubWebhook(deployment, token) : { configured: false, reason: "Auto deploy disabled" };
    if (autoDeployEnabled && !webhook.configured) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { autoDeployEnabled: false } });
    }
    await addLog(deployment.id, "QUEUED", existingDeployment ? "GitHub project settings refreshed" : "GitHub project imported", undefined, {
      repository: `${body.githubOwner}/${body.githubRepo}`,
      branch: body.branch,
      rootPath,
      autoDeployEnabled: autoDeployEnabled && webhook.configured,
      webhook
    });
    await syncPrimaryBindingTarget(deployment.id, selectedDomainId);
    await reconcileSelectedDomainRoute(deployment.id, selectedDomainId);
    return reply.code(existingDeployment ? 200 : 201).send(await findDeployment(deployment.id));
  });

  app.post("/", async (request, reply) => {
    const body = baseDeploymentSchema.parse(request.body);
    await assertDeploymentPortAvailable(body.port);
    const selectedDomainId = body.domainId ?? null;
    const bindingTarget = selectedDomainId ? await resolveBindingTarget(selectedDomainId) : null;
    const deployment = await prisma.deployment.create({
      data: {
        ...body,
        domainId: bindingTarget?.domainId ?? null,
        processConfig: (body.processConfig ?? {}) as Prisma.InputJsonValue,
        slug: await uniqueDeploymentSlug(body.slug || body.name),
        status: "STOPPED",
        env: {
          create: Object.entries(body.envVars).map(([key, value], index) => ({ key, value, isSecret: false, createdAt: new Date(Date.now() + index) }))
        }
      }
    });
    await syncPrimaryBindingTarget(deployment.id, selectedDomainId);
    await reconcileSelectedDomainRoute(deployment.id, selectedDomainId);
    if (body.autoDeployEnabled && body.sourceProvider === "GITHUB") {
      const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
      const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
      const webhook = await ensureGithubWebhook(deployment, token);
      if (!webhook.configured) {
        await prisma.deployment.update({ where: { id: deployment.id }, data: { autoDeployEnabled: false } });
      }
    await addLog(
      deployment.id,
      "QUEUED",
      webhook.configured
        ? webhook.manualSetupRequired ? "Auto deploy enabled; manual GitHub webhook setup required" : "Auto deploy GitHub webhook configured"
        : "Auto deploy disabled because GitHub webhook could not be configured",
      undefined,
      webhook as Prisma.InputJsonObject
    );
    }
    await addLog(deployment.id, "QUEUED", "Project created");
    await audit(request, { action: "CREATE", resource: "deployment", resourceId: deployment.id, description: `Created deployment ${deployment.name}` });
    return reply.code(201).send(await findDeployment(deployment.id));
  });

  app.get("/:deploymentId", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    return findDeployment(deploymentId);
  });

  app.patch("/:deploymentId", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = updateDeploymentSchema.parse(request.body);
    const deployment = await findDeployment(deploymentId);
    if (body.port !== undefined) await assertDeploymentPortAvailable(body.port, deployment.id);
    const selectedDomainId = body.domainId;
    const bindingTarget = selectedDomainId ? await resolveBindingTarget(selectedDomainId) : null;
    if (body.autoDeployEnabled === true) {
      const webhookTarget = {
        id: deployment.id,
        slug: body.slug ?? deployment.slug,
        githubOwner: body.githubOwner ?? deployment.githubOwner,
        githubRepo: body.githubRepo ?? deployment.githubRepo,
        webhookSecretHash: deployment.webhookSecretHash
      };
      if ((body.sourceProvider ?? deployment.sourceProvider) !== "GITHUB" || !webhookTarget.githubOwner || !webhookTarget.githubRepo) {
        throw app.httpErrors.badRequest("Auto deploy requires a GitHub source with owner and repository configured.");
      }
      const connection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
      const token = connection?.tokenSecretRef ? await getSecret(connection.tokenSecretRef) : null;
      const webhook = await ensureGithubWebhook(webhookTarget, token);
      if (!webhook.configured) {
        throw app.httpErrors.badRequest(`Auto deploy could not be enabled: ${webhook.reason ?? "GitHub webhook could not be configured"}`);
      }
      await addLog(
        deployment.id,
        "QUEUED",
        webhook.manualSetupRequired ? "Auto deploy enabled; manual GitHub webhook setup required" : "Auto deploy GitHub webhook configured",
        undefined,
        webhook as Prisma.InputJsonObject
      );
    }
    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        ...body,
        ...(body.processConfig !== undefined ? { processConfig: body.processConfig as Prisma.InputJsonValue } : {}),
        ...(selectedDomainId !== undefined ? { domainId: bindingTarget?.domainId ?? null } : {}),
        slug: body.slug ?? undefined
      } as Prisma.DeploymentUncheckedUpdateInput
    });
    await syncPrimaryBindingTarget(deployment.id, selectedDomainId);
    await reconcileSelectedDomainRoute(deployment.id, selectedDomainId);
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Updated deployment ${updated.slug}` });
    return findDeployment(deployment.id);
  });

  app.get("/:deploymentId/workers", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const config = normalizeLaravelWorkerConfig(deploymentProcessConfig(deployment.processConfig).laravelWorkers);
    let status = null;
    if (deployment.framework === "LARAVEL") {
      status = await sysagent.deploymentLaravelWorkers({
        name: laravelWorkerProgramName(deployment.slug),
        rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
        action: "status",
        desiredWorkers: config.enabled ? config.desiredWorkers : 0,
        queueCommand: config.queueCommand,
        logDir: deploymentLogDir(deployment.slug)
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    }
    return { config, status };
  });

  app.patch("/:deploymentId/workers", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ laravelWorkers: laravelWorkerConfigSchema }).parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const policy = normalizeDeploymentResourcePolicy(deployment.processConfig);
    const cappedWorkers = {
      ...body.laravelWorkers,
      desiredWorkers: Math.min(body.laravelWorkers.desiredWorkers, policy.workersMax),
      minWorkers: Math.min(body.laravelWorkers.minWorkers, policy.workersMax),
      maxWorkers: Math.min(body.laravelWorkers.maxWorkers, policy.workersMax)
    };
    const result = await applyLaravelWorkers(
      deployment,
      cappedWorkers,
      body.laravelWorkers.autoscale ? "manual save with Guardian autoscale enabled" : "manual worker setting"
    );
    await audit(request, { action: "UPDATE", resource: "deployment_workers", resourceId: deployment.id, description: `Updated Laravel workers for ${deployment.slug}`, metadata: result as unknown as Prisma.InputJsonObject });
    return reply.code(202).send(result);
  });

  app.get("/:deploymentId/laravel-processes", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const envVars = Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string]));
    return inferredLaravelManagedProcesses(envVars, deploymentProcessConfig(deployment.processConfig).laravelManagedProcesses);
  });

  app.patch("/:deploymentId/laravel-processes", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ laravelManagedProcesses: laravelManagedProcessesSchema }).parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const result = await applyLaravelManagedProcesses(deployment, body.laravelManagedProcesses);
    await audit(request, { action: "UPDATE", resource: "deployment_laravel_processes", resourceId: deployment.id, description: `Updated Laravel managed processes for ${deployment.slug}` });
    return reply.code(202).send(result);
  });

  app.delete("/:deploymentId", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ confirmSlug: z.string() }).parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    if (body.confirmSlug !== deployment.slug) {
      throw app.httpErrors.badRequest("Project deletion requires exact slug confirmation");
    }
    await prisma.deployment.delete({ where: { id: deployment.id } });
    await audit(request, { action: "DELETE", resource: "deployment", resourceId: deployment.id, description: `Deleted deployment ${deployment.slug}` });
    return { ok: true };
  });

  app.get("/:deploymentId/domains", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    return deployment.domainBindings;
  });

  app.post("/:deploymentId/domains", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ domainId: z.string(), primary: z.boolean().default(false) }).parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const target = await resolveBindingTarget(body.domainId);
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
    if (body.primary || !deployment.domainId) {
      const updates: Prisma.PrismaPromise<unknown>[] = [
        prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: target.domainId } }),
        prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id, domainId: { not: body.domainId }, role: "primary" }, data: { role: "alias" } }),
        prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id, subdomainId: { not: target.subdomainId }, role: "primary" }, data: { role: "alias" } })
      ];
      if (target.domainId) updates.push(prisma.domain.update({ where: { id: target.domainId }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } }));
      await prisma.$transaction(updates);
    } else if (target.domainId) {
      await prisma.domain.update({ where: { id: target.domainId }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } });
    }
    await publishDomainRouteForBinding(deployment, binding);
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Bound domain ${target.displayName} to ${deployment.slug}` });
    return reply.code(201).send(serializeDomainBinding(binding));
  });

  app.patch("/:deploymentId/domains/:domainId/primary", async (request) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const target = await resolveBindingTarget(domainId);
    const binding = await findDeploymentBindingBySelection(deployment.id, domainId);
    const updates: Prisma.PrismaPromise<unknown>[] = [
      prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: target.domainId } }),
      prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id }, data: { role: "alias" } }),
      prisma.deploymentDomain.update({ where: { id: binding.id }, data: { role: "primary" } })
    ];
    if (target.domainId) updates.push(prisma.domain.update({ where: { id: target.domainId }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } }));
    await prisma.$transaction(updates);
    await publishDomainRouteForBinding(deployment, binding);
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Set primary domain ${target.displayName} for ${deployment.slug}` });
    return { ok: true };
  });

  app.delete("/:deploymentId/domains/:domainId", async (request) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const target = await resolveBindingTarget(domainId);
    const binding = await findDeploymentBindingBySelection(deployment.id, domainId);
    const removedDomain = boundDomainFromBinding(binding);
    await prisma.deploymentDomain.delete({ where: { id: binding.id } });
    if (deployment.domainId === domainId) {
      const next = await prisma.deploymentDomain.findFirst({ where: { deploymentId: deployment.id }, include: { domain: true, subdomain: { include: { domain: true } } }, orderBy: { createdAt: "asc" } });
      const updates: Prisma.PrismaPromise<unknown>[] = [
        prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: next?.domainId ?? null } }),
        prisma.domain.updateMany({
          where: { id: domainId, hostingDeploymentId: deployment.id },
          data: { hostingMode: "PUBLIC_HTML", hostingDeploymentId: null }
        })
      ];
      if (next) {
        updates.push(prisma.deploymentDomain.update({ where: { id: next.id }, data: { role: "primary" } }));
        if (next.domainId) updates.push(prisma.domain.update({ where: { id: next.domainId }, data: { hostingMode: "DEPLOYMENT_PROXY", hostingDeploymentId: deployment.id } }));
      }
      await prisma.$transaction(updates);
      if (next) await publishDomainRouteForBinding(deployment, next);
    } else if (target.domainId) {
      await prisma.domain.updateMany({
        where: { id: target.domainId, hostingDeploymentId: deployment.id },
        data: { hostingMode: "PUBLIC_HTML", hostingDeploymentId: null }
      });
    }
    await publishPublicHtmlNginxVhost(removedDomain);
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Removed a domain from ${deployment.slug}` });
    return { ok: true };
  });

  app.post("/:deploymentId/domain-api-token", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = projectDomainApiTokenSchema.parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    if (!deployment.accountId) {
      throw app.httpErrors.badRequest("Project domain API tokens are available only for account-owned projects.");
    }
    const token = app.jwt.sign(
      {
        sub: deployment.slug,
        role: "project_domain",
        accountId: deployment.accountId,
        deploymentId: deployment.id
      },
      { expiresIn: body.expiresInSeconds }
    );
    await audit(request, {
      action: "CREATE",
      resource: "project_domain_api_token",
      resourceId: deployment.id,
      description: `Generated project domain API token for ${deployment.slug}`
    });
    return {
      token,
      tokenType: "Bearer",
      expiresInSeconds: body.expiresInSeconds,
      apiBaseUrl: `http://${env.VPS_IP}:${env.PANEL_PORT}/api/v1/account/project-domain`,
      endpoint: "POST /domains",
      deployment: { id: deployment.id, slug: deployment.slug, name: deployment.name }
    };
  });

  app.patch("/:deploymentId/status", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ status: statusSchema }).parse(request.body);
    const deployment = await findDeployment(deploymentId);
    return prisma.deployment.update({ where: { id: deployment.id }, data: { status: body.status } });
  });

  app.get("/:deploymentId/webhook", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    return {
      enabled: deployment.autoDeployEnabled,
      secretConfigured: Boolean(deployment.webhookSecretHash),
      webhookUrl: `${env.FRONTEND_URL.replace(/\/$/, "")}/api/v1/webhooks/github`,
      event: "push",
      branch: deployment.branch,
      repository: deployment.githubOwner && deployment.githubRepo ? `${deployment.githubOwner}/${deployment.githubRepo}` : null
    };
  });

  app.post("/:deploymentId/webhook-secret", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const secret = crypto.randomBytes(32).toString("hex");
    const secretRef = deploymentWebhookSecretRef(deployment.slug);
    await putSecret({
      ref: secretRef,
      value: secret,
      kind: "WEBHOOK_SECRET",
      label: `${deployment.slug} GitHub webhook secret`,
      metadata: { deploymentId: deployment.id, deploymentSlug: deployment.slug }
    });
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        webhookSecretHash: sha256(secret),
        autoDeployEnabled: true
      }
    });
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Generated webhook secret for ${deployment.slug}` });
    return {
      enabled: true,
      secret,
      secretConfigured: true,
      webhookUrl: `${env.FRONTEND_URL.replace(/\/$/, "")}/api/v1/webhooks/github`,
      event: "push"
    };
  });

  app.get("/:deploymentId/env", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const env = await prisma.deploymentEnvVar.findMany({ where: { deploymentId: deployment.id }, orderBy: [{ createdAt: "asc" }, { key: "asc" }] });
    return env.map((item) => ({ ...item, value: item.isSecret ? null : item.value, masked: item.isSecret }));
  });

  app.get("/:deploymentId/env/:key/reveal", async (request) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const item = await prisma.deploymentEnvVar.findUniqueOrThrow({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    const value = item.isSecret && item.secretRef ? await getSecret(item.secretRef) : item.value;
    return { key: item.key, value: value ?? "", isSecret: item.isSecret };
  });

  app.put("/:deploymentId/env/:key", async (request) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const body = envVarSchema.omit({ key: true }).parse(request.body);
    const deployment = await findDeployment(deploymentId);
    const normalized = await normalizeEnvSecret(deployment.slug, { ...body, key });
    return prisma.deploymentEnvVar.upsert({
      where: { deploymentId_key: { deploymentId: deployment.id, key } },
      update: normalized,
      create: { deploymentId: deployment.id, key, ...normalized }
    });
  });

  app.post("/:deploymentId/env/bulk", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ env: z.array(envVarSchema).max(200) }).parse(request.body);
    const deployment = await findDeployment(deploymentId);
    const results = [];
    const importedAt = Date.now();
    for (const [index, item] of body.env.entries()) {
      const normalized = await normalizeEnvSecret(deployment.slug, item);
      results.push(await prisma.deploymentEnvVar.upsert({
        where: { deploymentId_key: { deploymentId: deployment.id, key: item.key } },
        update: { ...normalized, createdAt: new Date(importedAt + index) },
        create: { deploymentId: deployment.id, key: item.key, ...normalized, createdAt: new Date(importedAt + index) }
      }));
    }
    return { ok: true, items: results };
  });

  app.delete("/:deploymentId/env/:key", async (request) => {
    const { deploymentId, key } = z.object({ deploymentId: z.string(), key: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const existing = await prisma.deploymentEnvVar.findUnique({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    if (existing?.secretRef) await deleteSecret(existing.secretRef);
    await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
    return { ok: true };
  });

  app.post("/:deploymentId/env/bulk-delete", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ keys: z.array(z.string().min(1)).min(1).max(200) }).parse(request.body);
    const deployment = await findDeployment(deploymentId);
    const removed: string[] = [];
    for (const key of [...new Set(body.keys.map((item) => item.trim().toUpperCase()).filter(Boolean))]) {
      const existing = await prisma.deploymentEnvVar.findUnique({
        where: { deploymentId_key: { deploymentId: deployment.id, key } }
      });
      if (!existing) continue;
      if (existing.secretRef) await deleteSecret(existing.secretRef);
      await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
      removed.push(key);
    }
    await audit(request, {
      action: "DELETE",
      resource: "deployment_env",
      resourceId: deployment.id,
      description: `Bulk deleted ${removed.length} env vars for ${deployment.slug}`,
      metadata: { removed }
    });
    return { ok: true, removed };
  });

  app.post("/:deploymentId/env/clear-database-overrides", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    if (!deployment.dbType || !deployment.dbName || !deployment.dbUser) {
      throw new Error("This deployment does not use a panel-managed database");
    }
    const removed: string[] = [];
    for (const key of ["DB_PASSWORD", "DATABASE_URL"] as const) {
      const existing = await prisma.deploymentEnvVar.findUnique({
        where: { deploymentId_key: { deploymentId: deployment.id, key } }
      });
      if (!existing) continue;
      if (key === "DB_PASSWORD" && existing.secretRef) continue;
      if (existing.secretRef) await deleteSecret(existing.secretRef);
      await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId: deployment.id, key } } });
      removed.push(key);
    }
    await audit(request, {
      action: "UPDATE",
      resource: "deployment_env",
      resourceId: deployment.id,
      description: `Cleared database env overrides for ${deployment.slug}`,
      metadata: { removed }
    });
    return { ok: true, removed };
  });

  app.get("/:deploymentId/releases", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    return prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "desc" }, include: { logs: { orderBy: { createdAt: "asc" } } } });
  });

  app.get("/:deploymentId/metrics", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    await pruneDeploymentLogs(deployment.id);
    const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    const [metrics, buildLogs] = await Promise.all([
      sysagent.deploymentMetrics({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        port: deployment.port,
        processManager: deployment.processManager,
        logDir: deploymentLogDir(deployment.slug),
        dbType: deployment.dbType,
        dbName: deployment.dbName,
        serverNames: deploymentServerNames(deployment),
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
        where: { deploymentId: deployment.id, createdAt: { gte: deploymentLogCutoff() } },
        orderBy: { createdAt: "desc" },
        take: 300
      })
    ]);
    return { ...(metrics as Record<string, unknown>), buildLogs };
  });

  app.get("/:deploymentId/laravel-runtime", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    if (deployment.framework !== "LARAVEL") throw app.httpErrors.badRequest("Laravel runtime status is only available for Laravel deployments.");
    const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
    const serverName = deploymentServerName(domain);
    return sysagent.deploymentLaravelRuntimeStatus({
      deploymentId: deployment.id,
      name: deployment.slug,
      rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
      serverName,
      upstreamPort: deployment.port,
      processManager: deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework],
      startCommand: deployment.startCommand,
      logDir: deploymentLogDir(deployment.slug)
    });
  });

  app.post("/:deploymentId/laravel-runtime/repair", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    if (deployment.framework !== "LARAVEL") throw app.httpErrors.badRequest("Laravel runtime repair is only available for Laravel deployments.");
    const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
    const serverName = deploymentServerName(domain);
    const repair = await sysagent.deploymentLaravelRuntimeRepair({
      deploymentId: deployment.id,
      name: deployment.slug,
      rootPath: appPath,
      serverName,
      upstreamPort: deployment.port,
      processManager: deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework],
      startCommand: "php-fpm",
      logDir: deploymentLogDir(deployment.slug)
    });
    const route = await rewriteDeploymentDomainRoute(deployment);
    const status = await sysagent.deploymentLaravelRuntimeStatus({
      deploymentId: deployment.id,
      name: deployment.slug,
      rootPath: appPath,
      serverName,
      upstreamPort: deployment.port,
      processManager: deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework],
      startCommand: "php-fpm",
      logDir: deploymentLogDir(deployment.slug)
    });
    await addLog(deployment.id, "HEALTH_CHECK", "Laravel PHP-FPM runtime repair requested", undefined, { repair, route, status } as Prisma.InputJsonObject);
    await audit(request, { action: "APPLY", resource: "deployment_laravel_runtime", resourceId: deployment.id, description: `Repaired Laravel PHP-FPM runtime for ${deployment.slug}`, metadata: { repair, route, status } as Prisma.InputJsonObject });
    return { repair, route, status };
  });

  app.post("/:deploymentId/laravel-runtime/timing", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ url: z.string().url().optional(), samples: z.coerce.number().int().min(1).max(10).default(5) }).parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    if (deployment.framework !== "LARAVEL") throw app.httpErrors.badRequest("Laravel timing check is only available for Laravel deployments.");
    const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
    const serverName = deploymentServerName(domain)?.split(/\s+/)[0];
    const url = body.url ?? (deployment.healthUrl?.startsWith("http") ? deployment.healthUrl : serverName ? `https://${serverName}/` : null);
    if (!url) throw app.httpErrors.badRequest("Add a domain or health URL before running a timing check.");
    const timing = await sysagent.deploymentLaravelTiming({ url, samples: body.samples });
    await addLog(deployment.id, "HEALTH_CHECK", `Laravel timing check sampled ${body.samples} request(s)`, undefined, { timing } as Prisma.InputJsonObject);
    return timing;
  });

  app.get("/:deploymentId/logs", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const query = z.object({ releaseId: z.string().optional(), step: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const deployment = await findDeployment(deploymentId);
    await pruneDeploymentLogs(deployment.id);
    return prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id, createdAt: { gte: deploymentLogCutoff() }, ...(query.releaseId ? { releaseId: query.releaseId } : {}), ...(query.step ? { step: query.step as any } : {}) },
      orderBy: { createdAt: "asc" },
      take: query.limit
    });
  });

  app.get("/:deploymentId/logs/export", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const query = z.object({
      type: z.enum(["build", "running"]).default("build"),
      releaseId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500)
    }).parse(request.query);
    const deployment = await findDeployment(deploymentId);
    await pruneDeploymentLogs(deployment.id);

    if (query.type === "running") {
      const runtime = await sysagent.deploymentRuntimeLogs({
        name: deployment.slug,
        logDir: deploymentLogDir(deployment.slug),
        rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
        lines: query.limit
      });
      const lines = [
        `Deployment: ${deployment.name} (${deployment.slug})`,
        `Log type: running`,
        `Runtime log directory: ${runtime.logDir ?? deploymentLogDir(deployment.slug)}`,
        `Status: ${deployment.status}`,
        `Exported: ${new Date().toISOString()}`,
        "",
        runtime.text || "No runtime logs yet."
      ];
      reply.header("content-type", "text/plain; charset=utf-8");
      return lines.join("\n");
    }

    const logs = await prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id, createdAt: { gte: deploymentLogCutoff() }, ...(query.releaseId ? { releaseId: query.releaseId } : {}) },
      orderBy: { createdAt: "asc" },
      take: query.limit
    });
    const lines = [
      `Deployment: ${deployment.name} (${deployment.slug})`,
      `Log type: build`,
      `Repository: ${deployment.githubOwner && deployment.githubRepo ? `${deployment.githubOwner}/${deployment.githubRepo}` : deployment.gitUrl ?? "manual"}`,
      `Branch: ${deployment.branch}`,
      `Status: ${deployment.status}`,
      `Exported: ${new Date().toISOString()}`,
      "",
      ...logs.map((log) => `[${log.createdAt.toISOString()}] ${log.step}: ${log.message}${logMetadataText(log.metadata)}`)
    ];
    reply.header("content-type", "text/plain; charset=utf-8");
    return lines.join("\n");
  });

  app.get("/:deploymentId/logs/stream", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const query = z.object({ step: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const deployment = await findDeployment(deploymentId);
    await pruneDeploymentLogs(deployment.id);
    let lastCreatedAt = deploymentLogCutoff();

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.hijack();

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const pushLogs = async () => {
      const logs = await prisma.deploymentLog.findMany({
        where: {
          deploymentId: deployment.id,
          createdAt: { gt: lastCreatedAt },
          ...(query.step ? { step: query.step as any } : {})
        },
        orderBy: { createdAt: "asc" },
        take: query.limit
      });
      if (logs.length > 0) {
        lastCreatedAt = logs[logs.length - 1].createdAt;
        send("logs", logs);
      } else {
        send("heartbeat", { at: new Date().toISOString() });
      }
    };

    await pushLogs();
    const interval = setInterval(() => {
      pushLogs().catch((error) => send("error", { error: error instanceof Error ? error.message : "Log stream failed" }));
    }, 2500);

    request.raw.on("close", () => {
      clearInterval(interval);
      reply.raw.end();
    });
  });

  app.get("/:deploymentId/doctor", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const result = await deploymentDoctor(deployment);
    await addLog(deployment.id, "HEALTH_CHECK", `Deployment doctor: ${result.summary}`, undefined, result as Prisma.InputJsonObject);
    return result;
  });

  app.post("/:deploymentId/doctor/repair", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = doctorRepairSchema.parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const doctor = await deploymentDoctor(deployment);
    const action = body.action === "auto" ? doctor.recommendedAction : body.action;

    if (!action) {
      await addLog(deployment.id, "HEALTH_CHECK", "Deployment doctor found no repair action to run", undefined, doctor as Prisma.InputJsonObject);
      return { action: null, doctor, message: "No repair action needed." };
    }

    if (action === "sync-runtime") {
      const result = await syncDeploymentRuntime(deployment);
      await addLog(deployment.id, "PREFLIGHT", "Deployment doctor synced runtime commands", undefined, result as unknown as Prisma.InputJsonObject);
      await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Deployment doctor synced runtime commands for ${deployment.slug}`, metadata: result as unknown as Prisma.InputJsonObject });
      return reply.code(202).send({ action, result });
    }

    if (action === "set-node-memory") {
      const result = await applyNodeMemoryEnv(deployment);
      await addLog(deployment.id, "PREFLIGHT", "Deployment doctor applied Node memory env", undefined, result as unknown as Prisma.InputJsonObject);
      await audit(request, { action: "UPDATE", resource: "deployment_env", resourceId: deployment.id, description: `Deployment doctor set NODE_OPTIONS for ${deployment.slug}`, metadata: result as unknown as Prisma.InputJsonObject });
      return reply.code(202).send({ action, result, next: "redeploy" });
    }

    if (action === "sync-public-env") {
      const result = await applyPublicUrlEnv(deployment);
      await addLog(deployment.id, "PREFLIGHT", "Deployment doctor synced public URL env", undefined, result as unknown as Prisma.InputJsonObject);
      await audit(request, { action: "UPDATE", resource: "deployment_env", resourceId: deployment.id, description: `Deployment doctor synced public URL env for ${deployment.slug}`, metadata: result as unknown as Prisma.InputJsonObject });
      return reply.code(202).send({ action, result, next: "redeploy" });
    }

    if (action === "rewrite-nginx") {
      const result = await rewriteDeploymentDomainRoute(deployment);
      await addLog(deployment.id, "HEALTH_CHECK", "Deployment doctor rewrote Nginx public route", undefined, { result } as unknown as Prisma.InputJsonObject);
      const domain = deployment.domainBindings?.find((binding) => binding.role === "primary")?.domain ?? deployment.domainBindings?.[0]?.domain ?? deployment.domain;
      const serverName = deploymentServerName(domain);
      let publicRoute: unknown = null;
      if (serverName) {
        try {
          publicRoute = await sysagent.deploymentPublicRoute({
            serverName,
            rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
            framework: deployment.framework
          });
        } catch (error) {
          publicRoute = { returncode: 1, stderr: error instanceof Error ? error.message : "Public route check failed" };
        }
      }
      if (publicRouteNeedsProcessRestart(publicRoute)) {
        await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "DEPLOYING", healthStatus: "UNKNOWN" } });
        const queue = await enqueueDeployAction(deployment.id, "restart");
        await addLog(deployment.id, "STARTING", "Deployment doctor queued restart after Nginx rewrite still returned upstream 502", undefined, { result, publicRoute, queue } as unknown as Prisma.InputJsonObject);
        await audit(request, { action: "APPLY", resource: "deployment", resourceId: deployment.id, description: `Deployment doctor rewrote Nginx and queued restart for ${deployment.slug}`, metadata: { result, publicRoute, queue } as unknown as Prisma.InputJsonObject });
        return reply.code(202).send({ action, result, publicRoute, queue, next: "restart" });
      }
      await audit(request, { action: "APPLY", resource: "deployment", resourceId: deployment.id, description: `Deployment doctor rewrote Nginx for ${deployment.slug}`, metadata: { result, publicRoute } as unknown as Prisma.InputJsonObject });
      return reply.code(202).send({ action, result, publicRoute });
    }

    if (action === "request-approval") {
      const approvals = await createDoctorApprovals(deployment.id, doctor.riskyActions);
      await addLog(deployment.id, "PREFLIGHT", "Deployment doctor risky fix needs approval", undefined, { approvals, riskyActions: doctor.riskyActions } as unknown as Prisma.InputJsonObject);
      await audit(request, { action: "CREATE", resource: "deployment_doctor_approval", resourceId: deployment.id, description: `Deployment doctor approval requested for ${deployment.slug}`, metadata: { approvals, riskyActions: doctor.riskyActions } as unknown as Prisma.InputJsonObject });
      return reply.code(202).send({ action, approvalRequired: true, approvals, riskyActions: doctor.riskyActions });
    }

    if (action === "health") {
      const result = await sysagent.deploymentHealth({
        deploymentId: deployment.id,
        port: deployment.port,
        healthUrl: deployment.healthUrl,
        processName: deployment.slug,
        processManager: deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework],
        rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
        logDir: deploymentLogDir(deployment.slug),
        strictHealth: normalizeDeploymentResourcePolicy(deployment.processConfig).healthStrict
      });
      const healthy = !commandFailed(result);
      await prisma.deployment.update({ where: { id: deployment.id }, data: { healthStatus: healthy ? "HEALTHY" : "DOWN", lastHealthCheckAt: new Date() } });
      await addLog(deployment.id, "HEALTH_CHECK", healthy ? "Deployment doctor health repair passed" : "Deployment doctor health repair failed", undefined, { result } as Prisma.InputJsonObject);
      return reply.code(202).send({ action, result, healthStatus: healthy ? "HEALTHY" : "DOWN" });
    }

    if (action === "restart") {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "DEPLOYING", healthStatus: "UNKNOWN" } });
      await addLog(deployment.id, "STARTING", "Deployment doctor queued restart", undefined, doctor as Prisma.InputJsonObject);
      const queue = await enqueueDeployAction(deployment.id, "restart");
      await audit(request, { action: "APPLY", resource: "deployment", resourceId: deployment.id, description: `Deployment doctor queued restart for ${deployment.slug}`, metadata: { queue, doctor } as Prisma.InputJsonObject });
      return reply.code(202).send({ action, queue, doctor });
    }

    if (action === "redeploy") {
      const release = await prisma.deploymentRelease.create({
        data: {
          deploymentId: deployment.id,
          status: "QUEUED",
          commitSha: null,
          sourcePath: deployment.rootPath,
          envSnapshot: deployment.envVars === null ? {} : deployment.envVars as Prisma.InputJsonValue,
          processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
        }
      });
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "QUEUED", healthStatus: "UNKNOWN" } });
      await addLog(deployment.id, "QUEUED", "Deployment doctor queued redeploy", release.id, doctor as Prisma.InputJsonObject);
      const queue = await enqueueDeployAction(deployment.id, "deploy", release.id);
      await audit(request, { action: "DEPLOY", resource: "deployment", resourceId: deployment.id, description: `Deployment doctor queued redeploy for ${deployment.slug}`, metadata: { releaseId: release.id, queue, doctor } as Prisma.InputJsonObject });
      return reply.code(202).send({ action, release, queue, doctor });
    }

    if (action === "rollback") {
      const release = await prisma.deploymentRelease.findFirstOrThrow({ where: { deploymentId: deployment.id, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" } });
      await addLog(deployment.id, "ROLLBACK", `Deployment doctor queued rollback to ${release.id}`, release.id, doctor as Prisma.InputJsonObject);
      const queue = await enqueueDeployAction(deployment.id, "rollback", release.id);
      await audit(request, { action: "APPLY", resource: "deployment", resourceId: deployment.id, description: `Deployment doctor queued rollback for ${deployment.slug}`, metadata: { releaseId: release.id, queue, doctor } as Prisma.InputJsonObject });
      return reply.code(202).send({ action, release, queue, doctor });
    }

    return reply.badRequest("Unsupported doctor repair action");
  });

  app.get("/:deploymentId/doctor/approvals", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    return prisma.deploymentDoctorApproval.findMany({
      where: { deploymentId: deployment.id },
      orderBy: { requestedAt: "desc" },
      take: 50
    });
  });

  app.post("/:deploymentId/doctor/approvals/:approvalId/reject", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const { approvalId } = approvalActionSchema.parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const existing = await prisma.deploymentDoctorApproval.findFirstOrThrow({ where: { id: approvalId, deploymentId: deployment.id } });
    const approval = await prisma.deploymentDoctorApproval.update({
      where: { id: existing.id },
      data: { status: "REJECTED", decidedAt: new Date() }
    });
    await audit(request, { action: "UPDATE", resource: "deployment_doctor_approval", resourceId: approval.id, description: `Rejected ${approval.label}` });
    return approval;
  });

  app.post("/:deploymentId/doctor/approvals/:approvalId/approve", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const { approvalId } = approvalActionSchema.parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const pending = await prisma.deploymentDoctorApproval.findFirstOrThrow({ where: { id: approvalId, deploymentId: deployment.id } });
    if (pending.status !== "PENDING" && pending.status !== "APPROVED") {
      throw app.httpErrors.badRequest(`Approval is already ${pending.status}`);
    }
    const approved = await prisma.deploymentDoctorApproval.update({
      where: { id: pending.id },
      data: { status: "APPROVED", decidedAt: new Date() }
    });
    try {
      const result = await executeDoctorApproval(deployment, approved);
      const failed = commandFailed(result);
      const updated = await prisma.deploymentDoctorApproval.update({
        where: { id: approved.id },
        data: { status: failed ? "FAILED" : "EXECUTED", executedAt: new Date(), result: result as Prisma.InputJsonValue }
      });
      await addLog(deployment.id, "PREFLIGHT", failed ? `Approved fix failed: ${approved.label}` : `Approved fix executed: ${approved.label}`, undefined, { approvalId: approved.id, result } as Prisma.InputJsonObject);
      await audit(request, { action: "APPLY", resource: "deployment_doctor_approval", resourceId: approved.id, description: `Executed approved fix ${approved.label}`, metadata: { result } as Prisma.InputJsonObject });
      return reply.code(202).send({ approval: updated, result });
    } catch (error) {
      const updated = await prisma.deploymentDoctorApproval.update({
        where: { id: approved.id },
        data: { status: "FAILED", executedAt: new Date(), result: { error: error instanceof Error ? error.message : String(error) } }
      });
      await addLog(deployment.id, "PREFLIGHT", `Approved fix errored: ${approved.label}`, undefined, { approvalId: approved.id, error: error instanceof Error ? error.message : String(error) });
      return reply.code(500).send({ approval: updated, error: error instanceof Error ? error.message : "Approval execution failed" });
    }
  });

  app.post("/:deploymentId/preflight", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const result = await preflight({
      domainId: deployment.domainId,
      rootPath: deployment.rootPath,
      port: deployment.port,
      dbType: deployment.dbType,
      gitUrl: deployment.gitUrl
    }, deployment.id);
    await addLog(deployment.id, "PREFLIGHT", result.ok ? "Preflight passed" : "Preflight has blocking checks", undefined, result);
    return result;
  });

  app.get("/:deploymentId/runtime-review", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    return deploymentRuntimeReview(deployment);
  });

  app.post("/:deploymentId/deploy", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = runtimeInstallSelectionSchema.parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const runtime = await prepareDeploymentRuntimeTools(deployment, body.approvedRuntimeTools);
    if (!runtime.ready) {
      return reply.code(409).send({ error: "Required server runtime tools need approval before deployment.", runtimeReview: runtime.review, install: runtime.install });
    }
    if (runtime.install) await addLog(deployment.id, "PREFLIGHT", "Approved runtime tools installed before deployment", undefined, runtime.install as unknown as Prisma.InputJsonObject);
    const release = await prisma.deploymentRelease.create({
      data: {
        deploymentId: deployment.id,
        status: "QUEUED",
        commitSha: null,
        sourcePath: deployment.rootPath,
        envSnapshot: deployment.envVars === null ? {} : deployment.envVars as Prisma.InputJsonValue,
        processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
      }
    });
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "QUEUED" } });
    await addLog(deployment.id, "QUEUED", "Deployment queued", release.id);
    const queue = await enqueueDeployAction(deployment.id, "deploy", release.id);
    await audit(request, { action: "DEPLOY", resource: "deployment", resourceId: deployment.id, description: `Queued deploy for ${deployment.slug}`, metadata: { releaseId: release.id } });
    return reply.code(202).send({ release, queue });
  });

  app.post("/:deploymentId/redeploy", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = runtimeInstallSelectionSchema.parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const runtime = await prepareDeploymentRuntimeTools(deployment, body.approvedRuntimeTools);
    if (!runtime.ready) {
      return reply.code(409).send({ error: "Required server runtime tools need approval before redeploy.", runtimeReview: runtime.review, install: runtime.install });
    }
    if (runtime.install) await addLog(deployment.id, "PREFLIGHT", "Approved runtime tools installed before redeploy", undefined, runtime.install as unknown as Prisma.InputJsonObject);
    const queue = await enqueueDeployAction(deployment.id, "redeploy");
    return reply.code(202).send(queue);
  });

  app.post("/:deploymentId/pull", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const queue = await enqueueDeployAction(deployment.id, "pull");
    return reply.code(202).send(queue);
  });

  app.post("/:deploymentId/rollback", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const body = z.object({ releaseId: z.string().optional() }).parse(request.body ?? {});
    const deployment = await findDeployment(deploymentId);
    const release = body.releaseId
      ? await prisma.deploymentRelease.findFirstOrThrow({ where: { id: body.releaseId, deploymentId: deployment.id } })
      : await prisma.deploymentRelease.findFirstOrThrow({ where: { deploymentId: deployment.id, status: "SUCCEEDED" }, orderBy: { createdAt: "desc" } });
    await addLog(deployment.id, "ROLLBACK", `Rollback requested to release ${release.id}`, release.id);
    const queue = await enqueueDeployAction(deployment.id, "rollback", release.id);
    return reply.code(202).send({ release, queue });
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post(`/:deploymentId/${action}`, async (request, reply) => {
      const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
      const body = runtimeInstallSelectionSchema.parse(request.body ?? {});
      const deployment = await findDeployment(deploymentId);
      if (action !== "stop") {
        const runtime = await prepareDeploymentRuntimeTools(deployment, body.approvedRuntimeTools);
        if (!runtime.ready) {
          return reply.code(409).send({ error: `Required server runtime tools need approval before ${action}.`, runtimeReview: runtime.review, install: runtime.install });
        }
        if (runtime.install) await addLog(deployment.id, "PREFLIGHT", "Approved runtime tools installed before lifecycle action", undefined, runtime.install as unknown as Prisma.InputJsonObject);
      }
      const nextStatus = action === "stop" ? "STOPPED" : "DEPLOYING";
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: nextStatus,
          healthStatus: action === "stop" ? "DOWN" : "UNKNOWN",
          lastHealthCheckAt: action === "stop" ? new Date() : deployment.lastHealthCheckAt
        }
      });
      await addLog(deployment.id, "STARTING", `${action} requested in dry-run-safe mode`, undefined, { action });
      const queue = await enqueueDeployAction(deployment.id, action);
      return reply.code(202).send({ status: nextStatus, queue });
    });
  }

  app.post("/:deploymentId/health", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const result = await sysagent.deploymentHealth({
      deploymentId: deployment.id,
      port: deployment.port,
      healthUrl: deployment.healthUrl,
      processName: deployment.slug,
      processManager: deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework],
      rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
      logDir: deploymentLogDir(deployment.slug),
      strictHealth: normalizeDeploymentResourcePolicy(deployment.processConfig).healthStrict
    });
    const healthResult = result as { dryRun?: boolean; returncode?: number; stderr?: string; stdout?: string };
    const healthy = !healthResult.dryRun && healthResult.returncode === 0;
    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        healthStatus: healthy ? "HEALTHY" : "DOWN",
        lastHealthCheckAt: new Date()
      }
    });
    await addLog(deployment.id, "HEALTH_CHECK", healthy ? "Health check passed" : "Health check failed", undefined, { result: healthResult });
    return { healthStatus: updated.healthStatus, checkedAt: updated.lastHealthCheckAt, result: healthResult };
  });

  app.post("/:deploymentId/database/provision", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    if (!deployment.dbType || !deployment.dbName || !deployment.dbUser) {
      throw app.httpErrors.badRequest("Deployment needs dbType, dbName, and dbUser before provisioning");
    }
    const result = await sysagent.provisionDatabase({
      engine: deployment.dbType,
      database: deployment.dbName,
      username: deployment.dbUser,
      passwordSecretRef: deployment.dbPasswordSecretRef
    }) as { password?: string; result?: unknown };
    const failure = commandTreeFailure(result.result);
    if (failure) throw app.httpErrors.internalServerError(`Database provision failed: ${failure}`);
    const secretRef = deployment.dbPasswordSecretRef ?? `deployment:${deployment.id}:database-password`;
    if (result.password) {
      await putSecret({
        ref: secretRef,
        value: result.password,
        kind: "DATABASE_PASSWORD",
        label: `${deployment.dbUser}@${deployment.dbName}`,
        metadata: { deploymentId: deployment.id, engine: deployment.dbType, database: deployment.dbName, username: deployment.dbUser }
      });
      if (deployment.dbPasswordSecretRef !== secretRef) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { dbPasswordSecretRef: secretRef }
        });
      }
    }
    await addLog(deployment.id, "PREFLIGHT", "Database provisioning requested", undefined, { result: result as any });
    await audit(request, { action: "APPLY", resource: "database", resourceId: deployment.id, description: `Provisioned database metadata for ${deployment.slug}`, metadata: { result: result as any } });
    return reply.code(202).send({ dryRunResult: result });
  });
};
