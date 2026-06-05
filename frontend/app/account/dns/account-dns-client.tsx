"use client";

import { DnsZonePageContent } from "@/app/dns/dns-client";

export function AccountDnsClient() {
  return (
    <DnsZonePageContent
      bulkZoneActionPath="/account/domains/dns/bulk-zone-action"
      domainsApiBase="/account/domains"
      manageBase="/account/domains"
    />
  );
}
