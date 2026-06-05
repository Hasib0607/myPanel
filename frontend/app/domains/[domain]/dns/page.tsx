import { AppShell } from "@/components/app-shell";
import { DomainDnsClient } from "./domain-dns-client";

const dnsTypes = new Set(["ALL", "A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"]);

export default async function DomainDnsPage({ params, searchParams }: { params: Promise<{ domain: string }>; searchParams: Promise<{ type?: string }> }) {
  const { domain } = await params;
  const { type } = await searchParams;
  const initialType = dnsTypes.has((type ?? "").toUpperCase()) ? (type ?? "ALL").toUpperCase() : "ALL";

  return (
    <AppShell>
      <DomainDnsClient domainId={domain} initialType={initialType as "ALL" | "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA"} />
    </AppShell>
  );
}
