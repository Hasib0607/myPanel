import { AccountShell } from "@/components/account-shell";
import { AccountDomainDnsClient } from "./account-domain-dns-client";

const dnsTypes = new Set(["ALL", "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]);
type DnsRecordType = "ALL" | "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA";

export default async function AccountDomainDnsPage({ params, searchParams }: { params: Promise<{ domain: string }>; searchParams: Promise<{ type?: string }> }) {
  const { domain } = await params;
  const { type } = await searchParams;
  const normalizedType = (type ?? "").toUpperCase();
  const initialType = (dnsTypes.has(normalizedType) ? normalizedType : "ALL") as DnsRecordType;

  return (
    <AccountShell>
      <AccountDomainDnsClient domainId={domain} initialType={initialType} />
    </AccountShell>
  );
}
