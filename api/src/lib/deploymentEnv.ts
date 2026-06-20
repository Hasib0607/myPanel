const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

export function normalizeLoopbackRuntimeUrls(envVars: Record<string, string>, deploymentPort?: number) {
  if (!deploymentPort) return { ...envVars };

  return Object.fromEntries(Object.entries(envVars).map(([key, value]) => {
    if (!/^https:\/\//i.test(value)) return [key, value];

    try {
      const parsed = new URL(value);
      const port = parsed.port ? Number(parsed.port) : 443;
      if (LOOPBACK_HOSTS.has(parsed.hostname) && port === deploymentPort) {
        parsed.protocol = "http:";
        return [key, parsed.toString()];
      }
    } catch {
      // Preserve non-URL environment values exactly as supplied.
    }

    return [key, value];
  }));
}
