import { Worker } from "bullmq";
import { Prisma } from "@prisma/client";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";
import { sslQueue } from "./queues.js";

type DeployJobData = {
  deploymentId?: string;
  releaseId?: string;
};

type DeployStep = "PREFLIGHT" | "CLONING" | "INSTALLING" | "MIGRATING" | "BUILDING" | "CONFIGURING_PROXY" | "STARTING" | "HEALTH_CHECK" | "SUCCEEDED" | "FAILED" | "ROLLBACK";

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

async function processLifecycleAction(action: string, deploymentId: string, releaseId: string | undefined) {
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { domain: true } });
  const processAction = action === "redeploy" || action === "deploy" ? "start" : action;
  const result = await runStep(deployment.id, releaseId, "STARTING", `${action} process`, () =>
    sysagent.deploymentProcess({
      deploymentId: deployment.id,
      name: deployment.slug,
      rootPath: deployment.rootPath,
      action: processAction,
      processManager: deployment.processManager,
      startCommand: deployment.startCommand,
      port: deployment.port
    })
  );
  const nextStatus = action === "stop" ? "STOPPED" : "RUNNING";
  await prisma.deployment.update({ where: { id: deployment.id }, data: { status: nextStatus } });
  return { result, status: nextStatus };
}

async function processDeploy(action: string, deploymentId: string, releaseId: string | undefined) {
  const startedAt = new Date();
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { domain: true, env: true } });
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
      await runStep(deployment.id, releaseId, "CLONING", "Source sync", () =>
        sysagent.deploymentGitSync({
          rootPath: deployment.rootPath,
          gitUrl: action === "pull" ? null : deployment.gitUrl,
          branch: deployment.branch,
          commitSha: deployment.commitSha
        })
      );
    } else {
      await writeLog(deployment.id, releaseId, "CLONING", "Source sync skipped for non-Git source", { sourceProvider: deployment.sourceProvider });
    }

    if (deployment.installCommand || deployment.packageManager) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "BUILDING" } });
      await runStep(deployment.id, releaseId, "INSTALLING", "Dependency install", () =>
        sysagent.deploymentInstall({
          rootPath: deployment.rootPath,
          command: deployment.installCommand,
          packageManager: deployment.packageManager
        })
      );
    }

    if (deployment.framework === "LARAVEL") {
      await runStep(deployment.id, releaseId, "MIGRATING", "Database migration", () =>
        sysagent.deploymentMigrate({
          rootPath: deployment.rootPath,
          command: "php artisan migrate --force"
        })
      );
    } else {
      await writeLog(deployment.id, releaseId, "MIGRATING", "Migration skipped for framework", { framework: deployment.framework });
    }

    if (deployment.buildCommand) {
      await runStep(deployment.id, releaseId, "BUILDING", "Build", () =>
        sysagent.deploymentBuild({
          rootPath: deployment.rootPath,
          command: deployment.buildCommand
        })
      );
    }

    await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", () =>
      sysagent.deploymentNginx({
        deploymentId: deployment.id,
        serverName: deployment.domain?.name,
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        forceSsl: deployment.domain?.forceSsl ?? true
      })
    );

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

    await runStep(deployment.id, releaseId, "STARTING", "Process start", () =>
      sysagent.deploymentProcess({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: deployment.rootPath,
        action: "start",
        processManager: deployment.processManager,
        startCommand: deployment.startCommand,
        port: deployment.port
      })
    );

    await runStep(deployment.id, releaseId, "HEALTH_CHECK", "Health check", () =>
      sysagent.deploymentHealth({
        deploymentId: deployment.id,
        port: deployment.port,
        healthUrl: deployment.healthUrl
      })
    );

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
    await writeLog(deployment.id, releaseId, action === "rollback" ? "ROLLBACK" : "SUCCEEDED", `${action} completed`, { dryRun: true });
    return { dryRun: true, completed: true, status: "RUNNING" };
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
