"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BadgeCheck, Clock, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

type DomainDetail = {
  id: string;
  name: string;
  sslEnabled: boolean;
  sslExpiry: string | null;
  forceSsl: boolean;
};

type SslStatus = {
  domain: string;
  sslEnabled: boolean;
  sslExpiry: string | null;
  forceSsl: boolean;
  state: "missing" | "expired" | "expiring" | "valid";
  daysRemaining: number | null;
  alert: boolean;
};

export function SslClient({ domainId }: { domainId: string }) {
  const queryClient = useQueryClient();
  const domain = useQuery({ queryKey: ["domain", domainId], queryFn: () => apiGet<DomainDetail>(`/domains/${domainId}`) });
  const ssl = useQuery({ queryKey: ["ssl-status", domainId], queryFn: () => apiGet<SslStatus>(`/ssl/domains/${domainId}/status`) });
  const update = useMutation({
    mutationFn: (forceSsl: boolean) => apiPatch(`/domains/${domainId}`, { forceSsl }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["domain", domainId] });
      await queryClient.invalidateQueries({ queryKey: ["ssl-status", domainId] });
    }
  });
  const issue = useMutation({
    mutationFn: () => apiPost(`/ssl/domains/${domainId}/issue`, {}),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["ssl-status", domainId] })
  });
  const renew = useMutation({
    mutationFn: () => apiPost(`/ssl/domains/${domainId}/renew`, {}),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["ssl-status", domainId] })
  });
  const markIssued = useMutation({
    mutationFn: () => apiPost(`/ssl/domains/${domainId}/mark-issued`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["domain", domainId] });
      await queryClient.invalidateQueries({ queryKey: ["ssl-status", domainId] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });

  const status = ssl.data;
  const statusText = status?.state ?? "missing";
  const actionError = issue.error ?? renew.error ?? update.error ?? markIssued.error;
  const actionErrorText = actionError instanceof Error ? actionError.message : null;
  const isBusy = issue.isPending || renew.isPending || update.isPending;

  return (
    <>
      <PageHeader title={`${domain.data?.name ?? "Domain"} SSL`} description="Certificate status, expiry, force HTTPS, and one-click renewal." />
      <section className="p-8">
        <div className="space-y-5 rounded-md border border-panel-line bg-white p-5">
          {actionErrorText ? (
            <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle size={18} />
              {actionErrorText}
            </div>
          ) : null}

          {issue.isSuccess || renew.isSuccess ? (
            <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <BadgeCheck size={18} />
              SSL job queued. Refresh after the worker finishes; failed Certbot runs will now stay visible instead of marking SSL as enabled.
            </div>
          ) : null}

          {status?.alert ? (
            <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle size={18} />
              SSL certificate is {status.state === "expired" ? "expired" : `expiring in ${status.daysRemaining} days`}.
            </div>
          ) : null}

          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="rounded-md border border-panel-line p-4">
              <div className="flex items-center gap-2 text-panel-muted"><BadgeCheck size={16} /> Certificate</div>
              <div className="mt-2 text-lg font-semibold">{status?.sslEnabled ? "Enabled" : "Not issued"}</div>
              <div className="mt-1 text-xs uppercase text-panel-muted">{statusText}</div>
            </div>
            <div className="rounded-md border border-panel-line p-4">
              <div className="flex items-center gap-2 text-panel-muted"><Clock size={16} /> Expiry</div>
              <div className="mt-2 text-lg font-semibold">{status?.sslExpiry ? new Date(status.sslExpiry).toLocaleDateString() : "-"}</div>
              <div className="mt-1 text-xs text-panel-muted">{status?.daysRemaining == null ? "No certificate" : `${status.daysRemaining} days remaining`}</div>
            </div>
            <div className="rounded-md border border-panel-line p-4">
              <div className="flex items-center gap-2 text-panel-muted"><ShieldCheck size={16} /> Force HTTPS</div>
              <div className="mt-2 text-lg font-semibold">{domain.data?.forceSsl ? "On" : "Off"}</div>
              <div className="mt-1 text-xs text-panel-muted">{status?.sslEnabled ? "Applied through Nginx vhost" : "Applies after certificate issue"}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className="rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={isBusy} onClick={() => update.mutate(!domain.data?.forceSsl)} type="button">
              Toggle Force HTTPS
            </button>
            <button className="rounded-md bg-panel-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60" disabled={isBusy} onClick={() => issue.mutate()} type="button">
              Issue Certificate
            </button>
            <button className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={isBusy} onClick={() => renew.mutate()} type="button">
              <RefreshCw size={15} />
              Renew
            </button>
            <button className="rounded-md border border-panel-line px-3 py-2 text-sm text-panel-muted hover:bg-slate-50 disabled:opacity-60" disabled={markIssued.isPending} onClick={() => markIssued.mutate()} type="button">
              Mark Issued Locally
            </button>
          </div>

          <div className="rounded-md border border-dashed border-panel-line p-4 text-sm text-panel-muted">
            Live SSL uses Certbot webroot validation, then writes a 443 Nginx vhost after the certificate succeeds. Port 80 and 443 must be open and the domain A records must point to this VPS.
          </div>
        </div>
      </section>
    </>
  );
}
