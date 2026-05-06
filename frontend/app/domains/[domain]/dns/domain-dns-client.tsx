import { PageHeader } from "@/components/page-header";
import { DnsZoneEditor } from "@/components/dns-zone-editor";

export function DomainDnsClient({ domainId }: { domainId: string }) {
  return (
    <>
      <PageHeader title="DNS Records" description="Per-domain visual DNS records and raw BIND zone editing." />
      <DnsZoneEditor domainId={domainId} />
    </>
  );
}
