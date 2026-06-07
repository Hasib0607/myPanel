import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { fileUploadChunkBytes, fileUploadLimitBytes } from "./fileUploadLimits.js";

export const chunkUploadQuery = z.object({
  parentPath: z.string().default("."),
  name: z.string(),
  uploadId: z.string().regex(/^[a-zA-Z0-9_.-]{8,120}$/),
  index: z.coerce.number().int().min(0),
  totalChunks: z.coerce.number().int().min(1).max(100000),
  offset: z.coerce.number().int().min(0),
  totalSize: z.coerce.number().int().min(1),
  chunkSize: z.coerce.number().int().min(1).optional(),
  overwrite: z.coerce.boolean().default(false)
});

export type ChunkUploadQuery = z.infer<typeof chunkUploadQuery>;

type HttpErrors = {
  payloadTooLarge: (message: string) => Error;
  badRequest: (message: string) => Error;
  conflict: (message: string) => Error;
};

export async function writeUploadChunk(input: {
  body: Readable;
  parentDir: string;
  filePath: string;
  query: ChunkUploadQuery;
  httpErrors: HttpErrors;
  uploadLimit?: number;
  uploadChunkLimit?: number;
}) {
  const uploadLimit = input.uploadLimit ?? fileUploadLimitBytes;
  const uploadChunkLimit = input.uploadChunkLimit ?? fileUploadChunkBytes;
  const { query, parentDir, filePath, body, httpErrors } = input;

  if (query.totalSize > uploadLimit) throw httpErrors.payloadTooLarge("Upload is too large");
  const tempFile = path.join(parentDir, `.upload-${query.uploadId}.part`);
  const expectedTempSize = query.index === 0 ? 0 : query.offset;
  const finishUpload = async (receivedBytes: number) => {
    if (receivedBytes !== query.totalSize) {
      throw httpErrors.badRequest(`Final upload size mismatch. Expected ${query.totalSize}, received ${receivedBytes}.`);
    }
    if (query.overwrite) {
      await fs.rename(tempFile, filePath);
    } else {
      await fs.link(tempFile, filePath);
      await fs.rm(tempFile, { force: true });
    }
    return { ok: true as const, uploadId: query.uploadId, receivedBytes, complete: true as const };
  };
  const currentSize = await fs.stat(tempFile).then((stat) => stat.size).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      if (query.index === 0) return 0;
      return fs.stat(filePath).then((stat) => {
        if (stat.size === query.totalSize) return query.totalSize;
        throw httpErrors.conflict("Upload session expired or was interrupted. Start the upload again.");
      }).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code === "ENOENT") {
          throw httpErrors.conflict("Upload session expired or was interrupted. Start the upload again.");
        }
        throw statError;
      });
    }
    throw error;
  });
  if (currentSize === query.totalSize) {
    return { ok: true as const, uploadId: query.uploadId, receivedBytes: currentSize, complete: true as const };
  }
  const expectedChunkEnd = query.chunkSize ? query.offset + query.chunkSize : null;
  if (expectedChunkEnd && currentSize === expectedChunkEnd) {
    if (currentSize === query.totalSize || query.index === query.totalChunks - 1) {
      return finishUpload(currentSize);
    }
    return { ok: true as const, uploadId: query.uploadId, receivedBytes: currentSize, complete: false as const };
  }
  if (currentSize > expectedTempSize) {
    if (expectedChunkEnd && currentSize < expectedChunkEnd) {
      throw httpErrors.conflict(`Upload chunk is still being written. Expected ${expectedChunkEnd}, received ${currentSize}. Retry this chunk.`);
    }
    throw httpErrors.conflict(`Upload offset mismatch. Expected ${currentSize}, received ${query.offset}.`);
  }
  if (currentSize !== expectedTempSize) {
    throw httpErrors.conflict(`Upload offset mismatch. Expected ${currentSize}, received ${query.offset}.`);
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > uploadChunkLimit || query.offset + bytes > query.totalSize) {
        callback(httpErrors.payloadTooLarge("Upload chunk is too large"));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(body, limiter, createWriteStream(tempFile, { flags: query.index === 0 ? "w" : "a" }));
    const nextOffset = query.offset + bytes;
    const complete = query.index === query.totalChunks - 1;
    if (!complete) {
      return { ok: true as const, uploadId: query.uploadId, receivedBytes: nextOffset, complete: false as const };
    }
    return finishUpload(nextOffset);
  } catch (error) {
    if (query.index === 0) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
