import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { deployQueue } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { getSecret } from "../lib/secrets.js";

const panelUpdateService = "vps-panel-self-update";

type ParsedJsonWithRaw = {
  payload: unknown;
  rawBody: Buffer;
};

type PanelUpdateStatus = {
  state?: string;
  message?: string;
  branch?: string;
  commit?: string;
  commitSubject?: string;
  updatedAt?: string | null;
  logFile?: string;
  [key: string]: unknown;
};

type CurrentPanelSource = {
  commit: string;
  commitSubject: string;
  branch: string;
};

function webhookSecretRef(deploymentSlug: string) {
  return `deployment:${deploymentSlug}:webhook`;
}

function timingSafeEqualText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function githubSignature(secret: string, rawBody: Buffer) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function addWebhookLog(deploymentId: string, message: string, metadata: Prisma.InputJsonObject = {}) {
  return prisma.deploymentLog.create({
    data: {
      deploymentId,
      step: "QUEUED",
      message,
      metadata
    }
  });
}

async function enqueueDeploy(deploymentId: string, releaseId: string) {
  try {
    const job = await Promise.race([
      deployQueue.add("deploy", { deploymentId, releaseId, trigger: "github_push" }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Deploy queue timed out")), 2000);
      })
    ]);
    return { queued: true, jobId: job.id };
  } catch (error) {
    await addWebhookLog(deploymentId, "GitHub push received but deploy queue is unavailable", {
      dryRun: true,
      error: error instanceof Error ? error.message : "queue unavailable"
    });
    return { queued: false, dryRun: true, reason: "Deploy queue unavailable" };
  }
}

const githubPushSchema = z.object({
  ref: z.string(),
  after: z.string().nullable().optional(),
  repository: z.object({
    full_name: z.string(),
    name: z.string(),
    owner: z.object({
      name: z.string().optional(),
      login: z.string().optional()
    }).passthrough()
  }).passthrough(),
  head_commit: z.object({
    id: z.string().optional(),
    message: z.string().optional(),
    author: z.object({ name: z.string().optional() }).optional()
  }).nullable().optional()
}).passthrough();

function githubBranch(ref: string) {
  return ref.replace(/^refs\/heads\//, "");
}

function configuredPanelUpdateScript() {
  const appDir = path.resolve(env.PANEL_UPDATE_WORKDIR);
  const script = path.resolve(env.PANEL_UPDATE_SCRIPT ?? path.join(appDir, "scripts/deploy/update-panel.sh"));
  const relative = path.relative(appDir, script);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Panel update script must live inside PANEL_UPDATE_WORKDIR");
  }
  fs.accessSync(script, fs.constants.R_OK);
  return { appDir, script };
}

