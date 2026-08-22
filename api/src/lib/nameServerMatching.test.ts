import assert from "node:assert/strict";
import test from "node:test";
import { configuredNameServerGroups, matchingNameServerGroup, nameServerAlternativesText } from "./nameServerMatching.js";

const groups = configuredNameServerGroups([
  "ns1.ebitans.com",
  "ns2.ebitans.com.",
  "ns1.ecommercex.store",
  "ns2.ecommercex.store"
]);

test("groups configured nameservers into alternative provider pairs", () => {
  assert.deepEqual(groups, [
    ["ns1.ebitans.com", "ns2.ebitans.com"],
    ["ns1.ecommercex.store", "ns2.ecommercex.store"]
  ]);
});

test("accepts any complete configured nameserver group", () => {
  assert.deepEqual(matchingNameServerGroup(groups, ["ns2.ebitans.com", "ns1.ebitans.com"]), groups[0]);
  assert.deepEqual(matchingNameServerGroup(groups, ["ns1.ecommercex.store", "ns2.ecommercex.store"]), groups[1]);
});

test("rejects incomplete or mixed nameserver groups", () => {
  assert.equal(matchingNameServerGroup(groups, ["ns1.ebitans.com"]), null);
  assert.equal(matchingNameServerGroup(groups, ["ns1.ebitans.com", "ns2.ecommercex.store"]), null);
});

test("formats configured groups as alternatives", () => {
  assert.equal(
    nameServerAlternativesText(groups),
    "ns1.ebitans.com, ns2.ebitans.com OR ns1.ecommercex.store, ns2.ecommercex.store"
  );
});
