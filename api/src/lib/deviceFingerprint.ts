import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export const deviceFingerprintHeaderName = "x-device-fingerprint";

function normalizeHeaderValue(value: unknown) {
  if (Array.isArray(value)) return normalizeHeaderValue(value[0]);
  return typeof value === "string" ? value.trim().slice(0, 512) : "";
}

export function deviceFingerprintDigest(fingerprint: unknown, userAgent: unknown) {
  const normalizedFingerprint = normalizeHeaderValue(fingerprint);
  if (!normalizedFingerprint) return null;

  return createHash("sha256")
    .update(normalizedFingerprint)
    .update("\0")
    .update(normalizeHeaderValue(userAgent))
    .digest("hex");
}

export function requestDeviceFingerprintDigest(request: FastifyRequest, explicitFingerprint?: unknown) {
  return deviceFingerprintDigest(explicitFingerprint ?? request.headers[deviceFingerprintHeaderName], request.headers["user-agent"]);
}

export function deviceFingerprintStableDigest(fingerprint: unknown) {
  const normalizedFingerprint = normalizeHeaderValue(fingerprint);
  if (!normalizedFingerprint) return null;
  return createHash("sha256").update(normalizedFingerprint).digest("hex");
}

export function requestDeviceFingerprintStableDigest(request: FastifyRequest, explicitFingerprint?: unknown) {
  return deviceFingerprintStableDigest(explicitFingerprint ?? request.headers[deviceFingerprintHeaderName]);
}

export function deviceFingerprintMatches(expected: unknown, actual: string | null) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected) || !actual) return false;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export function enforceDeviceFingerprint(request: FastifyRequest, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  const expected = (request as any).user?.dfp;
  if (!expected) return false;

  if (deviceFingerprintMatches(expected, requestDeviceFingerprintDigest(request))) {
    return false;
  }

  reply.code(401).send({ error: "Device verification failed. Please log in again from this browser." });
  return true;
}
