export function githubApiErrorMessage(status: number, detail = "") {
  if (status === 403 && /resource not accessible by personal access token/i.test(detail)) {
    return "GitHub token cannot manage repository webhooks. For a fine-grained personal access token, grant this repository Webhooks: Read and write permission, then reconnect the token. You can still enable auto deploy by manually adding the generated webhook URL and secret in GitHub.";
  }
  if (status === 404 && /not found/i.test(detail)) {
    return "GitHub repository was not found or the connected token cannot access it.";
  }
  return `GitHub API failed with ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
}

export function isGithubWebhookPermissionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /GitHub token cannot manage repository webhooks/i.test(message)
    || /Resource not accessible by personal access token/i.test(message);
}
