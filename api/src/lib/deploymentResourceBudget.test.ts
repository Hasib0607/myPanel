import test from "node:test";
import assert from "node:assert/strict";
import { calculateDeployMemoryBudget } from "./deploymentResourceBudget.js";

const defaults = {
  systemReserveMb: 4096,
  minAppReserveMb: 8192,
  appReserveMultiplier: 2,
  minDeployMemoryMb: 3072,
  maxDeployMemoryMb: 12288,
  fallbackMemoryMb: 4096
};

test("keeps the deploy minimum when projected app growth is the only constraint", () => {
  const budget = calculateDeployMemoryBudget({
    ...defaults,
    totalMemoryMb: 31834,
    availableMemoryMb: 11882,
    runningAppsMemoryMb: 13045
  });

  assert.equal(budget.budgetByTotal, 1648);
  assert.equal(budget.budgetByAvailable, 7786);
  assert.equal(budget.deployMemoryMb, 3072);
});

test("preserves the existing budget when total and available memory agree", () => {
  const budget = calculateDeployMemoryBudget({
    ...defaults,
    totalMemoryMb: 31834,
    availableMemoryMb: 12817,
    runningAppsMemoryMb: 11648
  });

  assert.equal(budget.budgetByTotal, 4442);
  assert.equal(budget.deployMemoryMb, 4442);
});

test("does not apply the safe floor when the OS is genuinely low on memory", () => {
  const budget = calculateDeployMemoryBudget({
    ...defaults,
    totalMemoryMb: 31834,
    availableMemoryMb: 5200,
    runningAppsMemoryMb: 13045
  });

  assert.equal(budget.budgetByAvailable, 1104);
  assert.equal(budget.deployMemoryMb, 1536);
});
