import test from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret } from "./crypto.js";

test("encryptSecret stores reversible ciphertext without exposing plaintext", () => {
  const value = "sensitive-value";
  const encrypted = encryptSecret(value);

  assert.notEqual(encrypted, value);
  assert.equal(decryptSecret(encrypted), value);
});
