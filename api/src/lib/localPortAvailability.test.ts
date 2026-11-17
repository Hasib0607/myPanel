import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { isLocalPortAvailable } from "./localPortAvailability.js";

test("rejects a live listener and accepts its port after release", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  assert.equal(await isLocalPortAvailable(port), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await isLocalPortAvailable(port), true);
});