async function spawnPanelUpdate() {
  const { appDir, script } = configuredPanelUpdateScript();
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("sudo", ["-n", "systemctl", "start", panelUpdateService], {
        cwd: appDir,
        timeout: 5000,
        env: {
          ...process.env,
          PANEL_UPDATE_WORKDIR: appDir,
          PANEL_UPDATE_BRANCH: env.PANEL_UPDATE_BRANCH
        }
      }, (error) => {
        if (error) reject(error);
        else resolve();
      });
      child.unref();
    });
    return { service: panelUpdateService, pid: null };
  } catch (error) {
    throw new Error(`Could not start ${panelUpdateService}. Run the installer to write the service and sudoers policy. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

async function startPanelUpdate(source: string, commit = "", commitSubject = "") {
  await recoverStalePanelUpdateProcess();
  await writePanelUpdateStatus({
    state: "queued",
    message: `${source}; starting panel update`,
    commit,
    commitSubject
  });
  const result = await spawnPanelUpdate();
  if (result.pid || result.service) {
    await writePanelUpdateStatus({
      state: "running",
      message: result.service ? `panel update service ${result.service} started` : `panel update process started with pid ${result.pid ?? "unknown"}`,
      commit,
      commitSubject,
      pid: result.pid
    });
  }
  return result.pid;
}

async function writePanelUpdateStatus(status: PanelUpdateStatus) {
  await fsPromises.mkdir(path.dirname(env.PANEL_UPDATE_STATUS_FILE), { recursive: true });
  await fsPromises.writeFile(env.PANEL_UPDATE_STATUS_FILE, `${JSON.stringify({
    branch: env.PANEL_UPDATE_BRANCH,
    logFile: env.PANEL_UPDATE_LOG_FILE,
    updatedAt: new Date().toISOString(),
    ...status
  })}\n`);
}

function pidIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPanelUpdatePid(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // The process may not be a process-group leader, so fall back to the direct pid.
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function readPanelUpdateStatus() {
  return fsPromises.readFile(env.PANEL_UPDATE_STATUS_FILE, "utf8")
    .then((content) => JSON.parse(content) as PanelUpdateStatus)
    .catch(() => null);
}

async function recoverStalePanelUpdateProcess() {
  const status = await readPanelUpdateStatus();
  const runningLike = status?.state === "running" || status?.state === "queued";
  const updatedAt = status?.updatedAt ? new Date(status.updatedAt).getTime() : 0;
  const ageMs = updatedAt ? Date.now() - updatedAt : 0;
  const stale = runningLike && Number.isFinite(ageMs) && ageMs > env.PANEL_UPDATE_STALE_AFTER_SECONDS * 1000;
  if (!stale) return false;

  const rawPid = await fsPromises.readFile(env.PANEL_UPDATE_PID_FILE, "utf8").catch(() => "");
  const pid = Number.parseInt(rawPid, 10);
  if (Number.isFinite(pid) && pid > 1 && pidIsRunning(pid)) {
    signalPanelUpdatePid(pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (pidIsRunning(pid)) {
      signalPanelUpdatePid(pid, "SIGKILL");
    }
  }

  await fsPromises.rm(env.PANEL_UPDATE_PID_FILE, { force: true }).catch(() => undefined);
  await writePanelUpdateStatus({
    state: "failed",
    message: `stale panel update recovered after ${Math.round(ageMs / 60000)} minutes`,
    branch: status?.branch,
    commit: typeof status?.commit === "string" ? status.commit : "",
    commitSubject: typeof status?.commitSubject === "string" ? status.commitSubject : "",
    staleRecovered: true
  });
  return true;
}

function gitCommitSubject(commit: string | undefined) {
  if (!commit || !/^[a-f0-9]{7,40}$/i.test(commit)) return Promise.resolve("");
  return new Promise<string>((resolve) => {
    execFile(
      "git",
      ["show", "-s", "--format=%s", commit],
      { cwd: env.PANEL_UPDATE_WORKDIR, timeout: 3000 },
      (error, stdout) => resolve(error ? "" : stdout.trim())
    );
  });
}

function gitCurrentSource() {
  return new Promise<CurrentPanelSource>((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--short", "HEAD"],
      { cwd: env.PANEL_UPDATE_WORKDIR, timeout: 3000 },
      (commitError, commitStdout) => {
        execFile(
          "git",
          ["log", "-1", "--pretty=%s"],
          { cwd: env.PANEL_UPDATE_WORKDIR, timeout: 3000 },
          (_subjectError, subjectStdout) => {
            execFile(
              "git",
              ["branch", "--show-current"],
              { cwd: env.PANEL_UPDATE_WORKDIR, timeout: 3000 },
              (_branchError, branchStdout) => resolve({
                commit: commitError ? "" : commitStdout.trim(),
                commitSubject: subjectStdout.trim(),
                branch: branchStdout.trim()
              })
            );
          }
        );
      }
    );
  });
}

export const deploymentWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    try {
      const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
      done(null, { payload, rawBody } satisfies ParsedJsonWithRaw);
    } catch (error) {
      done(error as Error);
    }
  });

  app.post("/github", async (request, reply) => {
    const event = request.headers["x-github-event"];
    if (event !== "push") {
      return { accepted: false, ignored: true, reason: "Only GitHub push events trigger deploys" };
    }

    const signature = request.headers["x-hub-signature-256"];
    if (typeof signature !== "string") {
      return reply.code(401).send({ error: "Missing GitHub signature" });
    }

    const body = request.body as ParsedJsonWithRaw;
    const payload = githubPushSchema.parse(body.payload);
    const [owner, repo] = payload.repository.full_name.split("/");
    const branch = githubBranch(payload.ref);

    const deployments = await prisma.deployment.findMany({
      where: {
        autoDeployEnabled: true,
        sourceProvider: "GITHUB",
        githubOwner: { equals: owner, mode: "insensitive" },
        githubRepo: { equals: repo, mode: "insensitive" },
        branch
      }
    });

    const results = [];
    for (const deployment of deployments) {
      const secret = await getSecret(webhookSecretRef(deployment.slug));
      if (!secret || !deployment.webhookSecretHash) {
        results.push({ deployment: deployment.slug, queued: false, ignored: true, reason: "Webhook secret is not configured" });
        continue;
      }
      if (!timingSafeEqualText(sha256(secret), deployment.webhookSecretHash)) {
        await addWebhookLog(deployment.id, "Rejected GitHub push webhook because stored secret hash does not match metadata", { branch, repo: payload.repository.full_name });
        results.push({ deployment: deployment.slug, queued: false, rejected: true, reason: "Webhook secret metadata mismatch" });
        continue;
      }

      const expectedSignature = githubSignature(secret, body.rawBody);
      if (!timingSafeEqualText(signature, expectedSignature)) {
        await addWebhookLog(deployment.id, "Rejected GitHub push webhook with invalid signature", { branch, repo: payload.repository.full_name });
        results.push({ deployment: deployment.slug, queued: false, rejected: true, reason: "Invalid signature" });
        continue;
      }

      const release = await prisma.deploymentRelease.create({
        data: {
          deploymentId: deployment.id,
          status: "QUEUED",
          commitSha: payload.after ?? payload.head_commit?.id ?? deployment.commitSha,
          commitMessage: payload.head_commit?.message ?? null,
          commitAuthor: payload.head_commit?.author?.name ?? "GitHub",
          sourcePath: deployment.rootPath,
          envSnapshot: deployment.envVars === null ? {} : deployment.envVars as Prisma.InputJsonValue,
          processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
        }
      });
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: "QUEUED",
          commitSha: payload.after ?? deployment.commitSha
        }
      });
      await addWebhookLog(deployment.id, `GitHub push queued auto deploy for ${payload.repository.full_name}@${branch}`, {
        releaseId: release.id,
        commitSha: payload.after ?? null
      });
      const queue = await enqueueDeploy(deployment.id, release.id);
      await audit(request, {
        action: "DEPLOY",
        resource: "deployment",
        resourceId: deployment.id,
        description: `GitHub push auto deploy queued for ${deployment.slug}`,
        metadata: { releaseId: release.id, repository: payload.repository.full_name, branch }
      });
      results.push({ deployment: deployment.slug, releaseId: release.id, queue });
    }

    return reply.code(202).send({
      accepted: true,
      repository: payload.repository.full_name,
      branch,
      matched: deployments.length,
      results
    });
  });

  app.get("/panel-update/status", { preHandler: app.requireAuth }, async () => {
    const logFile = env.PANEL_UPDATE_LOG_FILE;
    const currentSource = await gitCurrentSource();
    const status: PanelUpdateStatus = await readPanelUpdateStatus() ?? {
        state: "unknown",
        message: "No panel update status has been written yet",
        updatedAt: null,
        logFile
      };
    if (!status.commitSubject && typeof status.commit === "string") {
      status.commitSubject = await gitCommitSubject(status.commit);
    }
    const recentLog = await fsPromises.readFile(logFile, "utf8")
      .then((content) => content.split(/\r?\n/).filter(Boolean).slice(-80))
      .catch(() => []);
    const apiRestartRequested = recentLog.some((line) => line.includes(`--no-block restart ${env.PANEL_UPDATE_API_SERVICE}`) || line.includes(`restart ${env.PANEL_UPDATE_API_SERVICE}`));
    const apiRestartStuck = status.state === "running" && typeof status.message === "string" && status.message.includes(`restarting ${env.PANEL_UPDATE_API_SERVICE}`);
    const apiRestartHandoffKilled = status.state === "failed"
      && typeof status.message === "string"
      && status.message.includes("exit code 143")
      && recentLog.some((line) => line.includes(`panel self-update completed; restarting ${env.PANEL_UPDATE_API_SERVICE}`))
      && apiRestartRequested;
    if ((apiRestartStuck || apiRestartHandoffKilled) && apiRestartRequested) {
      status.state = "succeeded";
      status.message = `panel self-update completed; ${env.PANEL_UPDATE_API_SERVICE} restart was requested`;
      status.recoveredApiRestartStatus = true;
    }
    if ((status.state === "running" || status.state === "queued") && status.updatedAt) {
      const ageMs = Date.now() - new Date(status.updatedAt).getTime();
      if (Number.isFinite(ageMs) && ageMs > env.PANEL_UPDATE_STALE_AFTER_SECONDS * 1000) {
        status.state = "failed";
        status.message = `panel update looks stale after ${Math.round(ageMs / 60000)} minutes; check ${logFile}`;
        status.stale = true;
      }
    }
    return { status, recentLog, currentSource };
  });

  app.post("/panel-update/rebuild", { preHandler: app.requireAuth }, async (request, reply) => {
    try {
      const pid = await startPanelUpdate("Manual rebuild requested");
      await audit(request, {
        action: "DEPLOY",
        resource: "panel_update",
        description: "Manual panel rebuild requested"
      });
      return reply.code(202).send({ accepted: true, queued: true, pid: pid ?? null });
    } catch (error) {
      request.log.error({ error }, "could not start manual panel rebuild");
      await writePanelUpdateStatus({
        state: "failed",
        message: error instanceof Error ? error.message : "Could not start manual panel rebuild"
      }).catch(() => undefined);
      return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not start manual panel rebuild" });
    }
  });

  app.post("/panel-update", async (request, reply) => {
    if (!env.PANEL_UPDATE_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: "Panel update webhook is not configured" });
    }

    const event = request.headers["x-github-event"];
    if (event !== "push") {
      return { accepted: false, ignored: true, reason: "Only GitHub push events trigger panel updates" };
    }

    const signature = request.headers["x-hub-signature-256"];
    if (typeof signature !== "string") {
      return reply.code(401).send({ error: "Missing GitHub signature" });
    }

    const body = request.body as ParsedJsonWithRaw;
    const expectedSignature = githubSignature(env.PANEL_UPDATE_WEBHOOK_SECRET, body.rawBody);
    if (!timingSafeEqualText(signature, expectedSignature)) {
      request.log.warn("rejected panel update webhook with invalid signature");
      return reply.code(401).send({ error: "Invalid GitHub signature" });
    }

    const payload = githubPushSchema.parse(body.payload);
    const branch = githubBranch(payload.ref);
    const expectedRepo = env.PANEL_UPDATE_REPO_FULL_NAME?.trim().toLowerCase();
    const actualRepo = payload.repository.full_name.toLowerCase();

    if (expectedRepo && actualRepo !== expectedRepo) {
      return reply.code(202).send({ accepted: true, ignored: true, reason: "Repository does not match panel update target", repository: payload.repository.full_name });
    }

    if (branch !== env.PANEL_UPDATE_BRANCH) {
      return reply.code(202).send({ accepted: true, ignored: true, reason: "Branch does not match panel update target", branch });
    }

    try {
      await startPanelUpdate(
        "GitHub push received",
        payload.after?.slice(0, 7) ?? payload.head_commit?.id?.slice(0, 7) ?? "",
        payload.head_commit?.message?.split(/\r?\n/)[0] ?? ""
      );
    } catch (error) {
      request.log.error({ error }, "could not start panel update script");
      await writePanelUpdateStatus({
        state: "failed",
        message: error instanceof Error ? error.message : "Could not start panel update",
        branch,
        commit: payload.after?.slice(0, 7) ?? payload.head_commit?.id?.slice(0, 7) ?? "",
        commitSubject: payload.head_commit?.message?.split(/\r?\n/)[0] ?? ""
      }).catch(() => undefined);
      return reply.code(500).send({ error: error instanceof Error ? error.message : "Could not start panel update" });
    }

    request.log.info({ repository: payload.repository.full_name, branch, commitSha: payload.after }, "panel update started from GitHub push");
    return reply.code(202).send({
      accepted: true,
      queued: true,
      repository: payload.repository.full_name,
      branch,
      commitSha: payload.after ?? null
    });
  });
};
