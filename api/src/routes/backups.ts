import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { backupSchema, getBackupSettings, googleDriveConfig, runPanelBackup, saveBackupSettings } from "../lib/panelBackups.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const pathSchema = z.object({ path: z.string().min(1) });
const restoreJobSchema = z.object({
  source: z.enum(["LOCAL", "GOOGLE_DRIVE"]).default("LOCAL"),
  path: z.string().min(1),
  execute: z.boolean().default(true),
  mode: z.string().default("full")
});

type RestoreJobStatus = {
  id: string;
  source: "LOCAL" | "GOOGLE_DRIVE";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  phase: "QUEUED" | "CHECKING_LOCAL" | "DOWNLOADING" | "DOWNLOADED" | "RESTORING" | "CLEANING_UP" | "SUCCEEDED" | "FAILED";
  percent: number;
  message: string;
  remotePath?: string;
  localPath?: string;
  downloadSkipped?: boolean;
  error?: string;
  result?: unknown;
  startedAt: string;
  finishedAt?: string;
};

type BackupJobStatus = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  phase: "QUEUED" | "CREATING_ARCHIVE" | "ARCHIVE_CREATED" | "UPLOADING" | "PRUNING_REMOTE" | "PRUNING_LOCAL" | "SUCCEEDED" | "FAILED";
  percent: number;
  message: string;
  backupId?: string;
  archivePath?: string;
  error?: string;
  result?: unknown;
  startedAt: string;
  finishedAt?: string;
};

function restoreJobKey(id: string) {
  return `panel_restore_job:${id}`;
}

function backupJobKey(id: string) {
  return `panel_backup_job:${id}`;
}

async function saveRestoreJob(job: RestoreJobStatus) {
  await prisma.guardianSetting.upsert({
    where: { key: restoreJobKey(job.id) },
    update: { value: job as any },
    create: { key: restoreJobKey(job.id), value: job as any }
  });
}

async function saveBackupJob(job: BackupJobStatus) {
  await prisma.guardianSetting.upsert({
    where: { key: backupJobKey(job.id) },
    update: { value: job as any },
    create: { key: backupJobKey(job.id), value: job as any }
  });
}

function remoteArchivePath(remoteTarget: string, input: string) {
  if (input.includes(":")) return input;
  return `${remoteTarget.replace(/\/$/, "")}/${path.basename(input)}`;
}

function localRestorePath(backupRoot: string, input: string) {
  return path.join(backupRoot, path.basename(input));
}

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

