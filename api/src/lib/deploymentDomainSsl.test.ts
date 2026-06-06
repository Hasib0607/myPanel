import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

test("subdomain bindings fall back to the file-manager subdomain root", async () => {
  const { boundDomainFromBinding, deploymentFallbackRootPath } = await import("./deploymentDomainSsl.js");
  const bound = boundDomainFromBinding({
    subdomain: {
      id: "sub_1",
      name: "admin",
      sslEnabled: false,
      domainId: "dom_1",
      domain: { name: "example.com", documentRoot: "public_html" }
    }
  });

  assert.equal(bound?.name, "admin.example.com");
  assert.equal(bound?.includeWww, false);
  assert.equal(deploymentFallbackRootPath(bound)?.endsWith(path.join("example.com", "subdomains", "admin")), true);
});

test("only running deployments are routable through domain proxy vhosts", async () => {
  const { deploymentIsRoutable } = await import("./deploymentDomainSsl.js");
  assert.equal(deploymentIsRoutable({ status: "RUNNING" }), true);
  assert.equal(deploymentIsRoutable({ status: "STOPPED" }), false);
  assert.equal(deploymentIsRoutable({ status: "FAILED" }), false);
  assert.equal(deploymentIsRoutable(null), false);
});

test("wildcard deployment certificates use the safe certbot lineage name", async () => {
  const { deploymentSslCertificatePaths } = await import("./deploymentDomainSsl.js");
  const paths = deploymentSslCertificatePaths({
    id: "subdomain:sub_1",
    name: "*.ebitans.store",
    forceSsl: true
  });

  assert.equal(paths.sslCertificate, "/etc/letsencrypt/live/wildcard.ebitans.store/fullchain.pem");
  assert.equal(paths.sslCertificateKey, "/etc/letsencrypt/live/wildcard.ebitans.store/privkey.pem");
});

test("wildcard deployment skips HTTP ACME webroot preparation", async () => {
  const { ensureAcmeWebroot } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const original = sysagent.ensureAcmeWebroot;
  let calls = 0;
  sysagent.ensureAcmeWebroot = async () => {
    calls += 1;
    throw new Error("should not be called for wildcard domains");
  };

  try {
    await ensureAcmeWebroot({ id: "subdomain:sub_1", name: "*.ebitans.store", forceSsl: true });
  } finally {
    sysagent.ensureAcmeWebroot = original;
  }

  assert.equal(calls, 0);
});
