import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLoopbackRuntimeUrls } from "./deploymentEnv.js";

test("repairs HTTPS URLs that target the deployment's plain HTTP loopback port", () => {
  const result = normalizeLoopbackRuntimeUrls({
    INTERNAL_PROXY_URL: "https://localhost:10002/bn/alternative-landing?preview=1",
    IPV4_PROXY_URL: "https://127.0.0.1:10002/api",
    IPV6_PROXY_URL: "https://[::1]:10002/api"
  }, 10002);

  assert.equal(result.INTERNAL_PROXY_URL, "http://localhost:10002/bn/alternative-landing?preview=1");
  assert.equal(result.IPV4_PROXY_URL, "http://127.0.0.1:10002/api");
  assert.equal(result.IPV6_PROXY_URL, "http://[::1]:10002/api");
});

test("leaves external URLs and other local service ports unchanged", () => {
  const env = {
    API_URL: "https://api.example.com/v2",
    LOCAL_TLS_SERVICE: "https://localhost:9443/api",
    PLAIN_RUNTIME: "http://localhost:10002/api",
    NOT_A_URL: "https://localhost:not-a-port"
  };

  assert.deepEqual(normalizeLoopbackRuntimeUrls(env, 10002), env);
});
