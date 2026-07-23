import test from "node:test";
import assert from "node:assert/strict";

test("CAA evaluation allows Let's Encrypt issue records", async () => {
  const { evaluateLetsEncryptCaaRecords } = await import("./publicDns.js");
  const result = evaluateLetsEncryptCaaRecords([{ tag: "issue", value: "letsencrypt.org" }]);

  assert.equal(result.allowed, true);
  assert.match(result.reason, /allows|restriction/i);
});

test("CAA evaluation blocks unrelated certificate authorities", async () => {
  const { evaluateLetsEncryptCaaRecords } = await import("./publicDns.js");
  const result = evaluateLetsEncryptCaaRecords([{ tag: "issue", value: "digicert.com" }]);

  assert.equal(result.allowed, false);
  assert.match(result.reason, /CAA blocks Let's Encrypt/);
});

test("CAA evaluation uses issuewild for wildcard certificates when present", async () => {
  const { evaluateLetsEncryptCaaRecords } = await import("./publicDns.js");
  const allowed = evaluateLetsEncryptCaaRecords([
    { tag: "issue", value: "digicert.com" },
    { tag: "issuewild", value: "letsencrypt.org" }
  ], { wildcard: true });
  const blocked = evaluateLetsEncryptCaaRecords([
    { tag: "issue", value: "letsencrypt.org" },
    { tag: "issuewild", value: "digicert.com" }
  ], { wildcard: true });

  assert.equal(allowed.allowed, true);
  assert.equal(blocked.allowed, false);
});
