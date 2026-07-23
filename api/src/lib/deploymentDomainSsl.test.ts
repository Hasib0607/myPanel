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

test("account domain webroot strips imported account-relative document roots", async () => {
  const { accountDomainWebRootPath } = await import("./deploymentDomainSsl.js");
  const account = { homeRoot: "/var/www/accounts/ebitans" };

  assert.equal(
    accountDomainWebRootPath(account, { name: "ebitans.com", documentRoot: "accounts/ebitans/public_html" }),
    "/var/www/accounts/ebitans/public_html"
  );
  assert.equal(
    accountDomainWebRootPath(account, { name: "need4home.xyz", documentRoot: "public_html" }),
    "/var/www/accounts/ebitans/need4home.xyz/public_html"
  );
  assert.equal(
    accountDomainWebRootPath(account, { name: "need4home.xyz", documentRoot: "need4home.xyz/public_html" }),
    "/var/www/accounts/ebitans/need4home.xyz/public_html"
  );
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

test("subdomain deployments reuse matching wildcard certificate paths", async () => {
  const { deploymentSslCertificatePathsWhenReady } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const original = sysagent.certificateFindReusable;
  sysagent.certificateFindReusable = async () => ({
    requested: "fahpet.ebitan.store",
    domain: "wildcard.ebitan.store",
    exists: true,
    expiry: null,
    names: ["*.ebitan.store"],
    certificate: "/etc/letsencrypt/live/wildcard.ebitan.store/fullchain.pem",
    privateKey: "/etc/letsencrypt/live/wildcard.ebitan.store/privkey.pem"
  });

  try {
    const paths = await deploymentSslCertificatePathsWhenReady({
      id: "subdomain:sub_1",
      name: "fahpet.ebitan.store",
      forceSsl: true
    });

    assert.equal(paths.sslCertificate, "/etc/letsencrypt/live/wildcard.ebitan.store/fullchain.pem");
    assert.equal(paths.sslCertificateKey, "/etc/letsencrypt/live/wildcard.ebitan.store/privkey.pem");
  } finally {
    sysagent.certificateFindReusable = original;
  }
});

test("apex deployment SSL paths require certificate to cover www too", async () => {
  const { deploymentSslCertificatePathsWhenReady } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const original = sysagent.certificateFindReusable;
  sysagent.certificateFindReusable = async () => ({
    requested: "example.com",
    domain: "example.com",
    exists: true,
    expiry: null,
    names: ["example.com"],
    certificate: "/etc/letsencrypt/live/example.com/fullchain.pem",
    privateKey: "/etc/letsencrypt/live/example.com/privkey.pem"
  });

  try {
    const paths = await deploymentSslCertificatePathsWhenReady({
      id: "dom_1",
      name: "example.com",
      forceSsl: true,
      includeWww: true
    });

    assert.deepEqual(paths, {});
  } finally {
    sysagent.certificateFindReusable = original;
  }
});

test("proxy publish ignores explicit certificates that do not cover the server name", async () => {
  const { publishDeploymentProxyNginx } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const originalFindReusable = sysagent.certificateFindReusable;
  const originalDeploymentNginx = sysagent.deploymentNginx;
  let request: any = null;

  sysagent.certificateFindReusable = async () => ({
    requested: "need4you.xyz",
    domain: "boardkini.com",
    exists: true,
    expiry: null,
    names: ["boardkini.com", "www.boardkini.com"],
    certificate: "/etc/letsencrypt/live/boardkini.com/fullchain.pem",
    privateKey: "/etc/letsencrypt/live/boardkini.com/privkey.pem"
  });
  sysagent.deploymentNginx = async (body: unknown) => {
    request = body;
    const ok = { returncode: 0, stdout: "", stderr: "" };
    return { write: ok, enable: ok, test: ok, reload: ok, configPath: "/etc/nginx/conf.d/domain-need4you.xyz.conf" };
  };

  try {
    await publishDeploymentProxyNginx({
      deploymentId: "dep_1",
      fqdn: "need4you.xyz",
      upstreamPort: 10000,
      rootPath: "/var/www/app",
      framework: "NEXTJS",
      fallbackRootPath: null,
      forceHttps: true,
      sslCertificate: "/etc/letsencrypt/live/need4you.xyz/fullchain.pem",
      sslCertificateKey: "/etc/letsencrypt/live/need4you.xyz/privkey.pem"
    });

    assert.equal(request.forceSsl, false);
    assert.equal("sslCertificate" in request, false);
    assert.equal("sslCertificateKey" in request, false);
  } finally {
    sysagent.certificateFindReusable = originalFindReusable;
    sysagent.deploymentNginx = originalDeploymentNginx;
  }
});

test("proxy publish keeps HTTP when apex certificate does not cover www", async () => {
  const { publishDeploymentProxyNginx } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const originalFindReusable = sysagent.certificateFindReusable;
  const originalDeploymentNginx = sysagent.deploymentNginx;
  let request: any = null;

  sysagent.certificateFindReusable = async () => ({
    requested: "need4home.xyz",
    domain: "need4home.xyz",
    exists: true,
    expiry: "2026-10-20T00:00:00.000Z",
    names: ["need4home.xyz"],
    certificate: "/etc/letsencrypt/live/need4home.xyz/fullchain.pem",
    privateKey: "/etc/letsencrypt/live/need4home.xyz/privkey.pem"
  });
  sysagent.deploymentNginx = async (body: unknown) => {
    request = body;
    const ok = { returncode: 0, stdout: "", stderr: "" };
    return { write: ok, enable: ok, test: ok, reload: ok, configPath: "/etc/nginx/conf.d/domain-need4home.xyz.conf" };
  };

  try {
    await publishDeploymentProxyNginx({
      deploymentId: "dep_1",
      fqdn: "need4home.xyz www.need4home.xyz",
      upstreamPort: 10000,
      rootPath: "/var/www/app",
      framework: "NEXTJS",
      fallbackRootPath: null,
      forceHttps: true
    });

    assert.equal(request.forceSsl, false);
    assert.equal("sslCertificate" in request, false);
  } finally {
    sysagent.certificateFindReusable = originalFindReusable;
    sysagent.deploymentNginx = originalDeploymentNginx;
  }
});

test("proxy publish reuses existing wildcard certificate for a child host", async () => {
  const { publishDeploymentProxyNginx } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const originalFindReusable = sysagent.certificateFindReusable;
  const originalDeploymentNginx = sysagent.deploymentNginx;
  let request: any = null;

  sysagent.certificateFindReusable = async () => ({
    requested: "shop.ebitans.store",
    domain: "wildcard.ebitans.store",
    exists: true,
    expiry: "2026-10-20T00:00:00.000Z",
    names: ["*.ebitans.store"],
    certificate: "/etc/letsencrypt/live/wildcard.ebitans.store/fullchain.pem",
    privateKey: "/etc/letsencrypt/live/wildcard.ebitans.store/privkey.pem"
  });
  sysagent.deploymentNginx = async (body: unknown) => {
    request = body;
    const ok = { returncode: 0, stdout: "", stderr: "" };
    return { write: ok, enable: ok, test: ok, reload: ok, configPath: "/etc/nginx/conf.d/domain-shop.ebitans.store.conf" };
  };

  try {
    await publishDeploymentProxyNginx({
      deploymentId: "dep_1",
      fqdn: "shop.ebitans.store",
      upstreamPort: 10000,
      rootPath: "/var/www/app",
      framework: "NEXTJS",
      fallbackRootPath: null,
      forceHttps: true
    });

    assert.equal(request.forceSsl, true);
    assert.equal(request.sslCertificate, "/etc/letsencrypt/live/wildcard.ebitans.store/fullchain.pem");
  } finally {
    sysagent.certificateFindReusable = originalFindReusable;
    sysagent.deploymentNginx = originalDeploymentNginx;
  }
});

test("proxy publish maps literal wildcard hosts to the certbot wildcard lineage", async () => {
  const { publishDeploymentProxyNginx } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const originalFindReusable = sysagent.certificateFindReusable;
  const originalDeploymentNginx = sysagent.deploymentNginx;
  const lookups: string[] = [];
  let request: any = null;

  sysagent.certificateFindReusable = async (domain: string) => {
    lookups.push(domain);
    return {
      requested: domain,
      domain: "wildcard.ebitans.store",
      exists: true,
      expiry: "2026-10-20T00:00:00.000Z",
      names: ["*.ebitans.store"],
      certificate: "/etc/letsencrypt/live/wildcard.ebitans.store/fullchain.pem",
      privateKey: "/etc/letsencrypt/live/wildcard.ebitans.store/privkey.pem"
    };
  };
  sysagent.deploymentNginx = async (body: unknown) => {
    request = body;
    const ok = { returncode: 0, stdout: "", stderr: "" };
    return { write: ok, enable: ok, test: ok, reload: ok, configPath: "/etc/nginx/conf.d/domain-wildcard.ebitans.store.conf" };
  };

  try {
    await publishDeploymentProxyNginx({
      deploymentId: "dep_1",
      fqdn: "*.ebitans.store",
      upstreamPort: 10000,
      rootPath: "/var/www/app",
      framework: "NEXTJS",
      fallbackRootPath: null,
      forceHttps: true
    });

    assert.deepEqual(lookups, ["wildcard.ebitans.store"]);
    assert.equal(request.forceSsl, true);
    assert.equal(request.sslCertificate, "/etc/letsencrypt/live/wildcard.ebitans.store/fullchain.pem");
  } finally {
    sysagent.certificateFindReusable = originalFindReusable;
    sysagent.deploymentNginx = originalDeploymentNginx;
  }
});

test("wildcard certificate names cover one-level child hosts only", async () => {
  const { certificateNamesCoverHost } = await import("./deploymentDomainSsl.js");
  assert.equal(certificateNamesCoverHost("shop.example.com", ["*.example.com"]), true);
  assert.equal(certificateNamesCoverHost("deep.shop.example.com", ["*.example.com"]), false);
  assert.equal(certificateNamesCoverHost("example.com", ["*.example.com"]), false);
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

test("subdomain SSL intent survives deploy certificate probe misses", async () => {
  const { syncDeploymentTlsWithCertificate } = await import("./deploymentDomainSsl.js");
  const { sysagent } = await import("./sysagent.js");
  const { prisma } = await import("./prisma.js");
  const originalFindReusable = sysagent.certificateFindReusable;
  const originalUpdate = prisma.subdomain.update;
  let updates = 0;

  sysagent.certificateFindReusable = async () => ({
    requested: "*.ebitans.store",
    domain: "*.ebitans.store",
    exists: false,
    expiry: null,
    names: [],
    certificate: "",
    privateKey: ""
  });
  (prisma.subdomain as any).update = async () => {
    updates += 1;
    throw new Error("subdomain sslEnabled should not be cleared");
  };

  try {
    const result = await syncDeploymentTlsWithCertificate({
      id: "subdomain:sub_1",
      name: "*.ebitans.store",
      forceSsl: true,
      sslEnabled: true
    });

    assert.equal(result.httpsReady, false);
    assert.equal(result.domain?.sslEnabled, true);
    assert.equal(result.domain?.forceSsl, true);
    assert.equal(updates, 0);
  } finally {
    sysagent.certificateFindReusable = originalFindReusable;
    (prisma.subdomain as any).update = originalUpdate;
  }
});

test("wildcard subdomain deployment binding matches one-level child hosts", async () => {
  const { subdomainBindingMatchesFqdn } = await import("./deploymentDomainSsl.js");
  const wildcard = { name: "*", domain: { name: "ecommercex.store" } };

  assert.equal(subdomainBindingMatchesFqdn(wildcard, "a9.ecommercex.store"), true);
  assert.equal(subdomainBindingMatchesFqdn(wildcard, "A10.ecommercex.store"), true);
  assert.equal(subdomainBindingMatchesFqdn(wildcard, "deep.a9.ecommercex.store"), false);
  assert.equal(subdomainBindingMatchesFqdn(wildcard, "ecommercex.store"), false);
});

test("exact subdomain deployment binding still matches only itself", async () => {
  const { subdomainBindingMatchesFqdn } = await import("./deploymentDomainSsl.js");
  const exact = { name: "admin", domain: { name: "ecommercex.store" } };

  assert.equal(subdomainBindingMatchesFqdn(exact, "admin.ecommercex.store"), true);
  assert.equal(subdomainBindingMatchesFqdn(exact, "a9.ecommercex.store"), false);
});

test("Next.js proxy requests always preserve the public Host", async () => {
  const { buildDeploymentNginxRequest } = await import("./deploymentDomainSsl.js");
  const request = buildDeploymentNginxRequest({
    deploymentId: "dep_1",
    fqdn: "ebitans.com",
    upstreamPort: 10002,
    rootPath: "/var/www/ebitans",
    framework: "NEXTJS",
    startCommand: "npm run preview",
    fallbackRootPath: null,
    forceSsl: true
  });

  assert.equal(request.loopbackProxyHost, false);
});

test("Vite preview may use a loopback Host", async () => {
  const { buildDeploymentNginxRequest } = await import("./deploymentDomainSsl.js");
  const request = buildDeploymentNginxRequest({
    deploymentId: "dep_2",
    fqdn: "spa.example.com",
    upstreamPort: 10003,
    rootPath: "/var/www/spa",
    framework: "NODEJS",
    startCommand: "npm run preview",
    fallbackRootPath: null,
    forceSsl: true
  });

  assert.equal(request.loopbackProxyHost, true);
});
