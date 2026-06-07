import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WebSocket } from "@fastify/websocket";
import { z } from "zod";
import { fileUploadLimitBytes } from "./fileUploadLimits.js";

const startSchema = z.object({
  type: z.literal("start"),
  parentPath: z.string().default("."),
  name: z.string(),
  uploadId: z.string().regex(/^[a-zA-Z0-9_.-]{8,120}$/),
  totalSize: z.coerce.number().int().min(1),
  overwrite: z.coerce.boolean().default(false)
});

const controlSchema = z.discriminatedUnion("type", [
  startSchema,
  z.object({ type: z.literal("finish") }),
  z.object({ type: z.literal("cancel") })
]);

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  kind: string;
  extension: string;
  size: number;
  modifiedAt: string;
  createdAt: string;
  permissions: string;
  mime: string | null;
  isHidden: boolean;
  isReadonly: boolean;
};

type UploadDeps = {
  uploadLimit: number;
  ensureParentFolderReady: (parentPath: string) => Promise<string>;
  safeChild: (parentPath: string, name: string) => string;
  statEntry: (filePath: string) => Promise<FileEntry>;
  httpErrors: {
    payloadTooLarge: (message: string) => Error;
    badRequest: (message: string) => Error;
    conflict: (message: string) => Error;
  };
};

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function isJsonMessage(raw: Buffer | string) {
  const first = typeof raw === "string" ? raw.trimStart().charCodeAt(0) : raw[0];
  return first === 0x7b; // {
}

export function attachFileUploadWebSocket(socket: WebSocket, deps: UploadDeps) {
  let tempFile = "";
  let filePath = "";
  let writeStream: ReturnType<typeof createWriteStream> | null = null;
  let receivedBytes = 0;
  let totalSize = 0;
  let sessionOverwrite = false;
  let closed = false;

  const cleanup = async (removeTemp: boolean) => {
    if (writeStream) {
      writeStream.destroy();
      writeStream = null;
    }
    if (removeTemp && tempFile) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
    tempFile = "";
    filePath = "";
    receivedBytes = 0;
    totalSize = 0;
  };

  const fail = async (message: string) => {
    if (closed) return;
    await cleanup(true);
    sendJson(socket, { type: "error", message });
    try { socket.close(); } catch { /* already closed */ }
  };

  socket.on("message", (raw: Buffer | string) => {
    void (async () => {
      if (closed) return;

      if (!isJsonMessage(raw)) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (!writeStream) {
          await fail("Upload stream started before session was ready.");
          return;
        }
        receivedBytes += chunk.byteLength;
        if (receivedBytes > totalSize) {
          await fail("Upload exceeded declared file size.");
          return;
        }
        if (!writeStream.write(chunk)) {
          await new Promise<void>((resolve) => writeStream!.once("drain", resolve));
        }
        if (receivedBytes % (4 * 1024 * 1024) < chunk.byteLength || receivedBytes === totalSize) {
          sendJson(socket, { type: "progress", receivedBytes, totalBytes: totalSize });
        }
        return;
      }

      let message: z.infer<typeof controlSchema>;
      try {
        message = controlSchema.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")));
      } catch (error) {
        await fail(error instanceof Error ? error.message : "Invalid upload control message.");
        return;
      }

      if (message.type === "cancel") {
        closed = true;
        await cleanup(true);
        sendJson(socket, { type: "cancelled" });
        try { socket.close(); } catch { /* already closed */ }
        return;
      }

      if (message.type === "start") {
        if (writeStream) {
          await fail("Upload session already started.");
          return;
        }
        if (message.totalSize > deps.uploadLimit) {
          await fail(`Upload is too large. Limit: ${deps.uploadLimit} bytes.`);
          return;
        }

        const parent = await deps.ensureParentFolderReady(message.parentPath);
        filePath = deps.safeChild(parent, message.name);
        sessionOverwrite = message.overwrite;
        if (!sessionOverwrite) {
          try {
            await fs.access(filePath);
            await fail("Target already exists");
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }

        tempFile = path.join(parent, `.upload-${message.uploadId}.part`);
        await fs.rm(tempFile, { force: true }).catch(() => undefined);
        totalSize = message.totalSize;
        receivedBytes = 0;
        writeStream = createWriteStream(tempFile, { flags: "w" });
        writeStream.on("error", (error) => {
          void fail(error instanceof Error ? error.message : "Could not write upload temp file.");
        });
        sendJson(socket, { type: "ready", uploadId: message.uploadId, totalBytes: totalSize });
        return;
      }

      if (!writeStream || !tempFile || !filePath) {
        await fail("Upload session is not active.");
        return;
      }

      await new Promise<void>((resolve, reject) => {
        writeStream!.end((error: Error | null | undefined) => (error ? reject(error) : resolve()));
      }).catch(async (error) => {
        await fail(error instanceof Error ? error.message : "Could not finalize upload temp file.");
      });
      if (closed) return;

      if (receivedBytes !== totalSize) {
        await fail(`Final upload size mismatch. Expected ${totalSize}, received ${receivedBytes}.`);
        return;
      }

      try {
        if (sessionOverwrite) {
          await fs.rename(tempFile, filePath);
        } else {
          await fs.link(tempFile, filePath);
          await fs.rm(tempFile, { force: true });
        }
      } catch (error) {
        await fail(error instanceof Error ? error.message : "Could not move uploaded file into place.");
        return;
      }

      writeStream = null;
      const file = await deps.statEntry(filePath);
      closed = true;
      sendJson(socket, { type: "complete", receivedBytes, totalBytes: totalSize, file });
      try { socket.close(); } catch { /* already closed */ }
    })().catch(async (error) => {
      await fail(error instanceof Error ? error.message : "Upload failed.");
    });
  });

  socket.on("close", () => {
    closed = true;
    void cleanup(true);
  });
}

export const fileWebSocketUploadLimitBytes = fileUploadLimitBytes;
