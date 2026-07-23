import { Prisma } from "@prisma/client";
import { deployQueue } from "../jobs/queues.js";
import { prisma } from "./prisma.js";

const removableDeployJobStates = ["wait", "delayed", "prioritized", "paused", "waiting-children"] as const;

export function deploymentProcessConfigObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function deploymentManualStopRequested(value: unknown) {
  return deploymentProcessConfigObject(value).manualStopped === true;
}

export function processConfigWithManualStop(value: unknown) {
  return {
    ...deploymentProcessConfigObject(value),
    manualStopped: true,
    manualStoppedAt: new Date().toISOString()
  };
}

export function processConfigWithoutManualStop(value: unknown) {
  const config = { ...deploymentProcessConfigObject(value) };
  delete config.manualStopped;
  delete config.manualStoppedAt;
  return config;
}

export async function cancelQueuedDeployJobsForDeployment(deploymentId: string) {
  const jobs = await deployQueue.getJobs(removableDeployJobStates as any, 0, 1000);
  const removedJobIds: string[] = [];
  for (const job of jobs) {
    const data = job.data as { deploymentId?: unknown } | undefined;
    if (data?.deploymentId !== deploymentId || job.name === "stop") continue;
    await job.remove();
    removedJobIds.push(String(job.id));
  }
  return removedJobIds;
}

export async function requestDeploymentManualStop(deploymentId: string) {
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
  const removedJobIds = await cancelQueuedDeployJobsForDeployment(deployment.id);
  const openReleases = await prisma.deploymentRelease.findMany({
    where: { deploymentId: deployment.id, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true }
  });
  const finishedAt = new Date();
  await prisma.deploymentRelease.updateMany({
    where: { deploymentId: deployment.id, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", finishedAt }
  });
  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      status: "STOPPED",
      healthStatus: "DOWN",
      autoDeployEnabled: false,
      lastHealthCheckAt: finishedAt,
      processConfig: processConfigWithManualStop(deployment.processConfig) as Prisma.InputJsonValue
    }
  });
  await prisma.deploymentLog.create({
    data: {
      deploymentId: deployment.id,
      step: "STARTING",
      level: "warn",
      message: "Manual stop requested; pending deploy work cancelled",
      metadata: {
        removedJobIds,
        cancelledReleaseIds: openReleases.map((release) => release.id),
        autoDeployDisabled: deployment.autoDeployEnabled
      } as Prisma.InputJsonObject
    }
  });
  return { deployment: updated, removedJobIds, cancelledReleaseIds: openReleases.map((release) => release.id) };
}

