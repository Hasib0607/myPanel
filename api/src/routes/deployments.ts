import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { deployQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { deleteSecret, getSecret, putSecret } from "../lib/secrets.js";
import { sysagent } from "../lib/sysagent.js";

const frameworkSchema = z.enum(["LARAVEL", "NEXTJS", "NODEJS", "PYTHON", "GO", "STATIC"]);
const statusSchema = z.enum(["QUEUED", "RUNNING", "STOPPED", "DEPLOYING", "BUILDING", "FAILED"]);
const sourceProviderSchema = z.enum(["MANUAL", "GIT_URL", "GITHUB", "FILE_MANAGER", "UPLOAD"]);
const runtimeSchema = z.enum(["NODE", "PHP", "PYTHON", "GO", "STATIC"]).nullable().optional();
const packageManagerSchema = z.enum(["NPM", "PNPM", "YARN", "COMPOSER", "PIP", "UV", "GO", "NONE"]).nullable().optional();
const processManagerSchema = z.enum(["PM2", "SUPERVISOR", "SYSTEMD", "STATIC", "NONE"]).nullable().optional();

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
  healthUrl: z.string().url().nullable().optional(),
  port: z.number().int().min(3001).max(9999),
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

const preflightSchema = z.object({
  domainId: z.string().nullable().optional(),
  rootPath: z.string().min(1),
  port: z.number().int().min(3001).max(9999),
  dbType: z.enum(["POSTGRESQL", "MYSQL"]).nullable().optional(),
  gitUrl: z.string().url().nullable().optional()
});

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
    domainBindings: { include: { domain: true }, orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }] },
    env: { orderBy: { key: "asc" as const } },
    releases: { orderBy: { createdAt: "desc" as const }, take: 10 },
    logs: { orderBy: { createdAt: "desc" as const }, take: 100 }
  };
}

async function findDeployment(idOrSlug: string) {
  return prisma.deployment.findFirstOrThrow({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: includeFullDeployment()
  });
}

async function syncPrimaryDomainBinding(deploymentId: string, domainId: string | null | undefined) {
  if (!domainId) return;
  await prisma.deploymentDomain.upsert({
    where: { deploymentId_domainId: { deploymentId, domainId } },
    update: { role: "primary" },
    create: { deploymentId, domainId, role: "primary" }
  });
}

function commandSuggestions(framework: z.infer<typeof frameworkSchema>) {
  const suggestions = {
    LARAVEL: { runtime: "PHP", packageManager: "COMPOSER", installCommand: "composer install --no-dev --optimize-autoloader", buildCommand: "php artisan migrate --force", startCommand: "php-fpm", outputDirectory: "public", processManager: "SUPERVISOR" },
    NEXTJS: { runtime: "NODE", packageManager: "NPM", installCommand: "npm install", buildCommand: "npm run build", startCommand: "npm run start", outputDirectory: ".next", processManager: "PM2" },
    NODEJS: { runtime: "NODE", packageManager: "NPM", installCommand: "npm install", buildCommand: "npm run build", startCommand: "npm run start", outputDirectory: "dist", processManager: "PM2" },
    PYTHON: { runtime: "PYTHON", packageManager: "PIP", installCommand: "pip install -r requirements.txt", buildCommand: null, startCommand: "uvicorn app.main:app --host 127.0.0.1", outputDirectory: null, processManager: "SUPERVISOR" },
    GO: { runtime: "GO", packageManager: "GO", installCommand: "go mod download", buildCommand: "go build -o app", startCommand: "./app", outputDirectory: ".", processManager: "SUPERVISOR" },
    STATIC: { runtime: "STATIC", packageManager: "NONE", installCommand: null, buildCommand: null, startCommand: null, outputDirectory: ".", processManager: "STATIC" }
  } as const;
  return suggestions[framework];
}

