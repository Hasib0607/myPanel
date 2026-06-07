import { env } from "../config/env.js";

export const fileUploadLimitBytes = env.FILE_MANAGER_UPLOAD_LIMIT_BYTES;
export const fileUploadChunkBytes = env.FILE_MANAGER_UPLOAD_CHUNK_BYTES;
/** Headroom above chunk size for proxies and Fastify body parsing. */
export const fileUploadChunkBodyLimitBytes = Math.max(
  Math.ceil(fileUploadChunkBytes * 1.5) + 16 * 1024 * 1024,
  128 * 1024 * 1024
);
