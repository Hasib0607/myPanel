import assert from "node:assert/strict";
import test from "node:test";
import { runtimeApprovalReadiness, runtimeInstallTargetsForReview } from "./deploymentRuntimeReview.js";

test("runtime review upgrades old PHP before installing Swoole", () => {
  const result = runtimeInstallTargetsForReview(
    ["php-ext-swoole"],
    [
      { name: "php", installed: true, version: "8.0" },
      { name: "php-ext-swoole", installed: false }
    ]
  );
  assert.equal(result.phpVersion, "8.0");
  assert.deepEqual(result.installable.map((item) => item.tool), ["php82", "php-swoole"]);
});

test("runtime review does not downgrade modern PHP for Swoole", () => {
  const result = runtimeInstallTargetsForReview(
    ["php-ext-swoole"],
    [
      { name: "php", installed: true, version: "8.3" },
      { name: "php-ext-swoole", installed: false }
    ]
  );
  assert.deepEqual(result.installable.map((item) => item.tool), ["php-swoole"]);
});

test("runtime approval allows skipped env-driven tools after selected installs pass", () => {
  const result = runtimeApprovalReadiness(
    ["php-ext-swoole"],
    ["php-ext-swoole", "php-ext-sodium"],
    ["php-sodium"],
    0
  );

  assert.equal(result.ready, true);
  assert.deepEqual(result.skippedMissing, ["php-ext-swoole"]);
  assert.deepEqual(result.blockingMissing, []);
});

test("runtime approval blocks failed or selected missing tools", () => {
  const failedInstall = runtimeApprovalReadiness(["php-ext-sodium"], ["php-ext-sodium"], ["php-sodium"], 1);
  assert.equal(failedInstall.ready, false);
  assert.deepEqual(failedInstall.blockingMissing, ["php-ext-sodium"]);

  const hardMissing = runtimeApprovalReadiness(["composer"], ["php-ext-swoole"], ["php-sodium"], 0);
  assert.equal(hardMissing.ready, false);
  assert.deepEqual(hardMissing.blockingMissing, ["composer"]);
});
