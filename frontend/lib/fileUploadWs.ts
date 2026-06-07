type UploadCompleteFile = {
  name: string;
  path: string;
  size: number;
};

type ServerMessage =
  | { type: "ready"; uploadId: string; totalBytes: number }
  | { type: "progress"; receivedBytes: number; totalBytes: number }
  | { type: "complete"; receivedBytes: number; totalBytes: number; file: UploadCompleteFile }
  | { type: "error"; message: string }
  | { type: "cancelled" };

const FRAME_BYTES = 2 * 1024 * 1024;

function filesWebSocketUrl(apiPathBase: string) {
  const base = apiPathBase.startsWith("/")
    ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${apiPathBase}`
    : apiPathBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${base}/upload/ws`;
}

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), { once: true });
  });
}

function waitForSendDrain(ws: WebSocket) {
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (ws.bufferedAmount <= 8 * 1024 * 1024) {
        resolve();
        return;
      }
      window.setTimeout(tick, 20);
    };
    tick();
  });
}

async function sendFrame(ws: WebSocket, chunk: ArrayBuffer) {
  await waitForSendDrain(ws);
  ws.send(chunk);
}

function waitForServerMessage(ws: WebSocket, types: ServerMessage["type"][]) {
  return new Promise<ServerMessage>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data)) as ServerMessage;
        if (types.includes(data.type)) {
          cleanup();
          resolve(data);
        }
      } catch {
        // ignore non-json frames
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket upload failed."));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket upload closed before completion."));
    };
    const cleanup = () => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

export async function uploadFileViaWebSocket(input: {
  apiBase: string;
  parentPath: string;
  name: string;
  file: File;
  uploadId: string;
  overwrite: boolean;
  onProgress: (uploadedBytes: number, totalBytes: number) => void;
}) {
  const ws = new WebSocket(filesWebSocketUrl(input.apiBase));
  await waitForOpen(ws);

  ws.send(JSON.stringify({
    type: "start",
    parentPath: input.parentPath,
    name: input.name,
    uploadId: input.uploadId,
    totalSize: input.file.size,
    overwrite: input.overwrite
  }));

  const ready = await waitForServerMessage(ws, ["ready", "error"]);
  if (ready.type === "error") throw new Error(ready.message);

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(String(event.data)) as ServerMessage;
      if (data.type === "progress") {
        input.onProgress(data.receivedBytes, data.totalBytes);
      }
    } catch {
      // ignore
    }
  });

  for (let offset = 0; offset < input.file.size; offset += FRAME_BYTES) {
    const slice = input.file.slice(offset, Math.min(input.file.size, offset + FRAME_BYTES));
    await sendFrame(ws, await slice.arrayBuffer());
    input.onProgress(Math.min(input.file.size, offset + slice.size), input.file.size);
  }

  ws.send(JSON.stringify({ type: "finish" }));
  const done = await waitForServerMessage(ws, ["complete", "error"]);
  if (done.type === "error") throw new Error(done.message);
  input.onProgress(input.file.size, input.file.size);
  return done.file;
}
