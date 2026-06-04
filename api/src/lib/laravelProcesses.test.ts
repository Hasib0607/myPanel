import assert from "node:assert/strict";
import test from "node:test";
import {
  inferredLaravelManagedProcesses,
  laravelManagedProgramName,
  normalizeLaravelManagedProcesses,
  queueGroupCommand,
  renderLaravelProcessCommand
} from "./laravelProcesses.js";

test("normalizes Laravel managed process defaults", () => {
  const config = normalizeLaravelManagedProcesses({});
  assert.equal(config.scheduler.enabled, false);
  assert.equal(config.horizon.command, "php artisan horizon");
  assert.deepEqual(config.queueGroups, []);
});

test("infers Octane and Reverb from Laravel environment", () => {
  const config = inferredLaravelManagedProcesses({
    OCTANE_SERVER: "openswoole",
    REVERB_APP_ID: "app"
  }, {});
  assert.equal(config.octane.enabled, true);
  assert.match(config.octane.command, /--server=openswoole/);
  assert.equal(config.reverb.enabled, true);
});

test("builds independent queue group commands and safe program names", () => {
  const config = normalizeLaravelManagedProcesses({
    queueGroups: [{
      id: "high-priority",
      name: "High priority",
      enabled: true,
      autoscale: true,
      desiredWorkers: 2,
      minWorkers: 1,
      maxWorkers: 5,
      queueNames: ["high", "default"]
    }]
  });
  assert.equal(queueGroupCommand(config.queueGroups[0]), "php artisan queue:work --queue=high,default --sleep=3 --tries=3 --timeout=90");
  assert.equal(laravelManagedProgramName("shop-app", "queue-high_priority"), "shop-app-queue-high-priority");
  assert.equal(renderLaravelProcessCommand("php artisan octane:start --port={PORT}", 10005), "php artisan octane:start --port=10005");
});
