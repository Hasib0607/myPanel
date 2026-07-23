import { Prisma } from "@prisma/client";
import { deployQueue } from "../jobs/queues.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { getSecret } from "./secrets.js";
import { deploymentNeedsRecoveryDeploy } from "./deploymentAutoDeployState.js";

type GithubCommitResponse = {
  sha?: string;
  commit?: {
    message?: string;
    author?: {
      name?: string;
    } | null;
  };
};

type PollableDeployment = Awaited<ReturnType<typeof loadPollableDeployments>>[number];

const blockingDeploymentStatuses = ["QUEUED", "DEPLOYING", "BUILDING"] as const;
const activeReleaseStatuses = ["QUEUED", "RUNNING"] as const;
const skipLogCooldownMs = Number(process.env.GUARDIAN_AUTO_DEPLOY_SKIP_LOG_COOLDOWN_MS ?? 30 * 60_000);
const failedReleaseRetryCooldownMs = Number(process.env.GUARDIAN_AUTO_DEPLOY_FAILED_RELEASE_RETRY_COOLDOWN_MS ?? 10 * 60_000);

function superadminGithubTokenRef() {
  return "github:superadmin:token";
}

function accountGithubTokenRef(accountId: string) {
  return `github:account:${accountId}:token`;
}

function shaMatches(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function loadPollableDeployments() {
  return prisma.deployment.findMany({
    where: {
      autoDeployEnabled: true,
      sourceProvider: "GITHUB",
      githubOwner: { not: null },
      githubRepo: { not: null },
      branch: { not: "" }
    },
    orderBy: { updatedAt: "asc" }
  });
}

async function githubTokenForDeployment(deployment: { accountId: string | null }) {
  const ref = deployment.accountId ? accountGithubTokenRef(deployment.accountId) : superadminGithubTokenRef();
  return getSecret(ref);
}

async function githubLatestCommit(deployment: PollableDeployment, token: string | null) {
  const owner = deployment.githubOwner!;
  const repo = deployment.githubRepo!;
  const branch = deployment.branch || "main";
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": "vps-panel-auto-deploy-poller",
        "x-github-api-version": "2022-11-28"
      }
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub commit lookup failed with ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
  const data = await response.json() as GithubCommitResponse;
  if (!data.sha) throw new Error("GitHub commit lookup did not return a commit SHA");
  return {
    sha: data.sha,
    message: data.commit?.message ?? null,
    author: data.commit?.author?.name ?? "GitHub"
  };
}

async function recentlyLoggedSkip(deploymentId: string, prefix: string) {
  return prisma.deploymentLog.findFirst({
    where: {
      deploymentId,
      step: "QUEUED",
      message: { startsWith: prefix },
      createdAt: { gte: new Date(Date.now() - skipLogCooldownMs) }
    },
    select: { id: true }
  });
}

async function addPollLog(deploymentId: string, message: string, metadata: Prisma.InputJsonObject = {}, level = "info") {
  return prisma.deploymentLog.create({
    data: {
      deploymentId,
      step: "QUEUED",
      level,
      message,
      metadata
    }
  });
}

async function shouldQueueRemoteHead(deployment: PollableDeployment, remoteSha: string) {
  const recentReleases = await prisma.deploymentRelease.findMany({
    where: { deploymentId: deployment.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, status: true, commitSha: true, createdAt: true }
  });
  const activeRelease = recentReleases.find((release) => activeReleaseStatuses.includes(release.status as any));
  if (activeRelease) {
    return { queue: false, reason: `release ${activeRelease.id} is already ${activeRelease.status.toLowerCase()}` };
  }

  if (shaMatches(deployment.commitSha, remoteSha)) {
    if (deploymentNeedsRecoveryDeploy(deployment)) {
      return { queue: true, reason: `deployment records remote head but is ${deployment.status}/${deployment.healthStatus ?? "UNKNOWN"}; redeploying` };
    }
    return { queue: false, reason: "deployment already points at remote head" };
  }

  if (blockingDeploymentStatuses.includes(deployment.status as any)) {
    return { queue: false, reason: `deployment is already ${deployment.status.toLowerCase()}` };
  }

  const alreadyReleased = recentReleases.find((release) => shaMatches(release.commitSha, remoteSha) && release.status === "SUCCEEDED");
  if (alreadyReleased) {
    if (deploymentNeedsRecoveryDeploy(deployment)) {
      return { queue: true, reason: `remote head has succeeded release ${alreadyReleased.id}, but deployment is ${deployment.status}/${deployment.healthStatus ?? "UNKNOWN"}; redeploying` };
    }
    await prisma.deployment.update({ where: { id: deployment.id }, data: { commitSha: alreadyReleased.commitSha ?? remoteSha } });
    return { queue: false, reason: `remote head already deployed by release ${alreadyReleased.id}` };
  }
  const recentFailed = recentReleases.find((release) => shaMatches(release.commitSha, remoteSha) && release.status === "FAILED");
  if (recentFailed) {
    const ageMs = Date.now() - recentFailed.createdAt.getTime();
    if (ageMs < failedReleaseRetryCooldownMs) {
      return { queue: false, reason: `remote head release ${recentFailed.id} failed recently; retry cooldown active` };
    }
    return { queue: true, reason: `remote head release ${recentFailed.id} failed; retrying after cooldown` };
  }
  const alreadyKnown = recentReleases.find((release) => shaMatches(release.commitSha, remoteSha));
  if (alreadyKnown) {
    return { queue: true, reason: `remote head has ${alreadyKnown.status.toLowerCase()} release ${alreadyKnown.id}; queueing a fresh deploy` };
  }

  return { queue: true, reason: "remote head differs from deployed commit" };
}

