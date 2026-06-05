import { redirect } from "next/navigation";

const dnsTypes = new Set(["ALL", "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]);

export default async function LegacyAccountDomainDnsRedirectPage({
  params,
  searchParams
}: {
  params: Promise<{ domain: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { domain } = await params;
  const { type } = await searchParams;
  const normalizedType = (type ?? "").toUpperCase();
  const typeQuery = dnsTypes.has(normalizedType) ? `?type=${encodeURIComponent(normalizedType)}` : "";

  redirect(`/account/domains/${encodeURIComponent(domain)}/dns${typeQuery}`);
}
