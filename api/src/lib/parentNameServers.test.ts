import assert from "node:assert/strict";
import test from "node:test";
import { parseParentNameServers } from "./parentNameServers.js";

test("reads a registry referral without accepting unrelated NS records", () => {
  const response = `hasib.tech. 900 IN NS ns1.ebitans.com.\n` +
    `hasib.tech. 900 IN NS ns2.ebitans.com.\n` +
    `tech. 172800 IN NS ns01.trs-dns.com.\n`;
  assert.deepEqual(parseParentNameServers("hasib.tech", response), ["ns1.ebitans.com", "ns2.ebitans.com"]);
});