export const backupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async () => {
    const [plan, archives, records, settings] = await Promise.all([
      sysagent.backupPlan(),
      sysagent.backupArchives(),
      prisma.panelBackup.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      getBackupSettings()
    ]);
    return { plan, archives: archives.items, records: jsonSafe(records), settings };
  });

  app.put("/settings", async (request) => {
    const item = await saveBackupSettings(request.body ?? {});
    await audit(request, { action: "UPDATE", resource: "panel_backup_settings", description: "Updated backup settings" });
    return item.value;
  });

  app.post("/", async (request, reply) => {
    try {
      return reply.code(201).send(await runPanelBackup(request.body ?? {}, request));
    } catch (error) {
      return reply.code(500).send((error as any).record ?? { error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/jobs", async (request, reply) => {
    const body = backupSchema.parse(request.body ?? {});
    const id = randomUUID();
    const initial: BackupJobStatus = {
      id,
      status: "QUEUED",
      phase: "QUEUED",
      percent: 1,
      message: "Backup job queued.",
      startedAt: new Date().toISOString()
    };
    await saveBackupJob(initial);

    void (async () => {
      let job = initial;
      const update = async (patch: Partial<BackupJobStatus>) => {
        job = { ...job, ...patch };
        await saveBackupJob(job);
      };
      try {
        await update({ status: "RUNNING", phase: "CREATING_ARCHIVE", percent: 5, message: "Starting full backup on server." });
        const record = await runPanelBackup(body, request, async (progress) => {
          await update({
            status: progress.phase === "FAILED" ? "FAILED" : progress.phase === "SUCCEEDED" ? "SUCCEEDED" : "RUNNING",
            phase: progress.phase as BackupJobStatus["phase"],
            percent: progress.percent,
            message: progress.message,
            result: progress.result ?? job.result
          });
        });
        await update({
          status: record.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
          phase: record.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
          percent: 100,
          message: record.status === "SUCCEEDED" ? "Backup completed." : "Backup failed.",
          backupId: record.id,
          archivePath: record.archivePath ?? undefined,
          result: record,
          finishedAt: new Date().toISOString()
        });
      } catch (error) {
        const record = (error as any).record;
        const message = error instanceof Error ? error.message : "Backup failed.";
        await update({
          status: "FAILED",
          phase: "FAILED",
          percent: 100,
          message,
          error: message,
          backupId: record?.id,
          archivePath: record?.archivePath ?? undefined,
          result: record,
          finishedAt: new Date().toISOString()
        });
      }
    })();

    return reply.code(202).send(initial);
  });

  app.get("/jobs/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const row = await prisma.guardianSetting.findUnique({ where: { key: backupJobKey(params.id) } });
    if (!row) return reply.code(404).send({ error: "Backup job not found" });
    return row.value;
  });

  app.post("/restore-preview", async (request) => {
    const body = pathSchema.parse(request.body);
    return sysagent.restorePreview(body.path);
  });

  app.post("/restore", async (request) => {
    const body = z.object({ path: z.string().min(1), execute: z.boolean().default(false), mode: z.string().default("full") }).parse(request.body);
    const result = await sysagent.restoreBackup(body);
    await audit(request, { action: "APPLY", resource: "panel_backup_restore", description: `${body.execute ? "Executed" : "Previewed"} restore for ${body.path}`, metadata: result as any });
    return result;
  });

  app.post("/restore-jobs", async (request, reply) => {
    const body = restoreJobSchema.parse(request.body ?? {});
    const id = randomUUID();
    const plan = await sysagent.backupPlan();
    const settings = await getBackupSettings();
    const remotePath = body.source === "GOOGLE_DRIVE" ? remoteArchivePath(settings.remoteTarget, body.path) : undefined;
    const localPath = body.source === "GOOGLE_DRIVE" ? localRestorePath(plan.backupRoot, body.path) : body.path;
    const initial: RestoreJobStatus = {
      id,
      source: body.source,
      status: "QUEUED",
      phase: "QUEUED",
      percent: 1,
      message: "Restore job queued.",
      remotePath,
      localPath,
      startedAt: new Date().toISOString()
    };
    await saveRestoreJob(initial);

    void (async () => {
      let job = initial;
      const update = async (patch: Partial<RestoreJobStatus>) => {
        job = { ...job, ...patch };
        await saveRestoreJob(job);
      };
      try {
        await update({ status: "RUNNING", phase: "CHECKING_LOCAL", percent: 5, message: "Checking local archive." });
        if (body.source === "GOOGLE_DRIVE") {
          await update({ phase: "DOWNLOADING", percent: 15, message: "Downloading archive from Google Drive if local copy is missing." });
          const googleDrive = await googleDriveConfig(settings);
          const download = await sysagent.downloadBackupFromRemote({ remotePath, localPath, googleDrive });
          if (download.result.returncode !== 0) {
            throw new Error(download.result.stderr || "Google Drive download failed.");
          }
          await update({
            phase: "DOWNLOADED",
            percent: 40,
            message: download.skipped ? "Local archive already exists; skipped download." : "Download complete.",
            localPath: download.archivePath,
            downloadSkipped: download.skipped,
            result: { download }
          });
        }

        await update({ phase: "RESTORING", percent: 60, message: body.execute ? "Running restore." : "Restore dry-run/preview running." });
        const restore = await sysagent.restoreBackup({ path: job.localPath, execute: body.execute, mode: body.mode });
        const restoreOk = restore.result.returncode === 0;
        if (!restoreOk) {
          throw Object.assign(new Error(restore.result.stderr || "Restore failed."), { restore });
        }

        if (body.source === "GOOGLE_DRIVE" && body.execute) {
          await update({ phase: "CLEANING_UP", percent: 92, message: "Restore complete. Cleaning up downloaded archive." });
          await sysagent.deleteBackupArchive(job.localPath!);
        }
        await update({ status: "SUCCEEDED", phase: "SUCCEEDED", percent: 100, message: "Restore completed.", result: { ...(job.result as any), restore }, finishedAt: new Date().toISOString() });
        await audit(request, { action: "APPLY", resource: "panel_backup_restore", description: `Restore job ${id} completed for ${job.localPath}`, metadata: job as any });
      } catch (error) {
        await update({
          status: "FAILED",
          phase: "FAILED",
          percent: Math.max(job.percent, body.source === "GOOGLE_DRIVE" ? 40 : 5),
          message: "Restore incomplete. Downloaded archive was kept for retry.",
          error: error instanceof Error ? error.message : String(error),
          result: { ...(job.result as any), restore: (error as any).restore },
          finishedAt: new Date().toISOString()
        });
      }
    })();

    return reply.code(202).send(initial);
  });

  app.get("/restore-jobs/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const row = await prisma.guardianSetting.findUnique({ where: { key: restoreJobKey(params.id) } });
    if (!row) return reply.code(404).send({ error: "Restore job not found" });
    return row.value;
  });

  app.post("/verify", async (request) => {
    const body = pathSchema.parse(request.body);
    return sysagent.verifyBackup(body.path);
  });

  app.post("/manifest", async (request) => {
    const body = pathSchema.parse(request.body);
    return sysagent.backupManifest(body.path);
  });

  app.delete("/archive", async (request) => {
    const body = pathSchema.parse(request.body);
    const result = await sysagent.deleteBackupArchive(body.path);
    await prisma.panelBackup.updateMany({ where: { archivePath: body.path }, data: { result: { deleted: true, deleteResult: result } as any } });
    await audit(request, { action: "DELETE", resource: "panel_backup_archive", description: `Deleted backup archive ${body.path}` });
    return result;
  });

  app.post("/prune", async (request) => {
    const body = z.object({ keepLast: z.number().int().min(1).max(500).default(10) }).parse(request.body ?? {});
    const result = await sysagent.pruneBackups({ keep_last: body.keepLast });
    await audit(request, { action: "DELETE", resource: "panel_backup_archive", description: `Pruned backup archives`, metadata: result as any });
    return result;
  });

  app.get("/download", async (request, reply) => {
    const query = pathSchema.parse(request.query);
    const plan = await sysagent.backupPlan();
    const root = path.resolve(plan.backupRoot);
    const archive = path.resolve(query.path);
    if (!archive.startsWith(root + path.sep)) {
      return reply.code(400).send({ error: "Archive must be under backup root" });
    }
    if (!fs.existsSync(archive)) {
      return reply.code(404).send({ error: "Archive not found" });
    }
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${path.basename(archive)}"`);
    return reply.send(fs.createReadStream(archive));
  });
};
