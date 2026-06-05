import { PageHeader } from "@/components/page-header";
import { DnsZoneEditor } from "@/components/dns-zone-editor";

type DnsRecordType = "ALL" | "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA";

export function DomainDnsClient({ domainId, initialType = "ALL" }: { domainId: string; initialType?: DnsRecordType }) {
  return (
    <>
      <PageHeader title="Manage DNS Records" description="Current records, type tabs, and raw BIND zone export for this domain." />
      <DnsZoneEditor domainId={domainId} initialType={initialType} />
    </>
  );
}
