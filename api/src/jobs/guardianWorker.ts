import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { expireGuardianIpBlocks, runGuardianAutoHeal, syncGuardianIncidentsOnly, type GuardianDiagnosis } from "../lib/guardianAutoHeal.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";
import { deployQueue } from "./queues.js";

const staleDeploymentMs = Number(process.env.GUARDIAN_STALE_DEPLOYMENT_MS ?? 15 * 60_000);
const autoDeployRepairEnabled = process.env.GUARDIAN_AUTO_DEPLOY_REPAIR !== "false";
const autoDeployCooldownMs = Number(process.env.GUARDIAN_AUTO_DEPLOY_COOLDOWN_MS ?? 30 * 60_000);
const autoDeployMaxAttempts = Number(process.env.GUARDIAN_AUTO_DEPLOY_MAX_ATTEMPTS_PER_HOUR ?? 2);

function deploymentAppPath(rootPath: string, rootDirectory: string | null | undefined) {
  const cleanRootDirectory = (rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? `${rootPath.replace(/\/+$/, "")}/${cleanRootDirectory}` : rootPath;
}

function defaultProcessManager(framework: string) {
  if (framework === "NEXTJS" || framework === "NODEJS") return "PM2";
  if (framework === "STATIC") return "STATIC";
  return "SUPERVISOR";
}

async function recentlyQueuedAutoRepair(deploymentId: string) {
  const since = new Date(Date.now() - autoDeployCooldownMs);
  return prisma.deploymentLog.findFirst({
    where: {
      deploymentId,
      step: "QUEUED",
      message: { startsWith: "Guardian queued auto" },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" }
  });
}

async function hourlyAutoRepairAttempts(deploymentId: string) {
  return prisma.deploymentLog.count({
    where: {
      deploymentId,
      step: "QUEUED",
      message: { startsWith: "Guardian queued auto" },
      createdAt: { gte: new Date(Date.now() - 60 * 60_000) }
    }
  });
}

async function hasPendingDoctorApproval(deploymentId: string) {
  const pending = await prisma.deploymentDoctorApproval.findFirst({
    where: { deploymentId, status: "PENDING" },
    select: { id: true, actionKey: true }
  });
  return pending;
}

async function queueGuardianDeployRepair(deployment: Awaited<ReturnType<typeof prisma.deployment.findMany>>[number], action: "restart" | "deploy", reason: string) {
  if (!autoDeployRepairEnabled) return { queued: false, reason: "auto deploy repair disabled" };

  const pendingApproval = await hasPendingDoctorApproval(deployment.id);
  if (pendingApproval) return { queued: false, reason: `pending approval ${pendingApproval.actionKey}` };

  const recent = await recentlyQueuedAutoRepair(deployment.id);
  if (recent) return { queued: false, reason: "cooldown active", recentLogId: recent.id };

  const attempts = await hourlyAutoRepairAttempts(deployment.id);
  if (attempts >= autoDeployMaxAttempts) return { queued: false, reason: `max hourly attempts reached (${attempts}/${autoDeployMaxAttempts})` };

  let releaseId: string | undefined;
  if (action === "deploy") {
    const release = await prisma.deploymentRelease.create({
      data: {
        deploymentId: deployment.id,
        status: "QUEUED",
        commitSha: deployment.commitSha,
        sourcePath: deployment.rootPath,
        envSnapshot: deployment.envVars as any,
        processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
      }
    });
    releaseId = release.id;
  }

  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { status: action === "deploy" ? "QUEUED" : "DEPLOYING", healthStatus: "UNKNOWN" }
  });
  await prisma.deploymentLog.create({
    data: {
      deploymentId: deployment.id,
      releaseId,
      step: "QUEUED",
      message: action === "deploy" ? "Guardian queued auto redeploy" : "Guardian queued auto restart",
      metadata: { reason, attempts: attempts + 1, cooldownMs: autoDeployCooldownMs } as any
    }
  });
  const job = await deployQueue.add(action, { deploymentId: deployment.id, releaseId });
  return { queued: true, action, releaseId, jobId: job.id };
}

