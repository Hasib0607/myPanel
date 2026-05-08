import { Worker } from "bullmq";
import { DeploymentFramework, DeploymentProcessManager, Prisma } from "@prisma/client";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { detectDeploymentSource } from "../lib/deploymentDetection.js";
import { prisma } from "../lib/prisma.js";
import { getSecret } from "../lib/secrets.js";
import { sysagent } from "../lib/sysagent.js";
import { sslQueue } from "./queues.js";

type DeployJobData = {
  deploymentId?: string;
  releaseId?: string;
};

type DeployStep = "PREFLIGHT" | "CLONING" | "INSTALLING" | "MIGRATING" | "BUILDING" | "CONFIGURING_PROXY" | "STARTING" | "HEALTH_CHECK" | "SUCCEEDED" | "FAILED" | "ROLLBACK";

const defaultProcessManagerByFramework: Record<DeploymentFramework, DeploymentProcessManager> = {
  LARAVEL: "SUPERVISOR",
  NEXTJS: "PM2",
  NODEJS: "PM2",
  PYTHON: "SUPERVISOR",
  GO: "SUPERVISOR",
  STATIC: "STATIC"
};

async function writeLog(deploymentId: string, releaseId: string | undefined, step: DeployStep, message: string, metadata: Prisma.InputJsonObject = {}, level = "info") {
  return prisma.deploymentLog.create({
    data: {
      deploymentId,
      releaseId,
      step,
      level,
      message,
      metadata
    }
  });
}

async function runStep<T>(deploymentId: string, releaseId: string | undefined, step: DeployStep, message: string, fn: () => Promise<T>) {
  await writeLog(deploymentId, releaseId, step, `${message} started`);
  try {
    const result = await fn();
    await writeLog(deploymentId, releaseId, step, `${message} completed`, { result: JSON.parse(JSON.stringify(result ?? null)) });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown deployment step error";
    await writeLog(deploymentId, releaseId, step, `${message} failed`, { error: detail }, "error");
    throw error;
  }
}

function assertLiveResult(result: unknown, label: string) {
  const value = result as { dryRun?: boolean; returncode?: number; stderr?: string; reason?: string };
  if (value?.dryRun) {
    throw new Error(`${label} did not run live. Set ALLOW_LIVE_SYSTEM_COMMANDS=true on vps-panel-sysagent, restart vps-panel-sysagent and vps-panel-workers, then retry.`);
  }
  if (typeof value?.returncode === "number" && value.returncode !== 0) {
    const signal = "signal" in value && typeof value.signal === "string" ? value.signal : null;
    const signalHint = value.returncode === -15 || signal === "SIGTERM"
      ? " The command was terminated by SIGTERM. This may be caused by the OS killing the process due to low memory — try adding swap or reducing build memory usage (e.g. NODE_OPTIONS=--max-old-space-size=512 in env vars). If it repeats, increase DEPLOYMENT_COMMAND_TIMEOUT_SECONDS."
      : "";
    throw new Error(`${label} failed with exit code ${value.returncode}${signal ? ` (${signal})` : ""}${value.stderr ? `: ${value.stderr}` : ""}${signalHint}`);
  }
}

async function markRelease(releaseId: string | undefined, status: "RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK", startedAt?: Date) {
  if (!releaseId) return;
  const finished = status === "SUCCEEDED" || status === "FAILED" || status === "ROLLED_BACK" ? new Date() : undefined;
  await prisma.deploymentRelease.update({
    where: { id: releaseId },
    data: {
      status,
      startedAt: startedAt ?? (status === "RUNNING" ? new Date() : undefined),
      finishedAt: finished,
      durationMs: finished && startedAt ? finished.getTime() - startedAt.getTime() : undefined
    }
  });
}

function renderDeploymentCommand(command: string | null | undefined, port: number) {
  return command?.replaceAll("{PORT}", String(port)).replaceAll("$PORT", String(port)) ?? null;
}

function githubTokenSecretRef() {
  return "github:superadmin:token";
}

async function githubCloneToken(sourceProvider: string, gitUrl: string | null) {
  if (sourceProvider !== "GITHUB" || !gitUrl?.startsWith("https://github.com/")) return null;
  return getSecret(githubTokenSecretRef());
}

async function resolveEnvVars(env: { key: string; value: string | null; secretRef: string | null }[]): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  await Promise.all(
    env.map(async (v) => {
      if (v.value !== null && v.value !== undefined) {
        resolved[v.key] = v.value;
      } else if (v.secretRef) {
        const secret = await getSecret(v.secretRef);
        if (secret !== null) resolved[v.key] = secret;
      }
    })
  );
  return resolved;
}

