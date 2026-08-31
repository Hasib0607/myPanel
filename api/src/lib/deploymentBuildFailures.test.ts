import assert from "node:assert/strict";
import test from "node:test";
import {
  nextMiddlewareProxyIssue,
  nextMiddlewareProxyRepairEligible,
  nodeBuildTerminatedByMemorySignal
} from "./deploymentBuildFailures.js";

const mixedOomFailure = `Build failed with exit code -9 (SIGKILL):
The "middleware" file convention is deprecated. Please use "proxy" instead.
The process was killed by the OOM killer (SIGKILL).`;

test("recognizes kernel and supervisor memory termination signals", () => {
  for (const detail of [
    "exit code -9 (SIGKILL)",
    "exit code 137",
    "exit code -15 (SIGTERM)",
    "exit code 143",
    "JavaScript heap out of memory"
  ]) {
    assert.equal(nodeBuildTerminatedByMemorySignal(detail), true, detail);
  }
});

test("does not mutate Next middleware when a deprecation warning accompanies OOM", () => {
  assert.equal(nextMiddlewareProxyIssue(mixedOomFailure), true);
  assert.equal(nodeBuildTerminatedByMemorySignal(mixedOomFailure), true);
  assert.equal(nextMiddlewareProxyRepairEligible(mixedOomFailure), false);
});

test("keeps the proxy repair available for a convention-only failure", () => {
  const detail = 'Build failed with exit code 1: The "middleware" file convention is deprecated. Please use "proxy" instead.';
  assert.equal(nextMiddlewareProxyRepairEligible(detail), true);
});
