export function managedMailDnsValuePrefix(type: string, value: string) {
  if (type !== "TXT") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("v=spf1")) return "v=spf1";
  if (normalized.startsWith("v=dmarc1")) return "v=DMARC1";
  if (normalized.startsWith("v=dkim1")) return "v=DKIM1";
  return null;
}
