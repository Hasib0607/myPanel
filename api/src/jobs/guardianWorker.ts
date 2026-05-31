import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { expireGuardianIpBlocks, runGuardianAutoHeal, syncGuardianIncidentsOnly, type GuardianDiagnosis } from "../lib/guardianAutoHeal.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

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
    where: { OR: [{ status: "FAILED" }, { healthStatus: { in: ["DOWN", "DEGRADED", "UNKNOWN"] } }] },
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
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { healthStatus: healthy ? "HEALTHY" : "DOWN", lastHealthCheckAt: new Date() }
      });
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "HEALTH_CHECK",
          level: healthy ? "info" : "warn",
          message: healthy ? "Scheduled deployment watch passed" : "Scheduled deployment watch failed",
          metadata: { result } as any
        }
      });
      results.push({ deploymentId: deployment.id, healthy });
    } catch (error) {
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "HEALTH_CHECK",
          level: "error",
          message: "Scheduled deployment watch errored",
          metadata: { error: error instanceof Error ? error.message : String(error) }
        }
      });
      results.push({ deploymentId: deployment.id, healthy: false });
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