async function runDeploymentWatch() {
  const deployments = await prisma.deployment.findMany({
    where: {
      OR: [
        { status: "FAILED" },
        { healthStatus: { in: ["DOWN", "DEGRADED", "UNKNOWN"] } },
        { status: { in: ["DEPLOYING", "BUILDING", "QUEUED"] }, updatedAt: { lte: new Date(Date.now() - staleDeploymentMs) } }
      ]
    },
    orderBy: { updatedAt: "desc" },
    take: 25
  });
  const results = [];
  for (const deployment of deployments) {
    try {
      const result = await sysagent.deploymentHealth({
        deploymentId: deployment.id,
        port: deployment.port,
        healthUrl: deployment.healthUrl,
        processName: deployment.slug,
        processManager: deployment.processManager ?? defaultProcessManager(deployment.framework),
        rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory)
      }) as { dryRun?: boolean; returncode?: number; stderr?: string; stdout?: string };
      const healthy = !result.dryRun && result.returncode === 0;
      const stalePending = ["DEPLOYING", "BUILDING", "QUEUED"].includes(deployment.status) && Date.now() - deployment.updatedAt.getTime() >= staleDeploymentMs;
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: healthy ? "RUNNING" : stalePending ? "FAILED" : deployment.status,
          healthStatus: healthy ? "HEALTHY" : "DOWN",
          lastHealthCheckAt: new Date()
        }
      });
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "HEALTH_CHECK",
          level: healthy ? "info" : "warn",
          message: healthy
            ? "Scheduled deployment watch passed"
            : stalePending
              ? "Scheduled deployment watch marked stale deployment as failed"
              : "Scheduled deployment watch failed",
          metadata: { result, stalePending } as any
        }
      });
      let autoRepair = null;
      if (!healthy) {
        const shouldRedeploy = stalePending || deployment.status === "FAILED";
        const shouldRestart = !shouldRedeploy && deployment.status === "RUNNING";
        if (shouldRedeploy || shouldRestart) {
          autoRepair = await queueGuardianDeployRepair(
            deployment,
            shouldRedeploy ? "deploy" : "restart",
            stalePending ? "stale deployment did not finish" : deployment.status === "FAILED" ? "deployment is failed" : "running deployment health check failed"
          );
        }
      }
      results.push({ deploymentId: deployment.id, healthy, stalePending, autoRepair });
    } catch (error) {
      const stalePending = ["DEPLOYING", "BUILDING", "QUEUED"].includes(deployment.status) && Date.now() - deployment.updatedAt.getTime() >= staleDeploymentMs;
      if (stalePending) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: "FAILED", healthStatus: "DOWN", lastHealthCheckAt: new Date() }
        });
      }
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "HEALTH_CHECK",
          level: "error",
          message: stalePending ? "Scheduled deployment watch marked stale deployment as failed after error" : "Scheduled deployment watch errored",
          metadata: { error: error instanceof Error ? error.message : String(error), stalePending } as any
        }
      });
      let autoRepair = null;
      if (stalePending || deployment.status === "FAILED") {
        autoRepair = await queueGuardianDeployRepair(
          deployment,
          "deploy",
          stalePending ? "stale deployment watch errored" : "failed deployment watch errored"
        );
      }
      results.push({ deploymentId: deployment.id, healthy: false, stalePending, autoRepair });
    }
  }
  return { checked: results.length, results };
}

export const guardianWorker = new Worker(
  "guardian",
  async (job) => {
    logger.info("guardian job received", { id: job.id, name: job.name });
    if (job.name === "deployment-watch") {
      return runDeploymentWatch();
    }

    const diagnosis = await sysagent.guardianDiagnosis() as GuardianDiagnosis;
    if (diagnosis.unavailable) throw new Error("Guardian diagnosis is unavailable");

    if (job.name === "diagnose") {
      await syncGuardianIncidentsOnly(diagnosis);
      const expired = await expireGuardianIpBlocks();
      return { incidents: diagnosis.incidents?.length ?? 0, expiredBlocks: expired.length };
    }

    if (job.name === "auto-heal") {
      const [healing, expired] = await Promise.all([
        runGuardianAutoHeal(diagnosis),
        expireGuardianIpBlocks()
      ]);
      return { ...healing, expiredBlocks: expired.length };
    }

    throw new Error(`Unknown guardian job: ${job.name}`);
  },
  { connection: redis }
);
