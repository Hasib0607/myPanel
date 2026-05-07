import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
  fs.accessSync(script, fs.constants.X_OK);
  return { appDir, script };
}

function spawnPanelUpdate() {
  const { appDir, script } = configuredPanelUpdateScript();
  const child = spawn(script, [], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PANEL_UPDATE_WORKDIR: appDir,
      PANEL_UPDATE_BRANCH: env.PANEL_UPDATE_BRANCH
    }
  });
  child.unref();
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
    const statusFile = env.PANEL_UPDATE_STATUS_FILE;
    const logFile = env.PANEL_UPDATE_LOG_FILE;
    const status: PanelUpdateStatus = await fsPromises.readFile(statusFile, "utf8")
      .then((content) => JSON.parse(content) as PanelUpdateStatus)
      .catch(() => ({
        state: "unknown",
        message: "No panel update status has been written yet",
        updatedAt: null,
        logFile
      }));
    if (!status.commitSubject && typeof status.commit === "string") {
      status.commitSubject = await gitCommitSubject(status.commit);
    }
    const recentLog = await fsPromises.readFile(logFile, "utf8")
      .then((content) => content.split(/\r?\n/).filter(Boolean).slice(-80))
      .catch(() => []);
    return { status, recentLog };
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
      spawnPanelUpdate();
    } catch (error) {
      request.log.error({ error }, "could not start panel update script");
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
