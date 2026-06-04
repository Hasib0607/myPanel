import test from "node:test";
import assert from "node:assert/strict";
import { githubApiErrorMessage, isGithubWebhookPermissionError } from "./githubApiErrors.js";

test("githubApiErrorMessage explains fine-grained webhook permission failures", () => {
  const message = githubApiErrorMessage(403, '{"message":"Resource not accessible by personal access token"}');
  assert.match(message, /Webhooks: Read and write/);
  assert.match(message, /manually adding/);
  assert.doesNotMatch(message, /Resource not accessible/);
});

test("githubApiErrorMessage keeps useful generic API failures", () => {
  assert.equal(githubApiErrorMessage(500, "server error"), "GitHub API failed with 500: server error");
});

test("isGithubWebhookPermissionError detects mapped permission messages", () => {
  assert.equal(isGithubWebhookPermissionError(new Error(githubApiErrorMessage(403, "Resource not accessible by personal access token"))), true);
  assert.equal(isGithubWebhookPermissionError(new Error("other failure")), false);
});
