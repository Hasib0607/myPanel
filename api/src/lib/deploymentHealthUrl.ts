function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0" || normalized.startsWith("127.");
}

export function localRuntimeHealthUrl(healthUrl: string | null | undefined, port: number) {
  if (!healthUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(healthUrl);
  } catch {
    return healthUrl;
  }

  if (isLoopbackHostname(parsed.hostname)) return healthUrl;
  return `http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
}
