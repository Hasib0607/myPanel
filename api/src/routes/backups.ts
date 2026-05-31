import type { FastifyPluginAsync } from "fastify";
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
  includeLogs: z.boolean().default(false)
});

export const backupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async () => {
    const [plan, archives, records] = await Promise.all([
      sysagent.backupPlan(),
      sysagent.backupArchives(),
      prisma.panelBackup.findMany({ orderBy: { createdAt: "desc" }, take: 50 })
    ]);
    return { plan, archives: archives.items, records };
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
    const body = z.object({ path: z.string().min(1) }).parse(request.body);
    return sysagent.restorePreview(body.path);
  });
};
