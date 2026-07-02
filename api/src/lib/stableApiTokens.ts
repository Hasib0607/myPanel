import { z } from "zod";
import { env } from "../config/env.js";

const maxTokenLifetimeSeconds = 60 * 60 * 24 * 365 * 20;

export const stableApiTokenRequestSchema = z.object({
  expiresInSeconds: z.coerce.number().int().min(60).max(maxTokenLifetimeSeconds).optional(),
  expiresAt: z.union([z.string().datetime(), z.null()]).optional(),
  unlimited: z.boolean().optional()
});

export type StableApiTokenRequest = z.infer<typeof stableApiTokenRequestSchema>;

export type StableApiTokenExpiry = {
  expiresAt: Date | null;
  expiresInSeconds: number | null;
  unlimited: boolean;
};

export function resolveStableApiTokenExpiry(input: StableApiTokenRequest): StableApiTokenExpiry {
  if (input.unlimited || input.expiresAt === null) {
    return { expiresAt: null, expiresInSeconds: null, unlimited: true };
  }

  const now = Date.now();
  if (input.expiresAt) {
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now) {
      throw Object.assign(new Error("Token expiry date must be in the future."), { statusCode: 400 });
    }
    const expiresInSeconds = Math.max(60, Math.floor((expiresAt.getTime() - now) / 1000));
    return { expiresAt, expiresInSeconds, unlimited: false };
  }

  const expiresInSeconds = input.expiresInSeconds ?? env.JWT_EXPIRY;
  return {
    expiresAt: new Date(now + expiresInSeconds * 1000),
    expiresInSeconds,
    unlimited: false
  };
}

export function stableApiTokenJwtOptions(expiry: StableApiTokenExpiry) {
  return expiry.expiresInSeconds === null ? {} : { expiresIn: expiry.expiresInSeconds };
}

export function stableApiTokenMetadata(base: Record<string, unknown>, expiry: StableApiTokenExpiry) {
  return {
    ...base,
    stableApiToken: true,
    unlimited: expiry.unlimited,
    expiresAt: expiry.expiresAt ? expiry.expiresAt.toISOString() : null
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function metadataExpiresAt(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || !("expiresAt" in metadata)) return undefined;
  const raw = (metadata as { expiresAt?: unknown }).expiresAt;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function storedStableTokenExpiry(token: string, metadata: unknown): StableApiTokenExpiry {
  const metadataExpiry = metadataExpiresAt(metadata);
  const payload = decodeJwtPayload(token);
  const exp = typeof payload?.exp === "number" ? payload.exp : null;
  const expiresAt = metadataExpiry !== undefined ? metadataExpiry : exp ? new Date(exp * 1000) : null;
  if (!expiresAt) return { expiresAt: null, expiresInSeconds: null, unlimited: true };
  return {
    expiresAt,
    expiresInSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    unlimited: false
  };
}
