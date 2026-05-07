import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("ensureDomainFileStructure creates cPanel-style default domain folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-panel-domain-files-"));
  process.env.FILE_MANAGER_ROOT = root;

  const { domainDefaultFolders, ensureDomainFileStructure } = await import("./domainFiles.js");
  const result = await ensureDomainFileStructure("Example.COM");

  assert.equal(result.domain, "example.com");
  assert.equal(result.relativeRoot, "example.com");

  const domainRoot = path.join(root, "example.com");
  for (const folder of domainDefaultFolders) {
    const stats = await fs.stat(path.join(domainRoot, folder));
    assert.equal(stats.isDirectory(), true);
  }

  const wellKnown = await fs.stat(path.join(domainRoot, "public_html", ".well-known"));
  assert.equal(wellKnown.isDirectory(), true);
  const acmeChallenge = await fs.stat(path.join(domainRoot, "public_html", ".well-known", "acme-challenge"));
  assert.equal(acmeChallenge.isDirectory(), true);

  const index = await fs.readFile(path.join(domainRoot, "public_html", "index.html"), "utf8");
  assert.match(index, /<h1>example\.com<\/h1>/);
});

test("ensureDomainFileStructure rejects unsafe domain folder names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-panel-domain-files-"));
  process.env.FILE_MANAGER_ROOT = root;

  const { ensureDomainFileStructure } = await import("./domainFiles.js");
  await assert.rejects(() => ensureDomainFileStructure("../example.com"), /Invalid domain folder name/);
});
