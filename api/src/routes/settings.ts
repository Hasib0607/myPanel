import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(500)
});

const envUpdateSchema = z.object({
  entries: z.array(z.object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    value: z.string().max(4000)
  })).max(80)
});

const secretKeys = new Set([
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "JWT_SECRET",
  "PANEL_UPDATE_GIT_TOKEN",
  "PANEL_UPDATE_WEBHOOK_SECRET",
  "REDIS_URL",
  "SUPERADMIN_PASSWORD_HASH",
  "TOTP_ENCRYPTION_KEY"
]);

const editableEnvKeys = [
  "FRONTEND_URL",
  "NEXT_PUBLIC_API_URL",
  "PANEL_LOGIN_PORT",
  "CPANEL_LOGIN_PORT",
  "VPS_IP",
  "FILE_MANAGER_ROOT",
  "SYSAGENT_URL",
  "PANEL_UPDATE_REPO_FULL_NAME",
  "PANEL_UPDATE_GIT_USERNAME",
  "PANEL_UPDATE_GIT_TOKEN",
  "PANEL_UPDATE_BRANCH",
  "PANEL_UPDATE_POLL_ENABLED",
  "PANEL_UPDATE_POLL_INTERVAL_MS",
  "DEPLOYMENT_PORT_START",
  "DEPLOYMENT_PORT_END",
  "DEPLOYMENT_RESERVED_PORTS",
  "DEPLOY_WORKER_CONCURRENCY",
  "DEPLOYMENT_COMMAND_TIMEOUT_SECONDS",
  "REQUIRE_DOMAIN_NAMESERVER_MATCH",
  "ALLOW_PENDING_DOMAIN_NAMESERVER_MISMATCH",
  "ALLOW_VANITY_NAMESERVER_GLUE_FALLBACK",
  "ALLOW_PENDING_VANITY_NAMESERVER_DOMAINS",
  "DOMAIN_NAMESERVER_RESOLVERS",
  "DOMAIN_NAMESERVER_DOH_URLS",
  "ALLOW_LIVE_SYSTEM_COMMANDS",
  "ALLOW_LIVE_FILE_MANAGER",
  "ALLOW_LIVE_DNS",
  "ALLOW_LIVE_NGINX",
  "ALLOW_LIVE_SSL",
  "GUARDIAN_AUTO_HEAL",
  "GUARDIAN_AUTO_DEPLOY_REPAIR",
  "GUARDIAN_DEPLOYMENT_DOCTOR_INTERVAL_MS",
  "DEPLOY_GUARDIAN_RECOVERY_ATTEMPTS"
];

const editableEnvKeySet = new Set(editableEnvKeys);

function envPath() {
  return path.join(env.PANEL_UPDATE_WORKDIR, ".env");
}

function parseEnvFile(content: string) {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2] ?? "");
  }
  return values;
}

function serializeEnvValue(value: string) {
  return value.replace(/\r?\n/g, " ").trim();
}

async function readEnvValues() {
  const file = envPath();
  const content = await fs.readFile(file, "utf8").catch(() => "");
  return { file, content, values: parseEnvFile(content) };
}

function upsertEnv(content: string, updates: Map<string, string>) {
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    const key = match?.[1];
    if (!key || !updates.has(key)) return line;
    seen.add(key);
    return `${key}=${updates.get(key) ?? ""}`;
  });

  for (const [key, value] of updates) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  return lines.join("\n").replace(/\n{3,}$/g, "\n\n");
}

async function writeEnvUpdates(updates: Map<string, string>) {
  const { file, content } = await readEnvValues();
  await fs.writeFile(file, upsertEnv(content, updates), "utf8");
  for (const [key, value] of updates) {
    process.env[key] = value;
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      (env as unknown as Record<string, string>)[key] = value;
    }
  }
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async () => {
    const { values } = await readEnvValues();
    return {
      username: env.SUPERADMIN_USERNAME,
      envFile: envPath(),
      entries: editableEnvKeys.map((key) => ({
        key,
        value: secretKeys.has(key) && values.get(key) ? "" : values.get(key) ?? process.env[key] ?? "",
        masked: secretKeys.has(key) && Boolean(values.get(key) ?? process.env[key]),
        secret: secretKeys.has(key)
      }))
    };
  });

  app.post("/password", async (request, reply) => {
    const body = passwordSchema.parse(request.body);
    const passwordMatches = await bcrypt.compare(body.currentPassword, env.SUPERADMIN_PASSWORD_HASH);
    if (!passwordMatches) return reply.code(401).send({ error: "Current password is incorrect" });

    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await writeEnvUpdates(new Map([["SUPERADMIN_PASSWORD_HASH", passwordHash]]));
    (env as unknown as { SUPERADMIN_PASSWORD_HASH: string }).SUPERADMIN_PASSWORD_HASH = passwordHash;

    await audit(request, {
      action: "UPDATE",
      resource: "panel_settings",
      description: "Changed superadmin password"
    });

    return { ok: true };
  });

  app.put("/env", async (request) => {
    const body = envUpdateSchema.parse(request.body);
    const updates = new Map<string, string>();

    for (const entry of body.entries) {
      if (!editableEnvKeySet.has(entry.key)) {
        throw Object.assign(new Error(`${entry.key} cannot be edited from panel settings`), { statusCode: 400 });
      }
      if (secretKeys.has(entry.key) && entry.value.trim() === "") continue;
      updates.set(entry.key, serializeEnvValue(entry.value));
    }

    if (updates.size > 0) {
      await writeEnvUpdates(updates);
      await audit(request, {
        action: "UPDATE",
        resource: "panel_env",
        description: "Updated panel environment settings",
        metadata: { keys: [...updates.keys()] }
      });
    }

    return { ok: true, updated: [...updates.keys()], restartRequired: true };
  });
};
