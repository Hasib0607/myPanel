"use client";

import { DnsZonePageContent } from "@/app/dns/dns-client";

export function AccountDnsClient() {
  return (
    <DnsZonePageContent
      domainsApiBase="/account/domains"
      editorApi={{
        recordsPath: (domainId) => `/account/domains/${domainId}/dns`,
        zonePath: (domainId) => `/account/domains/${domainId}/dns/zone`,
        createPath: (domainId) => `/account/domains/${domainId}/dns`,
        createPayload: (_domainId, draft) => ({
          type: draft.type,
          name: draft.name,
          value: draft.value,
          ttl: Number(draft.ttl),
          priority: draft.priority === "" ? null : Number(draft.priority)
        }),
        updatePath: (domainId, record) => `/account/domains/${domainId}/dns/${record.id}`,
        deletePath: (domainId, record) => `/account/domains/${domainId}/dns/${record.id}`
      }}
    />
  );
}
