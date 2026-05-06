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
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  SYSAGENT_URL: z.string().url().default("http://127.0.0.1:5000"),
  VPS_IP: z.string().default("127.0.0.1"),
  FILE_MANAGER_ROOT: z.string().default("/var/www")
});

export const env = envSchema.parse(process.env);
