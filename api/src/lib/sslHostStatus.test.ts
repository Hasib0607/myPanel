import test from "node:test";
import assert from "node:assert/strict";

test("host status rejects stale certificates whose SAN does not cover the hostname", async () => {
  const { sslHostStatus } = await import("./sslHostStatus.js");
  const status = sslHostStatus("need4home.xyz", {
    exists: true,
    expiry: "2026-10-20T00:00:00.000Z",
    names: ["boardkini.com", "www.boardkini.com"]
  }, null, { dnsStatus: "READY" });

  assert.equal(status.sslEnabled, false);
  assert.equal(status.status, "CERT_SAN_MISMATCH");
  assert.match(status.action, /Renew or issue/);
});

test("host status detects admin/default certificates served by nginx", async () => {
  const { sslHostStatus } = await import("./sslHostStatus.js");
  const status = sslHostStatus("need4home.xyz", {
    exists: true,
    expiry: "2026-10-20T00:00:00.000Z",
    names: ["need4home.xyz"]
  }, {
    exists: true,
    matches: false,
    subject: "CN=admin.ebitans.com",
    issuer: "Fake CA",
    names: ["admin.ebitans.com"]
  }, { dnsStatus: "READY" });

  assert.equal(status.sslEnabled, false);
  assert.equal(status.status, "HTTPS_ROUTE_MISMATCH");
  assert.match(status.message, /admin\.ebitans\.com/);
  assert.match(status.message, /default\/admin|stale vhost/);
});

test("host status reports CAA blocks before certificate repair advice", async () => {
  const { sslHostStatus } = await import("./sslHostStatus.js");
  const status = sslHostStatus("need4home.xyz", null, null, {
    dnsStatus: "MISMATCH",
    lastError: "CAA blocks Let's Encrypt. Current issue values: digicert.com. Found at need4home.xyz."
  });

  assert.equal(status.sslEnabled, false);
  assert.equal(status.status, "CAA_BLOCKED");
  assert.match(status.action, /CAA record/);
});

test("host status prioritizes DNS pending before SSL repair messaging", async () => {
  const { sslHostStatus } = await import("./sslHostStatus.js");
  const status = sslHostStatus("www.need4home.xyz", {
    exists: true,
    expiry: "2026-10-20T00:00:00.000Z",
    names: ["need4home.xyz", "www.need4home.xyz"]
  }, {
    exists: true,
    matches: true,
    names: ["need4home.xyz", "www.need4home.xyz"]
  }, {
    dnsStatus: "MISMATCH",
    lastError: "www.need4home.xyz resolves to 203.0.113.10, expected 72.60.235.117."
  });

  assert.equal(status.sslEnabled, false);
  assert.equal(status.status, "DNS_PENDING");
  assert.match(status.message, /203\.0\.113\.10/);
});

test("apex can be valid while www remains pending", async () => {
  const { sslHostStatus } = await import("./sslHostStatus.js");
  const cert = {
    exists: true,
    expiry: "2026-10-20T00:00:00.000Z",
    names: ["need4home.xyz"]
  };
  const apex = sslHostStatus("need4home.xyz", cert, { exists: true, matches: true, names: ["need4home.xyz"] }, { dnsStatus: "READY" });
  const www = sslHostStatus("www.need4home.xyz", cert, null, { dnsStatus: "READY" });

  assert.equal(apex.sslEnabled, true);
  assert.equal(apex.status, "VALID");
  assert.equal(www.sslEnabled, false);
  assert.equal(www.status, "CERT_SAN_MISMATCH");
});