async function detectFramework(input: z.infer<typeof detectSchema>) {
  let files = input.files ?? [];
  if (input.rootPath) {
    try {
      files = await fs.readdir(input.rootPath);
    } catch {
      return { detected: "STATIC", confidence: 0.2, reason: "Path is not readable locally", suggestions: commandSuggestions("STATIC") };
    }
  }

  const names = new Set(files.map((file) => file.toLowerCase()));
  if (names.has("artisan") || names.has("composer.json")) return { detected: "LARAVEL", confidence: 0.85, reason: "Found PHP/Laravel markers", suggestions: commandSuggestions("LARAVEL") };
  if (names.has("next.config.js") || names.has("next.config.mjs") || names.has("next.config.ts")) return { detected: "NEXTJS", confidence: 0.95, reason: "Found Next.js config", suggestions: commandSuggestions("NEXTJS") };
  if (names.has("package.json")) return { detected: "NODEJS", confidence: 0.75, reason: "Found package.json", suggestions: commandSuggestions("NODEJS") };
  if (names.has("requirements.txt") || names.has("pyproject.toml") || names.has("manage.py")) return { detected: "PYTHON", confidence: 0.8, reason: "Found Python markers", suggestions: commandSuggestions("PYTHON") };
  if (names.has("go.mod")) return { detected: "GO", confidence: 0.9, reason: "Found go.mod", suggestions: commandSuggestions("GO") };
  if (names.has("index.html")) return { detected: "STATIC", confidence: 0.85, reason: "Found index.html", suggestions: commandSuggestions("STATIC") };
  return { detected: "STATIC", confidence: 0.35, reason: "No framework markers found", suggestions: commandSuggestions("STATIC") };
}

