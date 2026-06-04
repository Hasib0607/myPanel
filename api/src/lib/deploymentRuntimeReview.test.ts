import assert from "node:assert/strict";
import test from "node:test";
import { runtimeInstallTargetsForReview } from "./deploymentRuntimeReview.js";

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
