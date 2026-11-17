import { createServer } from "node:net";

// The database can be unaware of older Supervisor/PM2 services. A short bind
// probe catches those listeners before assigning a port to a new project.
export function isLocalPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (server.listening) server.close(() => resolve(available));
      else resolve(available);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    server.on("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => finish(true));
  });
}
