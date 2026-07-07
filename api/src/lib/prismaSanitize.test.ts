import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePrismaJson, sanitizePrismaText } from "./prismaSanitize.js";

test("sanitizePrismaText removes Postgres-rejected null bytes", () => {
  assert.equal(sanitizePrismaText("before\u0000after"), "beforeafter");
});

test("sanitizePrismaJson recursively removes null bytes from nested strings", () => {
  const value = sanitizePrismaJson({
    stdout: "ok\u0000",
    nested: {
      stderr: "\u0000failed",
      list: ["a\u0000b", 1, true, null]
    }
  });

  assert.deepEqual(value, {
    stdout: "ok",
    nested: {
      stderr: "failed",
      list: ["ab", 1, true, null]
    }
  });
});
