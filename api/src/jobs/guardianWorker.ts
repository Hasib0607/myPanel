import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { expireGuardianIpBlocks, runGuardianAutoHeal, syncGuardianIncidentsOnly, type GuardianDiagnosis } from "../lib/guardianAutoHeal.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const staleDeploymentMs = Number(process.env.GUARDIAN_STALE_DEPLOYMENT_MS ?? 15 * 60_000);

function deploymentAppPath(rootPath: string, rootDirectory: string | null | undefined) {
  const cleanRootDirectory = (rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? `${rootPath.replace(/\/+$/, "")}/${cleanRootDirectory}` : rootPath;
}

function defaultProcessManager(framework: string) {
  if (framework === "NEXTJS" || framework === "NODEJS") return "PM2";
  if (framework === "STATIC") return "STATIC";
  return "SUPERVISOR";
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
      results.push({ deploymentId: deployment.id, healthy, stalePending });
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
      results.push({ deploymentId: deployment.id, healthy: false, stalePending });
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
