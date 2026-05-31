import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";

const backupSchema = z.object({
  label: z.string().trim().min(1).max(80).default("manual"),
  appDir: z.string().trim().default("/opt/vps-panel"),
  includeApp: z.boolean().default(true),
  includeEnv: z.boolean().default(true),
  includeDatabase: z.boolean().default(true),
  includeAccounts: z.boolean().default(true),
  includeDeployments: z.boolean().default(true),
  includeNginx: z.boolean().default(true),
  includeDns: z.boolean().default(true),
  includeLogs: z.boolean().default(false),
  excludePatterns: z.array(z.string()).default(["node_modules", ".next/cache", "cache", "tmp", "*.log"]),
  encryptPassphrase: z.string().optional()
});
const pathSchema = z.object({ path: z.string().min(1) });
const settingsSchema = z.object({
  scheduleEnabled: z.boolean().default(false),
  cron: z.string().default("0 3 * * *"),
  retentionKeepLast: z.number().int().min(1).max(500).default(14),
  remoteProvider: z.enum(["NONE", "S3", "R2", "B2", "SFTP"]).default("NONE"),
  remoteTarget: z.string().default(""),
  encryptionEnabled: z.boolean().default(false)
});

export const backupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async () => {
    const [plan, archives, records, settings] = await Promise.all([
      sysagent.backupPlan(),
      sysagent.backupArchives(),
      prisma.panelBackup.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.guardianSetting.findUnique({ where: { key: "panel_backup_settings" } })
    ]);
    return { plan, archives: archives.items, records, settings: settings?.value ?? settingsSchema.parse({}) };
  });

  app.put("/settings", async (request) => {
    const body = settingsSchema.parse(request.body ?? {});
    const item = await prisma.guardianSetting.upsert({
      where: { key: "panel_backup_settings" },
      update: { value: body as any },
      create: { key: "panel_backup_settings", value: body as any }
    });
    await audit(request, { action: "UPDATE", resource: "panel_backup_settings", description: "Updated backup settings" });
    return item.value;
  });

  app.post("/", async (request, reply) => {
    const body = backupSchema.parse(request.body ?? {});
    const includes = Object.entries(body)
      .filter(([key, value]) => key.startsWith("include") && value === true)
      .map(([key]) => key);
    const record = await prisma.panelBackup.create({
      data: { label: body.label, status: "RUNNING", includes, startedAt: new Date() }
    });
    try {
      const result = await sysagent.createBackup(body);
      const ok = result.result.returncode === 0;
      const updated = await prisma.panelBackup.update({
        where: { id: record.id },
        data: {
          status: ok ? "SUCCEEDED" : "FAILED",
          archivePath: result.archivePath,
          sizeBytes: result.sizeBytes ?? null,
          includes: result.includes,
          result: result as any,
          finishedAt: new Date()
        }
      });
      await audit(request, { action: "CREATE", resource: "panel_backup", resourceId: updated.id, description: `Created panel backup ${body.label}` });
      return reply.code(201).send(updated);
    } catch (error) {
      const updated = await prisma.panelBackup.update({
        where: { id: record.id },
        data: { status: "FAILED", result: { error: error instanceof Error ? error.message : String(error) } as any, finishedAt: new Date() }
      });
      return reply.code(500).send(updated);
    }
  });

  app.post("/restore-preview", async (request) => {
    const body = pathSchema.parse(request.body);
    return sysagent.restorePreview(body.path);
  });

  app.post("/restore", async (request) => {
    const body = z.object({ path: z.string().min(1), execute: z.boolean().default(false), mode: z.string().default("full") }).parse(request.body);
    return sysagent.restoreBackup(body);
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
