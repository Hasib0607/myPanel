import test from "node:test";
import assert from "node:assert/strict";
import { runtimeInstallTargetsForComposerPlatformIssue } from "./deploymentRuntimeTools.js";

test("composer PHP 8.1 requirement on PHP 8.0 queues PHP 8.2 runtime repair", () => {
  const targets = runtimeInstallTargetsForComposerPlatformIssue(`
    carbonphp/carbon-doctrine-types 3.2.0 requires php ^8.1 -> your php version (8.0.30) does not satisfy that requirement.
    maennchen/zipstream-php 3.1.2 requires php-64bit ^8.2 -> your php-64bit version (8.0.30) does not satisfy that requirement.
  `);

  assert.deepEqual(targets.map((target) => target.actionKey), ["install-php82"]);
});
