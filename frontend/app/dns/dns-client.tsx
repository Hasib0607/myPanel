"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { DnsZoneEditor } from "@/components/dns-zone-editor";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/api";

type Domain = {
  id: string;
  name: string;
};

type DomainListResponse = {
  items: Domain[];
  total: number;
};

export function DnsClient() {
  const [selectedDomainId, setSelectedDomainId] = useState("");
  const domains = useQuery({
    queryKey: ["domains", "dns-selector"],
    queryFn: () => apiGet<DomainListResponse>("/domains?page=1&pageSize=100")
  });

  const effectiveDomainId = selectedDomainId || domains.data?.items[0]?.id || "";

  return (
    <AppShell>
      <PageHeader
        title="DNS Zone Control"
        description="Visual BIND9 zone editor with raw-zone export for advanced review."
        action={
          <select className="h-10 min-w-64 rounded-md border border-panel-line bg-white px-3 text-sm" onChange={(event) => setSelectedDomainId(event.target.value)} value={effectiveDomainId}>
            {(domains.data?.items ?? []).map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
          </select>
        }
      />
      {effectiveDomainId ? (
        <DnsZoneEditor domainId={effectiveDomainId} />
      ) : (
        <section className="p-8">
          <div className="rounded-md border border-panel-line bg-white p-8 text-center text-sm text-panel-muted">Add a domain before editing DNS records.</div>
        </section>
      )}
    </AppShell>
  );
}
