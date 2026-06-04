import test from "node:test";
import assert from "node:assert/strict";
import { nginxProxyMissingDomainFailure } from "./deploymentFailureRuntimeRepairs.js";

test("recognizes the legacy no-domain nginx proxy null failure", () => {
  assert.equal(nginxProxyMissingDomainFailure(`
    [2026-06-04T07:16:16.641Z] CONFIGURING_PROXY: Nginx proxy config failed
    {"error":"Cannot read properties of null (reading 'name')"}
  `), true);
});

test("does not classify unrelated null property failures as missing-domain proxy failures", () => {
  assert.equal(nginxProxyMissingDomainFailure("Cannot read properties of null (reading 'name')"), false);
  assert.equal(nginxProxyMissingDomainFailure("CONFIGURING_PROXY completed"), false);
});