function assertCommandTree(result: unknown, label: string) {
  if (!result || typeof result !== "object") return;
  const value = result as { dryRun?: boolean; returncode?: number; stderr?: string; reason?: string; command?: unknown };
  if (Array.isArray(value.command) || typeof value.returncode === "number" || value.dryRun !== undefined) {
    assertLiveResult(value, label);
    return;
  }
  for (const [key, child] of Object.entries(result)) {
    if (child === null || key === "path") continue;
    assertCommandTree(child, `${label} ${key}`);
  }
}

async function processLifecycleAction(action: string, deploymentId: string, releaseId: string | undefined) {
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { domain: true, env: true } });
  const envVars = await resolveEnvVars(deployment.env);
  const processAction = action === "redeploy" || action === "deploy" ? "start" : action;
  const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];

  if (processAction !== "stop" && deployment.domain) {
    const nginxResult = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", () =>
      sysagent.deploymentNginx({
        deploymentId: deployment.id,
        serverName: deployment.domain?.name,
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        forceSsl: deployment.domain?.forceSsl ?? true
      })
    );
    assertLiveResult((nginxResult as { write?: unknown }).write, "Nginx proxy config write");
    assertLiveResult((nginxResult as { enable?: unknown }).enable, "Nginx proxy config enable");
    assertLiveResult((nginxResult as { test?: unknown }).test, "Nginx config test");
    assertLiveResult((nginxResult as { reload?: unknown }).reload, "Nginx reload");
  }

  const result = await runStep(deployment.id, releaseId, "STARTING", `${action} process`, () =>
    sysagent.deploymentProcess({
      deploymentId: deployment.id,
      name: deployment.slug,
      rootPath: deployment.rootPath,
      action: processAction,
      processManager,
      startCommand: renderDeploymentCommand(deployment.startCommand, deployment.port),
      port: deployment.port,
      env: envVars
    })
  );
  assertLiveResult(result, `${action} process`);

  if (processAction === "stop") {
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "STOPPED", healthStatus: "DOWN", lastHealthCheckAt: new Date() } });
    return { result, status: "STOPPED", healthStatus: "DOWN" };
  }

  const health = await runStep(deployment.id, releaseId, "HEALTH_CHECK", `${action} health check`, () =>
    sysagent.deploymentHealth({
      deploymentId: deployment.id,
      port: deployment.port,
      healthUrl: deployment.healthUrl
    })
  );
  assertLiveResult(health, `${action} health check`);

  await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "RUNNING", healthStatus: "HEALTHY", lastHealthCheckAt: new Date() } });
  return { result, health, status: "RUNNING", healthStatus: "HEALTHY" };
}

