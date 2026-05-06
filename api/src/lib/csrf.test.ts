import test from "node:test";
import assert from "node:assert/strict";
import { createCsrfToken, validCsrfPair } from "./csrf.js";

test("createCsrfToken returns high-entropy url-safe tokens", () => {
  const token = createCsrfToken();

  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(token.length >= 32);
});

test("validCsrfPair requires matching cookie and header values", () => {
  const token = createCsrfToken();

  assert.equal(validCsrfPair(token, token), true);
  assert.equal(validCsrfPair(token, `${token}x`), false);
  assert.equal(validCsrfPair(undefined, token), false);
  assert.equal(validCsrfPair(token, undefined), false);
});
