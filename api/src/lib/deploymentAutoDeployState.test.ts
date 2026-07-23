import assert from "node:assert/strict";
import test from "node:test";
import { deploymentNeedsRecoveryDeploy } from "./deploymentAutoDeployState.js";

test("auto deploy retries deployments that are failed with down health or running but down", () => {
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "FAILED", healthStatus: "DOWN" }), true);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "FAILED", healthStatus: "UNKNOWN" }), true);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "RUNNING", healthStatus: "DOWN" }), true);
});

test("auto deploy does not retry healthy, degraded, or stopped deployments only because the commit matches", () => {
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "FAILED", healthStatus: "DEGRADED" }), false);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "FAILED", healthStatus: "HEALTHY" }), false);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "RUNNING", healthStatus: "HEALTHY" }), false);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "STOPPED", healthStatus: "DOWN" }), false);
});
