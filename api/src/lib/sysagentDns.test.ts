import assert from "node:assert/strict";
import test from "node:test";
import { assertDnsZoneApplySucceeded } from "./sysagent.js";

test("accepts a verified live DNS zone apply", () => {
  const result = assertDnsZoneApplySucceeded("example.com", {
    rolledBack: false,
    zoneCheck: { returncode: 0 },
    confCheck: { returncode: 0 },
    reload: { returncode: 0 },
    localCheck: { returncode: 0, stdout: "ns1.example.com. admin.example.com. 1 3600 900 1209600 3600\n" }
  });
  assert.equal(result.rolledBack, false);
});

test("rejects a rolled back DNS zone apply even when HTTP succeeded", () => {
  assert.throws(() => assertDnsZoneApplySucceeded("example.com", {
    rolledBack: true,
    zoneCheck: { returncode: 0 },
    confCheck: { returncode: 0 },
    reload: { returncode: 1, stderr: "reload failed" },
    localCheck: { returncode: 1 }
  }), /DNS zone publish failed for example\.com/);
});

test("rejects an apply without a local authoritative SOA answer", () => {
  assert.throws(() => assertDnsZoneApplySucceeded("example.com", {
    rolledBack: false,
    zoneCheck: { returncode: 0 },
    confCheck: { returncode: 0 },
    reload: { returncode: 0 },
    localCheck: { returncode: 0, stdout: "" }
  }), /did not return an SOA record locally/);
});
