import assert from "node:assert/strict";
import test from "node:test";
import { certificateIsDue, certificateIsUnexpired } from "./sslRenewalPolicy.js";
import { configuredNameServerGroups, matchingNameServerGroup } from "./nameServerMatching.js";

test("expired, missing and malformed certificates are never reusable", () => {
  const now = Date.parse("2026-09-05T00:00:00Z");
  for (const expiry of [null, undefined, "", "invalid", "2026-09-04T00:00:00Z"]) {
    assert.equal(certificateIsUnexpired(expiry, now), false);
    assert.equal(certificateIsDue(expiry, 30, now), true);
  }
  assert.equal(certificateIsDue("2026-10-20T00:00:00Z", 30, now), false);
  assert.equal(certificateIsDue("2026-09-10T00:00:00Z", 30, now), true);
});

test("auto renewal needs a complete hosting pair, including zones with legacy aliases", () => {
  const groups = configuredNameServerGroups(["ns1.ebitans.com", "ns2.ebitans.com"]);
  for (const actual of [[], ["ns1.ebitans.com"], ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"]]) {
    assert.equal(matchingNameServerGroup(groups, actual), null);
  }
  assert.ok(matchingNameServerGroup(groups, ["ns1.ebitans.com", "ns2.ebitans.com", "ns1.ecommercex.site", "ns2.ecommercex.site"]));
});
