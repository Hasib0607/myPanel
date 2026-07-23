"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Mail, Network, ShieldCheck, Split, UploadCloud } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { apiGet } from "@/lib/api";

type DomainDetail = {
  id: string;
  name: string;
  status: string;
  sslEnabled: boolean;
  sslExpiry: string | null;
  liveSslEnabled?: boolean;
  liveSslExpiry?: string | null;
  sslHosts?: Array<{ host: string; sslEnabled?: boolean; covered?: boolean; expiry?: string | null }>;
  forceSsl: boolean;
  subdomains: Array<{ id: string; name: string; target: string; sslEnabled: boolean }>;
  dnsRecords: Array<{ id: string; type: string; name: string; value: string; ttl: number; priority: number | null }>;
  mailAccounts: Array<{ id: string; username: string; quotaMb: number; enabled: boolean }>;
  deployment: { id: string; name: string; status: string; framework: string; port: number } | null;
};

type Health = {
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};

export function DomainOverviewClient({ domainId }: { domainId: string }) {
  const domain = useQuery({
    queryKey: ["domain", domainId],
    queryFn: () => apiGet<DomainDetail>(`/domains/${domainId}`)
  });
  const health = useQuery({
    queryKey: ["domain-health", domainId],
    queryFn: () => apiGet<Health>(`/domains/${domainId}/health`)
  });

  const data = domain.data;
  const liveSslEnabled = Boolean(data?.liveSslEnabled);
  const sslValue = liveSslEnabled ? "Enabled" : data?.forceSsl ? "Pending" : "Off";
  const sslHosts = data?.sslHosts ?? [];

  return (
    <>
      <PageHeader title={data?.name ?? "Domain"} description="Domain health, SSL status, linked deployment, DNS, and mail summary." />
      <section className="space-y-6 p-8">
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="DNS Records" value={data?.dnsRecords.length ?? "..."} />
          <StatCard label="Subdomains" value={data?.subdomains.length ?? "..."} />
          <StatCard label="Mailboxes" value={data?.mailAccounts.length ?? "..."} />
          <StatCard label="SSL" value={sslValue} tone={liveSslEnabled ? "default" : "warn"} />
        </div>

        {sslHosts.length ? (
          <div className="grid grid-cols-2 gap-3">
            {sslHosts.map((host) => {
              const covered = Boolean(host.sslEnabled ?? host.covered);
              return (
                <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm" key={host.host}>
                  <div className="font-semibold text-panel-ink">{host.host}</div>
                  <div className={`mt-1 text-xs font-semibold ${covered ? "text-emerald-700" : "text-amber-700"}`}>
                    {covered ? "SSL valid" : data?.forceSsl ? "SSL pending" : "SSL off"}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="grid grid-cols-[1fr_360px] gap-6">
          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="mb-4 text-sm font-semibold">Health Checks</div>
            <div className="space-y-3">
              {(health.data?.checks ?? []).map((check) => (
                <div key={check.key} className="flex items-start gap-3 rounded-md border border-panel-line p-3 text-sm">
                  {check.ok ? <CheckCircle2 className="mt-0.5 text-emerald-600" size={17} /> : <CircleAlert className="mt-0.5 text-panel-warn" size={17} />}
                  <div>
                    <div className="font-medium">{check.label}</div>
                    <div className="text-panel-muted">{check.detail}</div>
                  </div>
                </div>
              ))}
              {!health.data ? <div className="rounded-md border border-dashed border-panel-line p-6 text-sm text-panel-muted">Loading health checks...</div> : null}
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="mb-4 text-sm font-semibold">Shortcuts</div>
            <div className="space-y-2 text-sm">
              <Link className="flex h-10 items-center gap-3 rounded-md border border-panel-line px-3 hover:bg-slate-50" href={`/domains/${domainId}/dns`}><Network size={16} /> DNS records</Link>
              <Link className="flex h-10 items-center gap-3 rounded-md border border-panel-line px-3 hover:bg-slate-50" href={`/domains/${domainId}/subdomains`}><Split size={16} /> Subdomains</Link>
              <Link className="flex h-10 items-center gap-3 rounded-md border border-panel-line px-3 hover:bg-slate-50" href={`/domains/${domainId}/ssl`}><ShieldCheck size={16} /> SSL</Link>
              <Link className="flex h-10 items-center gap-3 rounded-md border border-panel-line px-3 hover:bg-slate-50" href={`/domains/${domainId}/mail/accounts`}><Mail size={16} /> Mail accounts</Link>
              <Link className="flex h-10 items-center gap-3 rounded-md border border-panel-line px-3 hover:bg-slate-50" href="/deployments"><UploadCloud size={16} /> Link deployment</Link>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Linked Deployment</div>
          <div className="p-4 text-sm">
            {data?.deployment ? (
              <div className="grid grid-cols-4 gap-4">
                <div><div className="text-panel-muted">Name</div><div className="font-medium">{data.deployment.name}</div></div>
                <div><div className="text-panel-muted">Framework</div><div className="font-medium">{data.deployment.framework}</div></div>
                <div><div className="text-panel-muted">Status</div><div className="font-medium">{data.deployment.status}</div></div>
                <div><div className="text-panel-muted">Port</div><div className="font-medium">{data.deployment.port}</div></div>
              </div>
            ) : (
              <div className="text-panel-muted">No deployment linked yet.</div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
