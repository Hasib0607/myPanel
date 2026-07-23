export function nginxResourceName(value: string) {
  return value.replace(/^\*\./, "wildcard.").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isWildcardHostname(value: string) {
  return value.trim().startsWith("*.");
}

export function serverNameHasWildcard(value: string) {
  return value.split(/\s+/).some((hostname) => isWildcardHostname(hostname));
}

export function certbotCertificateName(value: string) {
  return nginxResourceName(value.trim().split(/\s+/)[0] ?? value);
}

export function certificateLookupName(value: string) {
  const first = value.trim().split(/\s+/)[0] ?? value;
  return isWildcardHostname(first) ? certbotCertificateName(first) : first;
}

export function wildcardProbeHostname(value: string) {
  const first = value.trim().split(/\s+/)[0] ?? value;
  if (!isWildcardHostname(first)) return first;
  return `vps-panel-wildcard-probe.${first.replace(/^\*\./, "")}`;
}
