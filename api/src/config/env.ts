import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SUPERADMIN_USERNAME: z.string().default("admin"),
  SUPERADMIN_PASSWORD_HASH: z.string().min(20),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.coerce.number().default(86400),
  TOTP_ISSUER: z.string().default("VPS Panel"),
  TOTP_ENCRYPTION_KEY: z.string().min(32),
  PANEL_PORT: z.coerce.number().default(4000),
  PANEL_LOGIN_PORT: z.string().optional(),
  PANEL_UPDATE_WEBHOOK_SECRET: z.string().optional(),
  PANEL_UPDATE_REPO_FULL_NAME: z.string().optional(),
  PANEL_UPDATE_BRANCH: z.string().default("main"),
  PANEL_UPDATE_WORKDIR: z.string().default(process.cwd().replace(/\/api$/, "")),
  PANEL_UPDATE_SCRIPT: z.string().optional(),
  PANEL_UPDATE_STATUS_FILE: z.string().default("/var/log/vps-panel/self-update-status.json"),
  PANEL_UPDATE_LOG_FILE: z.string().default("/var/log/vps-panel/self-update.log"),
  PANEL_UPDATE_PID_FILE: z.string().default("/tmp/vps-panel-self-update.pid"),
  PANEL_UPDATE_API_SERVICE: z.string().default("vps-panel-api"),
  PANEL_UPDATE_STALE_AFTER_SECONDS: z.coerce.number().default(1200),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  SYSAGENT_URL: z.string().url().default("http://127.0.0.1:5000"),
  VPS_IP: z.string().default("127.0.0.1"),
  REQUIRE_DOMAIN_NAMESERVER_MATCH: z.coerce.boolean().default(true),
  ALLOW_VANITY_NAMESERVER_GLUE_FALLBACK: z.coerce.boolean().default(true),
  DOMAIN_NAMESERVER_RESOLVERS: z.string().default("1.1.1.1,8.8.8.8,9.9.9.9"),
  DOMAIN_NAMESERVER_DOH_URLS: z.string().default("https://cloudflare-dns.com/dns-query,https://dns.google/resolve,https://dns.quad9.net/dns-query"),
  FILE_MANAGER_ROOT: z.string().default("/var/www")
});

export const env = envSchema.parse(process.env);
