import assert from "node:assert/strict";
import test from "node:test";
import { deviceFingerprintDigest, deviceFingerprintMatches, deviceFingerprintStableDigest } from "./deviceFingerprint.js";

test("device fingerprint digest matches the same browser signal", () => {
  const digest = deviceFingerprintDigest("device-123", "Browser/1.0");
  assert.ok(digest);
  assert.equal(deviceFingerprintMatches(digest, deviceFingerprintDigest("device-123", "Browser/1.0")), true);
});

test("device fingerprint digest rejects missing or different browser signals", () => {
  const digest = deviceFingerprintDigest("device-123", "Browser/1.0");
  assert.equal(deviceFingerprintMatches(digest, null), false);
  assert.equal(deviceFingerprintMatches(digest, deviceFingerprintDigest("device-456", "Browser/1.0")), false);
  assert.equal(deviceFingerprintMatches(digest, deviceFingerprintDigest("device-123", "OtherBrowser/1.0")), false);
});

test("stable device fingerprint digest ignores user agent for trusted device registration", () => {
  assert.equal(deviceFingerprintStableDigest("device-123"), deviceFingerprintStableDigest("device-123"));
  assert.notEqual(deviceFingerprintStableDigest("device-123"), deviceFingerprintStableDigest("device-456"));
});
