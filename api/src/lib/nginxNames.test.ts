import test from "node:test";
import assert from "node:assert/strict";
import { certbotCertificateName, isWildcardHostname, nginxResourceName, serverNameHasWildcard } from "./nginxNames.js";

test("nginxResourceName maps wildcard hostnames to safe config names", () => {
  assert.equal(nginxResourceName("*.ecommercex.site"), "wildcard.ecommercex.site");
  assert.equal(nginxResourceName("admin.ecommercex.site"), "admin.ecommercex.site");
});

test("isWildcardHostname detects wildcard hostnames", () => {
  assert.equal(isWildcardHostname("*.ecommercex.site"), true);
  assert.equal(isWildcardHostname("admin.ecommercex.site"), false);
});

test("serverNameHasWildcard detects wildcard names in nginx server_name values", () => {
  assert.equal(serverNameHasWildcard("*.ecommercex.site"), true);
  assert.equal(serverNameHasWildcard("ecommercex.site www.ecommercex.site"), false);
  assert.equal(serverNameHasWildcard("ecommercex.site *.ecommercex.site"), true);
});

test("certbotCertificateName keeps wildcard certificate directories shell-safe", () => {
  assert.equal(certbotCertificateName("*.ecommercex.site"), "wildcard.ecommercex.site");
  assert.equal(certbotCertificateName("ecommercex.site www.ecommercex.site"), "ecommercex.site");
});
