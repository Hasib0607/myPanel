import assert from "node:assert/strict";
import test from "node:test";
import { deploymentNeedsRecoveryDeploy } from "./deploymentAutoDeployState.js";

test("auto deploy retries deployments that are failed or down even at the same commit", () => {
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "FAILED", healthStatus: "DOWN" }), true);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "RUNNING", healthStatus: "DOWN" }), true);
});

test("auto deploy does not retry healthy deployments only because the commit matches", () => {
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "RUNNING", healthStatus: "HEALTHY" }), false);
  assert.equal(deploymentNeedsRecoveryDeploy({ status: "STOPPED", healthStatus: "DOWN" }), false);
});
