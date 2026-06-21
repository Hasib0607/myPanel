import assert from "node:assert/strict";
import test from "node:test";
import { managedMailDnsValuePrefix } from "./mailDns.js";

test("identifies only mail-policy TXT records", () => {
  assert.equal(managedMailDnsValuePrefix("TXT", "v=spf1 mx ~all"), "v=spf1");
  assert.equal(managedMailDnsValuePrefix("TXT", " V=DMARC1; p=reject"), "v=DMARC1");
  assert.equal(managedMailDnsValuePrefix("TXT", "v=DKIM1; k=rsa; p=key"), "v=DKIM1");
  assert.equal(managedMailDnsValuePrefix("TXT", "google-site-verification=keep-me"), null);
  assert.equal(managedMailDnsValuePrefix("MX", "mail.example.com"), null);
});
