import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestSysagentJson } from "./sysagent.js";

test("sysagent HTTP client waits for a delayed JSON response", async (t) => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }, 50);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await requestSysagentJson<{ ok: boolean }>(new URL(`http://127.0.0.1:${address.port}/build`), {
    method: "POST",
    body: JSON.stringify({ command: "npm run build" })
  }, 1000);
  assert.deepEqual(result, { ok: true });
});

test("sysagent HTTP client reports non-success response details", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("temporarily unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(
    requestSysagentJson(new URL(`http://127.0.0.1:${address.port}/build`), undefined, 1000),
    /failed with 503: temporarily unavailable/
  );
});
