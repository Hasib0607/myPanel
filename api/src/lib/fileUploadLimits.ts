import { env } from "../config/env.js";

export const unlimitedFileUploadBytes = Number.MAX_SAFE_INTEGER;
export const configuredFileUploadLimitBytes = env.FILE_MANAGER_UPLOAD_LIMIT_BYTES;
export const fileUploadLimitBytes = env.FILE_MANAGER_UPLOAD_LIMIT_BYTES === 0
  ? unlimitedFileUploadBytes
  : env.FILE_MANAGER_UPLOAD_LIMIT_BYTES;
export const fileUploadChunkBytes = env.FILE_MANAGER_UPLOAD_CHUNK_BYTES;
/** Headroom above chunk size for proxies and Fastify body parsing. */
export const fileUploadChunkBodyLimitBytes = Math.max(
  Math.ceil(fileUploadChunkBytes * 1.5) + 16 * 1024 * 1024,
  128 * 1024 * 1024
);
export const fileUploadBodyLimitBytes = Math.min(fileUploadLimitBytes, unlimitedFileUploadBytes);
