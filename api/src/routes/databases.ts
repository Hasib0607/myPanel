import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { sysagent } from "../lib/sysagent.js";

const engineSchema = z.enum(["POSTGRESQL", "MYSQL"]);
const identifierSchema = z.string().regex(/^[a-zA-Z0-9_]+$/, "Use only letters, numbers, and underscores");
const passwordSchema = z.string().min(12).max(500).optional();

const provisionSchema = z.object({
  engine: engineSchema,
  database: identifierSchema,
  username: identifierSchema,
  password: passwordSchema
});

const passwordChangeSchema = z.object({
  engine: engineSchema,
  username: identifierSchema,
  password: passwordSchema
});

const grantSchema = z.object({
  engine: engineSchema,
  database: identifierSchema,
  username: identifierSchema
});

const deleteSchema = z.object({
  engine: engineSchema,
  database: identifierSchema
});

const exportSchema = deleteSchema;
const maxImportUploadBytes = 3 * 1024 * 1024 * 1024;
const importUploadContentType = "application/vnd.vps-panel.db-import";
const importSchema = z.object({
  engine: engineSchema,
  database: identifierSchema,
  sql: z.string().min(1).max(20_000_000)
});
const importUploadQuerySchema = z.object({
  engine: engineSchema,
  database: identifierSchema,
  filename: z.string().trim().min(1).max(255).optional()
});

const tableSchema = z.object({
  engine: engineSchema,
  database: identifierSchema,
  table: identifierSchema
});

const rowsSchema = tableSchema.extend({
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional()
});

const tableImportSchema = tableSchema.extend({
  format: z.enum(["SQL", "CSV"]),
  content: z.string().min(1).max(20_000_000)
});
const rowValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rowCreateSchema = tableSchema.extend({
  values: z.record(identifierSchema, rowValueSchema)
});
const rowTargetSchema = tableSchema.extend({
  keyColumn: identifierSchema,
  keyValue: z.union([z.string(), z.number(), z.boolean()])
});
const rowUpdateSchema = rowTargetSchema.extend({
  values: z.record(identifierSchema, rowValueSchema)
});

function failedCommand(result: unknown) {
  const value = result as { returncode?: number; stderr?: string };
  return typeof value?.returncode === "number" && value.returncode !== 0 ? value.stderr || `exit ${value.returncode}` : null;
}

function commandTreeFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const direct = failedCommand(result);
  if (direct) return direct;
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (key === "checks") continue;
    const nested = failedCommand(value);
    if (nested) return `${key}: ${nested}`;
  }
  return null;
}

function assertDatabaseResult(result: unknown, label: string) {
  const failure = commandTreeFailure(result);
  if (failure) throw new Error(`${label} failed: ${failure}`);
}

