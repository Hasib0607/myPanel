export function nginxResourceName(value: string) {
  return value.replace(/^\*\./, "wildcard.").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function isWildcardHostname(value: string) {
  return value.trim().startsWith("*.");
}

export function certbotCertificateName(value: string) {
  return nginxResourceName(value.trim().split(/\s+/)[0] ?? value);
}