async function processDeploy(action: string, deploymentId: string, releaseId: string | undefined) {
  const startedAt = new Date();
  let deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { domain: true, env: true } });
  await markRelease(releaseId, "RUNNING", startedAt);
  await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "DEPLOYING" } });

  try {
    await runStep(deployment.id, releaseId, "PREFLIGHT", "Preflight", async () => ({
      rootPath: deployment.rootPath,
      port: deployment.port,
      sourceProvider: deployment.sourceProvider,
      envCount: deployment.env.length
    }));

    if (deployment.gitUrl || action === "pull") {
      const gitToken = await githubCloneToken(deployment.sourceProvider, deployment.gitUrl);
      const syncResult = await runStep(deployment.id, releaseId, "CLONING", "Source sync", () =>
        sysagent.deploymentGitSync({
          rootPath: deployment.rootPath,
          gitUrl: action === "pull" ? null : deployment.gitUrl,
          branch: deployment.branch,
          commitSha: deployment.commitSha,
          gitToken
        })
      );
      assertCommandTree(syncResult, "Source sync");
    } else {
      await writeLog(deployment.id, releaseId, "CLONING", "Source sync skipped for non-Git source", { sourceProvider: deployment.sourceProvider });
    }

    const detection = await runStep(deployment.id, releaseId, "PREFLIGHT", "Runtime detection", () =>
      detectDeploymentSource(deployment.rootPath, deployment.rootDirectory)
    );
    deployment = await prisma.deployment.update({
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
      },
      include: { domain: true, env: true }
    });

    if (deployment.processManager === "NONE" && deployment.framework !== "STATIC") {
      throw new Error(`No runnable start command found for ${deployment.slug}. Add a package.json start script or set a manual start command.`);
    }

    const envVars = await resolveEnvVars(deployment.env);

    if (deployment.installCommand || deployment.packageManager) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "BUILDING" } });
      const installResult = await runStep(deployment.id, releaseId, "INSTALLING", "Dependency install", () =>
        sysagent.deploymentInstall({
          rootPath: deployment.rootPath,
          command: renderDeploymentCommand(deployment.installCommand, deployment.port),
          packageManager: deployment.packageManager,
          env: envVars
        })
      );
      assertCommandTree(installResult, "Dependency install");
    }

    if (deployment.framework === "LARAVEL") {
      const migrateResult = await runStep(deployment.id, releaseId, "MIGRATING", "Database migration", () =>
        sysagent.deploymentMigrate({
          rootPath: deployment.rootPath,
          command: "php artisan migrate --force",
          env: envVars
        })
      );
      assertCommandTree(migrateResult, "Database migration");
    } else {
      await writeLog(deployment.id, releaseId, "MIGRATING", "Migration skipped for framework", { framework: deployment.framework });
    }

    if (deployment.buildCommand) {
      const buildResult = await runStep(deployment.id, releaseId, "BUILDING", "Build", () =>
        sysagent.deploymentBuild({
          rootPath: deployment.rootPath,
          command: renderDeploymentCommand(deployment.buildCommand, deployment.port),
          env: envVars
        })
      );
      assertCommandTree(buildResult, "Build");
    }

    const nginxResult = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", () =>
      sysagent.deploymentNginx({
        deploymentId: deployment.id,
        serverName: deployment.domain?.name,
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        forceSsl: deployment.domain?.forceSsl ?? true
      })
    );
    assertLiveResult((nginxResult as { write?: unknown }).write, "Nginx proxy config write");
    assertLiveResult((nginxResult as { enable?: unknown }).enable, "Nginx proxy config enable");
    assertLiveResult((nginxResult as { test?: unknown }).test, "Nginx config test");
    assertLiveResult((nginxResult as { reload?: unknown }).reload, "Nginx reload");

    if (deployment.domain?.forceSsl) {
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL request", () =>
        sslQueue.add("issue", {
          domainId: deployment.domain?.id,
          domain: deployment.domain?.name,
          email: `admin@${deployment.domain?.name}`,
          source: "deployment"
        })
      );
    } else {
      await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL request skipped", { reason: deployment.domain ? "Force SSL is disabled" : "No linked domain" });
    }

    const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
    const startResult = await runStep(deployment.id, releaseId, "STARTING", "Process start", () =>
      sysagent.deploymentProcess({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: deployment.rootPath,
        action: "start",
        processManager,
        startCommand: renderDeploymentCommand(deployment.startCommand, deployment.port),
        port: deployment.port,
        env: envVars
      })
    );
    assertLiveResult(startResult, "Process start");

    const health = await runStep(deployment.id, releaseId, "HEALTH_CHECK", "Health check", () =>
      sysagent.deploymentHealth({
        deploymentId: deployment.id,
        port: deployment.port,
        healthUrl: deployment.healthUrl
      })
    );
    assertLiveResult(health, "Health check");

    await markRelease(releaseId, action === "rollback" ? "ROLLED_BACK" : "SUCCEEDED", startedAt);
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "RUNNING",
        healthStatus: "HEALTHY",
        lastHealthCheckAt: new Date(),
        lastDeployAt: new Date()
      }
    });
    await writeLog(deployment.id, releaseId, action === "rollback" ? "ROLLBACK" : "SUCCEEDED", `${action} completed`, { dryRun: false });
    return { dryRun: false, completed: true, status: "RUNNING", healthStatus: "HEALTHY" };
  } catch (error) {
    await markRelease(releaseId, "FAILED", startedAt);
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "FAILED", healthStatus: "DOWN" } });
    await writeLog(deployment.id, releaseId, "FAILED", `${action} failed`, { error: error instanceof Error ? error.message : "Unknown error" }, "error");
    throw error;
  }
}

export const deployWorker = new Worker(
  "deploy",
  async (job) => {
    const data = job.data as DeployJobData;
    logger.info("deployment job received", { id: job.id, name: job.name, deploymentId: data.deploymentId });

    if (!data.deploymentId) {
      return { ignored: true, reason: "missing deployment id" };
    }

    if (["start", "stop", "restart"].includes(job.name)) {
      return processLifecycleAction(job.name, data.deploymentId, data.releaseId);
    }

    return processDeploy(job.name, data.deploymentId, data.releaseId);
  },
  { connection: redis }
);