async function nextAvailablePort() {
  const deployments = await prisma.deployment.findMany({ select: { port: true }, orderBy: { port: "asc" } });
  const used = new Set(deployments.map((deployment) => deployment.port));
  for (let port = 3001; port <= 9999; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error("No available deployment ports");
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
  checks.push({ key: "port", label: "Port", ok: !portOwner, detail: portOwner ? `Port used by ${portOwner.name}` : "Port is available in panel metadata" });

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

async function normalizeEnvSecret(deploymentSlug: string, item: z.infer<typeof envVarSchema>) {
  if (!item.isSecret) {
    if (item.secretRef) await deleteSecret(item.secretRef);
    return { value: item.value ?? null, isSecret: false, secretRef: null };
  }

  const secretRef = item.secretRef ?? deploymentEnvSecretRef(deploymentSlug, item.key);
  if (typeof item.value === "string") {
    await putSecret({
      ref: secretRef,
      value: item.value,
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

function logMetadataText(metadata: Prisma.JsonValue | null) {
  if (!metadata) return "";
  try {
    return `\n${JSON.stringify(metadata, null, 2)}`;
  } catch {
    return "";
  }
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
        include: { domain: true, domainBindings: { include: { domain: true }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] }, releases: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { releases: true, logs: true, env: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      prisma.deployment.count({ where })
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
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
    if (typeof body.token === "string") {
      await putSecret({
        ref: tokenSecretRef,
        value: body.token,
        kind: "GITHUB_TOKEN",
        label: body.username ? `${body.username} GitHub token` : "GitHub token",
        metadata: { username: body.username ?? null, scopes: body.scopes }
      });
    } else if (body.token === null) {
      await deleteSecret(tokenSecretRef);
    }
    const connection = await prisma.gitHubConnection.upsert({
      where: { id: "superadmin" },
      update: {
        username: body.username ?? undefined,
        tokenSecretRef: typeof body.token === "string" ? tokenSecretRef : body.token === null ? null : undefined,
        installationId: body.installationId ?? undefined,
        scopes: body.scopes,
        connectedAt: body.token || body.installationId ? new Date() : undefined
      },
      create: {
        id: "superadmin",
        username: body.username ?? undefined,
        tokenSecretRef: typeof body.token === "string" ? tokenSecretRef : undefined,
        installationId: body.installationId ?? undefined,
        scopes: body.scopes,
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
    return {
      repository: `${params.owner}/${params.repo}`,
      dryRun: false,
      ...(await detectFramework({ files }))
    };
  });

  app.post("/github/import", async (request, reply) => {
    const body = baseDeploymentSchema.extend({
      githubOwner: z.string(),
      githubRepo: z.string(),
      rootPath: z.string().optional(),
      port: z.number().int().min(3001).max(9999).optional()
    }).parse(request.body);
    const port = body.port ?? await nextAvailablePort();
    const rootPath = body.rootPath ?? path.join("D:/Projects/Cpanel/.local-www", body.githubRepo);
    const existingDeployment = await prisma.deployment.findFirst({
      where: {
        sourceProvider: "GITHUB",
        githubOwner: { equals: body.githubOwner, mode: "insensitive" },
        githubRepo: { equals: body.githubRepo, mode: "insensitive" }
      }
    });

    const deployment = existingDeployment
      ? await prisma.deployment.update({
          where: { id: existingDeployment.id },
          data: {
            ...body,
            slug: await uniqueDeploymentSlug(body.slug || body.name || body.githubRepo, existingDeployment.id),
            sourceProvider: "GITHUB",
            gitUrl: body.gitUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}.git`,
            repoUrl: body.repoUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}`,
            rootPath,
            port: body.port ?? existingDeployment.port,
            status: "STOPPED"
          }
        })
      : await prisma.deployment.create({
          data: {
            ...body,
            slug: await uniqueDeploymentSlug(body.slug || body.name || body.githubRepo),
            sourceProvider: "GITHUB",
            gitUrl: body.gitUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}.git`,
            repoUrl: body.repoUrl ?? `https://github.com/${body.githubOwner}/${body.githubRepo}`,
            rootPath,
            port,
            status: "STOPPED"
          }
        });
    await addLog(deployment.id, "QUEUED", existingDeployment ? "GitHub project settings refreshed" : "GitHub project imported", undefined, {
      repository: `${body.githubOwner}/${body.githubRepo}`,
      branch: body.branch,
      rootPath,
      autoDeployEnabled: body.autoDeployEnabled
    });
    await syncPrimaryDomainBinding(deployment.id, deployment.domainId);
    return reply.code(existingDeployment ? 200 : 201).send(await findDeployment(deployment.id));
  });

  app.post("/", async (request, reply) => {
    const body = baseDeploymentSchema.parse(request.body);
    const deployment = await prisma.deployment.create({
      data: {
        ...body,
        slug: await uniqueDeploymentSlug(body.slug || body.name),
        status: "STOPPED",
        env: {
          create: Object.entries(body.envVars).map(([key, value]) => ({ key, value, isSecret: false }))
        }
      }
    });
    await syncPrimaryDomainBinding(deployment.id, deployment.domainId);
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
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        ...body,
        slug: body.slug ?? undefined
      }
    });
    await syncPrimaryDomainBinding(deployment.id, body.domainId);
    return findDeployment(deployment.id);
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
    await prisma.domain.findUniqueOrThrow({ where: { id: body.domainId } });
    const binding = await prisma.deploymentDomain.upsert({
      where: { deploymentId_domainId: { deploymentId: deployment.id, domainId: body.domainId } },
      update: { role: body.primary ? "primary" : "alias" },
      create: { deploymentId: deployment.id, domainId: body.domainId, role: body.primary ? "primary" : "alias" },
      include: { domain: true }
    });
    if (body.primary || !deployment.domainId) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: body.domainId } });
      await prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id, domainId: { not: body.domainId }, role: "primary" }, data: { role: "alias" } });
    }
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Bound domain ${binding.domain.name} to ${deployment.slug}` });
    return reply.code(201).send(binding);
  });

  app.patch("/:deploymentId/domains/:domainId/primary", async (request) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const binding = await prisma.deploymentDomain.findUniqueOrThrow({
      where: { deploymentId_domainId: { deploymentId: deployment.id, domainId } },
      include: { domain: true }
    });
    await prisma.$transaction([
      prisma.deployment.update({ where: { id: deployment.id }, data: { domainId } }),
      prisma.deploymentDomain.updateMany({ where: { deploymentId: deployment.id }, data: { role: "alias" } }),
      prisma.deploymentDomain.update({ where: { id: binding.id }, data: { role: "primary" } })
    ]);
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Set primary domain ${binding.domain.name} for ${deployment.slug}` });
    return { ok: true };
  });

  app.delete("/:deploymentId/domains/:domainId", async (request) => {
    const { deploymentId, domainId } = z.object({ deploymentId: z.string(), domainId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    await prisma.deploymentDomain.delete({ where: { deploymentId_domainId: { deploymentId: deployment.id, domainId } } });
    if (deployment.domainId === domainId) {
      const next = await prisma.deploymentDomain.findFirst({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "asc" } });
      await prisma.deployment.update({ where: { id: deployment.id }, data: { domainId: next?.domainId ?? null } });
      if (next) await prisma.deploymentDomain.update({ where: { id: next.id }, data: { role: "primary" } });
    }
    await audit(request, { action: "UPDATE", resource: "deployment", resourceId: deployment.id, description: `Removed a domain from ${deployment.slug}` });
    return { ok: true };
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
    const env = await prisma.deploymentEnvVar.findMany({ where: { deploymentId: deployment.id }, orderBy: { key: "asc" } });
    return env.map((item) => ({ ...item, value: item.isSecret ? null : item.value, masked: item.isSecret }));
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
    for (const item of body.env) {
      const normalized = await normalizeEnvSecret(deployment.slug, item);
      results.push(await prisma.deploymentEnvVar.upsert({
        where: { deploymentId_key: { deploymentId: deployment.id, key: item.key } },
        update: normalized,
        create: { deploymentId: deployment.id, key: item.key, ...normalized }
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

  app.get("/:deploymentId/releases", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    return prisma.deploymentRelease.findMany({ where: { deploymentId: deployment.id }, orderBy: { createdAt: "desc" }, include: { logs: { orderBy: { createdAt: "asc" } } } });
  });

  app.get("/:deploymentId/logs", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const query = z.object({ releaseId: z.string().optional(), step: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const deployment = await findDeployment(deploymentId);
    return prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id, ...(query.releaseId ? { releaseId: query.releaseId } : {}), ...(query.step ? { step: query.step as any } : {}) },
      orderBy: { createdAt: "asc" },
      take: query.limit
    });
  });

  app.get("/:deploymentId/logs/export", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const query = z.object({ releaseId: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(500) }).parse(request.query);
    const deployment = await findDeployment(deploymentId);
    const logs = await prisma.deploymentLog.findMany({
      where: { deploymentId: deployment.id, ...(query.releaseId ? { releaseId: query.releaseId } : {}) },
      orderBy: { createdAt: "asc" },
      take: query.limit
    });
    const lines = [
      `Deployment: ${deployment.name} (${deployment.slug})`,
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
    let lastCreatedAt = new Date(0);

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

  app.post("/:deploymentId/deploy", async (request, reply) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const release = await prisma.deploymentRelease.create({
      data: {
        deploymentId: deployment.id,
        status: "QUEUED",
        commitSha: deployment.commitSha,
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
    const deployment = await findDeployment(deploymentId);
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
      const deployment = await findDeployment(deploymentId);
      const nextStatus = action === "stop" ? "STOPPED" : "RUNNING";
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: nextStatus } });
      await addLog(deployment.id, "STARTING", `${action} requested in dry-run-safe mode`, undefined, { action });
      const queue = await enqueueDeployAction(deployment.id, action);
      return reply.code(202).send({ status: nextStatus, queue });
    });
  }

  app.post("/:deploymentId/health", async (request) => {
    const { deploymentId } = z.object({ deploymentId: z.string() }).parse(request.params);
    const deployment = await findDeployment(deploymentId);
    const healthy = deployment.status === "RUNNING";
    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        healthStatus: healthy ? "HEALTHY" : "UNKNOWN",
        lastHealthCheckAt: new Date()
      }
    });
    await addLog(deployment.id, "HEALTH_CHECK", healthy ? "Health check passed from metadata" : "Health check pending runtime integration", undefined, { dryRun: true });
    return { healthStatus: updated.healthStatus, checkedAt: updated.lastHealthCheckAt, dryRun: true };
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
    });
    await addLog(deployment.id, "PREFLIGHT", "Database provisioning requested", undefined, { result: result as any });
    await audit(request, { action: "APPLY", resource: "database", resourceId: deployment.id, description: `Provisioned database metadata for ${deployment.slug}`, metadata: { result: result as any } });
    return reply.code(202).send({ dryRunResult: result });
  });
};
