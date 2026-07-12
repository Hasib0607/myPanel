import test from "node:test";
import assert from "node:assert/strict";
import { localRuntimeHealthUrl } from "./deploymentHealthUrl.js";

test("localRuntimeHealthUrl keeps empty health URL for sysagent default", () => {
  assert.equal(localRuntimeHealthUrl(null, 10000), null);
});

test("localRuntimeHealthUrl keeps loopback health URLs", () => {
  assert.equal(localRuntimeHealthUrl("http://127.0.0.1:10000/health", 10000), "http://127.0.0.1:10000/health");
  assert.equal(localRuntimeHealthUrl("http://localhost:10000/health", 10000), "http://localhost:10000/health");
});

test("localRuntimeHealthUrl converts public URLs to the local runtime port", () => {
  assert.equal(
    localRuntimeHealthUrl("https://fahpet.ebitan.store/health?ready=1", 10000),
    "http://127.0.0.1:10000/health?ready=1"
  );
});