async function queueAutoDeploy(deployment: PollableDeployment, remote: { sha: string; message: string | null; author: string | null }) {
  const release = await prisma.deploymentRelease.create({
    data: {
      deploymentId: deployment.id,
      status: "QUEUED",
      commitSha: remote.sha,
      commitMessage: remote.message,
      commitAuthor: remote.author ?? "GitHub",
      sourcePath: deployment.rootPath,
      envSnapshot: deployment.envVars === null ? {} : deployment.envVars as Prisma.InputJsonValue,
      processConfig: {
        port: deployment.port,
        processManager: deployment.processManager,
        startCommand: deployment.startCommand
      }
    }
  });
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { status: "QUEUED" }
  });
  await addPollLog(deployment.id, `Auto deploy poll queued GitHub branch ${deployment.branch}`, {
    releaseId: release.id,
    repository: `${deployment.githubOwner}/${deployment.githubRepo}`,
    branch: deployment.branch,
    commitSha: remote.sha,
    previousCommitSha: deployment.commitSha ?? null
  });

  try {
    const job = await deployQueue.add("deploy", {
      deploymentId: deployment.id,
      releaseId: release.id,
      trigger: "github_poll"
    });
    return { queued: true, releaseId: release.id, jobId: job.id };
  } catch (error) {
    await addPollLog(deployment.id, "Auto deploy poll created a release but deploy queue is unavailable", {
      releaseId: release.id,
      error: error instanceof Error ? error.message : "queue unavailable"
    }, "error");
    return { queued: false, releaseId: release.id, reason: "Deploy queue unavailable" };
  }
}

async function pollDeployment(deployment: PollableDeployment) {
  const token = await githubTokenForDeployment(deployment);
  const remote = await githubLatestCommit(deployment, token);
  const decision = await shouldQueueRemoteHead(deployment, remote.sha);
  if (!decision.queue) {
    return {
      deployment: deployment.slug,
      queued: false,
      reason: decision.reason,
      remoteSha: remote.sha,
      currentSha: deployment.commitSha ?? null
    };
  }
  const queue = await queueAutoDeploy(deployment, remote);
  return {
    deployment: deployment.slug,
    remoteSha: remote.sha,
    currentSha: deployment.commitSha ?? null,
    ...queue
  };
}

export async function runDeploymentAutoDeployPoll() {
  const deployments = await loadPollableDeployments();
  const results = [];
  for (const deployment of deployments) {
    try {
      results.push(await pollDeployment(deployment));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const prefix = "Auto deploy poll skipped";
      if (!await recentlyLoggedSkip(deployment.id, prefix)) {
        await addPollLog(deployment.id, `${prefix}: ${message}`, {
          repository: `${deployment.githubOwner}/${deployment.githubRepo}`,
          branch: deployment.branch
        }, "warn");
      }
      logger.warn("deployment auto deploy poll failed", {
        deploymentId: deployment.id,
        slug: deployment.slug,
        error: message
      });
      results.push({ deployment: deployment.slug, queued: false, error: message });
    }
  }
  return {
    checked: deployments.length,
    queued: results.filter((result) => Boolean((result as { queued?: boolean }).queued)).length,
    results
  };
}
