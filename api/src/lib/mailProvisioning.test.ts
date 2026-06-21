import assert from "node:assert/strict";
import test from "node:test";
import { assertLiveMailProvisioning } from "./mailProvisioning.js";

test("accepts only a confirmed live mail-server mutation", () => {
  const result = { ok: true, dryRun: false };
  assert.equal(assertLiveMailProvisioning(result, "Mailbox"), result);
  assert.throws(() => assertLiveMailProvisioning({ ok: true, dryRun: true }, "Mailbox"), /not applied/);
  assert.throws(() => assertLiveMailProvisioning({ ok: false, dryRun: false }, "Mailbox"), /not applied/);
  assert.throws(() => assertLiveMailProvisioning(null, "Mailbox"), /not applied/);
});
