"use client";

import { PageHeader } from "@/components/page-header";
import { DnsZoneEditor } from "@/components/dns-zone-editor";

type DnsRecordType = "ALL" | "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA";

export function AccountDomainDnsClient({ domainId, initialType = "ALL" }: { domainId: string; initialType?: DnsRecordType }) {
  return (
    <>
      <PageHeader title="Manage DNS Records" description="Current records, type tabs, and raw BIND zone export for this domain." />
      <DnsZoneEditor
        api={{
          recordsPath: (id) => `/account/domains/${id}/dns`,
          zonePath: (id) => `/account/domains/${id}/dns/zone`,
          createPath: (id) => `/account/domains/${id}/dns`,
          createPayload: (_id, draft) => ({
            type: draft.type,
            name: draft.name,
            value: draft.value,
            ttl: Number(draft.ttl),
            priority: draft.priority === "" ? null : Number(draft.priority)
          }),
          updatePath: (id, record) => `/account/domains/${id}/dns/${record.id}`,
          deletePath: (id, record) => `/account/domains/${id}/dns/${record.id}`
        }}
        domainId={domainId}
        initialType={initialType}
      />
    </>
  );
}
