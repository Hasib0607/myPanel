import { AppShell } from "@/components/app-shell";
import { DomainDnsClient } from "./domain-dns-client";

export default async function DomainDnsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <DomainDnsClient domainId={domain} />
    </AppShell>
  );
}