async function writeImportUploadToTemp(payload: NodeJS.ReadableStream, filename?: string) {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "panel-db-import-"));
  const safeName = (filename || "database.sql").replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(tmpDir, safeName.endsWith(".sql") ? safeName : `${safeName}.sql`);
  const output = fs.createWriteStream(filePath);
  let sizeBytes = 0;

  payload.on("data", (chunk) => {
    sizeBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk));
    if (sizeBytes > maxImportUploadBytes) {
      (payload as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.(new Error("Database upload is too large. Maximum size is 3GB."));
    }
  });

  try {
    await pipeline(payload, output);
    return { tmpDir, filePath, sizeBytes };
  } catch (error) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export const databaseRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  if (!app.hasContentTypeParser(importUploadContentType)) {
    app.addContentTypeParser(importUploadContentType, async (request: FastifyRequest, payload: NodeJS.ReadableStream) => {
      const query = importUploadQuerySchema.parse(request.query);
      return writeImportUploadToTemp(payload, query.filename);
    });
  }

  app.get("/", async () => sysagent.databaseOverview());

  app.post("/", async (request) => {
    const body = provisionSchema.parse(request.body);
    const result = await sysagent.provisionDatabase(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database create");
    await audit(request, {
      action: "CREATE",
      resource: "database",
      resourceId: body.database,
      description: `Created ${body.engine} database ${body.database} and user ${body.username}`
    });
    return result;
  });

  app.post("/password", async (request) => {
    const body = passwordChangeSchema.parse(request.body);
    const result = await sysagent.databasePassword(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database password change");
    await audit(request, {
      action: "UPDATE",
      resource: "database-user",
      resourceId: body.username,
      description: `Changed ${body.engine} password for ${body.username}`
    });
    return result;
  });

  app.post("/grant", async (request) => {
    const body = grantSchema.parse(request.body);
    const result = await sysagent.databaseGrant(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database grant");
    await audit(request, {
      action: "UPDATE",
      resource: "database",
      resourceId: body.database,
      description: `Granted ${body.username} access to ${body.engine} database ${body.database}`
    });
    return result;
  });

  app.delete("/", async (request) => {
    const body = deleteSchema.parse(request.body);
    const result = await sysagent.databaseDelete(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database delete");
    await audit(request, {
      action: "DELETE",
      resource: "database",
      resourceId: body.database,
      description: `Deleted ${body.engine} database ${body.database}`
    });
    return result;
  });

  app.post("/export", async (request) => {
    const body = exportSchema.parse(request.body);
    const result = await sysagent.databaseExport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database export");
    await audit(request, {
      action: "APPLY",
      resource: "database",
      resourceId: body.database,
      description: `Exported ${body.engine} database ${body.database}`
    });
    return {
      engine: result.engine,
      database: result.database,
      dump: result.dump
    };
  });

  app.post("/import", async (request) => {
    const body = importSchema.parse(request.body);
    const result = await sysagent.databaseImport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Database import");
    await audit(request, {
      action: "APPLY",
      resource: "database",
      resourceId: body.database,
      description: `Imported SQL into ${body.engine} database ${body.database}`
    });
    return result;
  });

  app.post("/import/upload", { bodyLimit: maxImportUploadBytes }, async (request) => {
    const query = importUploadQuerySchema.parse(request.query);
    const upload = request.body as { tmpDir: string; filePath: string; sizeBytes: number };
    try {
      const result = await sysagent.databaseImportFile({
        engine: query.engine,
        database: query.database,
        path: upload.filePath
      });
      assertDatabaseResult((result as { result?: unknown }).result, "Database import");
      await audit(request, {
        action: "APPLY",
        resource: "database",
        resourceId: query.database,
        description: `Imported uploaded SQL into ${query.engine} database ${query.database}`,
        metadata: { sizeBytes: upload.sizeBytes, filename: query.filename ?? path.basename(upload.filePath) }
      });
      return Object.assign({}, result as Record<string, unknown>, {
        sizeBytes: upload.sizeBytes,
        filename: query.filename ?? path.basename(upload.filePath)
      });
    } finally {
      await fsp.rm(upload.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  app.post("/tables", async (request) => {
    const body = exportSchema.parse(request.body);
    const result = await sysagent.databaseTables(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table list");
    return result;
  });

  app.post("/columns", async (request) => {
    const body = tableSchema.parse(request.body);
    const result = await sysagent.databaseColumns(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Column list");
    return result;
  });

  app.post("/rows", async (request) => {
    const body = rowsSchema.parse(request.body);
    const result = await sysagent.databaseRows(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row preview");
    return result;
  });

  app.post("/table/export", async (request) => {
    const body = tableSchema.parse(request.body);
    const result = await sysagent.databaseTableExport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table export");
    await audit(request, {
      action: "APPLY",
      resource: "database-table",
      resourceId: `${body.database}.${body.table}`,
      description: `Exported ${body.engine} table ${body.database}.${body.table}`
    });
    return { engine: result.engine, database: result.database, table: result.table, dump: result.dump };
  });

  app.post("/table/export-csv", async (request) => {
    const body = tableSchema.parse(request.body);
    const result = await sysagent.databaseTableExportCsv(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table CSV export");
    await audit(request, {
      action: "APPLY",
      resource: "database-table",
      resourceId: `${body.database}.${body.table}`,
      description: `Exported ${body.engine} table ${body.database}.${body.table} as ${result.format}`
    });
    return { engine: result.engine, database: result.database, table: result.table, format: result.format, content: result.content };
  });

  app.post("/table/import", async (request) => {
    const body = tableImportSchema.parse(request.body);
    const result = await sysagent.databaseTableImport(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Table import");
    await audit(request, {
      action: "APPLY",
      resource: "database-table",
      resourceId: `${body.database}.${body.table}`,
      description: `Imported ${body.format} into ${body.engine} table ${body.database}.${body.table}`
    });
    return result;
  });

  app.post("/row", async (request) => {
    const body = rowCreateSchema.parse(request.body);
    const result = await sysagent.databaseRowCreate(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row create");
    await audit(request, {
      action: "CREATE",
      resource: "database-row",
      resourceId: `${body.database}.${body.table}`,
      description: `Inserted row into ${body.engine} table ${body.database}.${body.table}`
    });
    return result;
  });

  app.patch("/row", async (request) => {
    const body = rowUpdateSchema.parse(request.body);
    const result = await sysagent.databaseRowUpdate(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row update");
    await audit(request, {
      action: "UPDATE",
      resource: "database-row",
      resourceId: `${body.database}.${body.table}`,
      description: `Updated row in ${body.engine} table ${body.database}.${body.table}`
    });
    return result;
  });

  app.delete("/row", async (request) => {
    const body = rowTargetSchema.parse(request.body);
    const result = await sysagent.databaseRowDelete(body);
    assertDatabaseResult((result as { result?: unknown }).result, "Row delete");
    await audit(request, {
      action: "DELETE",
      resource: "database-row",
      resourceId: `${body.database}.${body.table}`,
      description: `Deleted row from ${body.engine} table ${body.database}.${body.table}`
    });
    return result;
  });
};
