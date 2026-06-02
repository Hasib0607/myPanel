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
