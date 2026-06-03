"use client";

import { useEffect, useState } from "react";
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

type SslQueueResponse = {
  queued: boolean;
  jobId: string;
};

type SslJobStatus = {
  id: string;
  name: string;
  state: "completed" | "failed" | "active" | "waiting" | "delayed" | "paused" | "prioritized" | "waiting-children" | string;
  failedReason?: string;
  returnvalue?: unknown;
  attemptsMade: number;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
};

type SslPreflight = {
  webRoot: string;
  includeWww: boolean;
  dnsChecks: Array<{ host: string; records: string[]; ok?: boolean; skipped?: boolean }>;
};

type SslClientProps = {
  domainId: string;
  subdomainId?: string;
  domainApiBase?: string;
  sslApiBase?: string;
};

export function SslClient({ domainId, subdomainId, domainApiBase = "/domains", sslApiBase = "/ssl" }: SslClientProps) {
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const sslBase = subdomainId ? `${sslApiBase}/subdomains/${subdomainId}` : `${sslApiBase}/domains/${domainId}`;
  const resourceKey = subdomainId ?? domainId;
  const domain = useQuery({ queryKey: ["domain", domainApiBase, domainId], queryFn: () => apiGet<DomainDetail>(`${domainApiBase}/${domainId}`) });
  const ssl = useQuery({ queryKey: ["ssl-status", sslApiBase, resourceKey], queryFn: () => apiGet<SslStatus>(`${sslBase}/status`) });
  const jobStatus = useQuery({
    queryKey: ["ssl-job", sslApiBase, activeJobId],
    queryFn: () => apiGet<SslJobStatus>(`${sslApiBase}/jobs/${activeJobId}`),
    enabled: Boolean(activeJobId),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "completed" || state === "failed" ? false : 2000;
    }
  });
  const update = useMutation({
    mutationFn: (forceSsl: boolean) => apiPatch(`${domainApiBase}/${domainId}`, { forceSsl }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["domain", domainApiBase, domainId] });
      await queryClient.invalidateQueries({ queryKey: ["ssl-status", sslApiBase, resourceKey] });
    }
  });
  const issue = useMutation({
    mutationFn: () => apiPost<SslQueueResponse>(`${sslBase}/issue`, {}),
    onSuccess: async (data) => {
      setActiveJobId(data.jobId);
      await queryClient.invalidateQueries({ queryKey: ["ssl-status", sslApiBase, resourceKey] });
    }
  });
  const renew = useMutation({
    mutationFn: () => apiPost<SslQueueResponse>(`${sslBase}/renew`, {}),
    onSuccess: async (data) => {
      setActiveJobId(data.jobId);
      await queryClient.invalidateQueries({ queryKey: ["ssl-status", sslApiBase, resourceKey] });
    }
  });
  const preflight = useMutation({
    mutationFn: () => apiPost<SslPreflight>(`${sslBase}/preflight`, {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ssl-status", sslApiBase, resourceKey] });
    }
  });

  useEffect(() => {
    if (jobStatus.data?.state === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["domain", domainApiBase, domainId] });
      void queryClient.invalidateQueries({ queryKey: ["ssl-status", sslApiBase, resourceKey] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  }, [domainApiBase, domainId, jobStatus.data?.state, queryClient, resourceKey, sslApiBase]);

  const status = ssl.data;
  const statusText = status?.state ?? "missing";
  const actionError = issue.error ?? renew.error ?? update.error ?? preflight.error ?? jobStatus.error;
  const actionErrorText = actionError instanceof Error ? actionError.message : null;
  const liveJobState = jobStatus.data?.state;
  const jobFailedReason = jobStatus.data?.failedReason;
  const jobIsRunning = Boolean(activeJobId && liveJobState && !["completed", "failed"].includes(liveJobState));
  const isBusy = issue.isPending || renew.isPending || update.isPending || preflight.isPending || jobIsRunning;
  const jobAgeSeconds = jobStatus.data ? Math.max(0, Math.round((Date.now() - jobStatus.data.timestamp) / 1000)) : 0;

  return (
    <>
      <PageHeader title={`${status?.domain ?? domain.data?.name ?? "Domain"} SSL`} description="Certificate status, expiry, force HTTPS, and one-click renewal." />
      <section className="p-8">
        <div className="space-y-5 rounded-md border border-panel-line bg-white p-5">
          {actionErrorText ? (
            <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle size={18} />
              {actionErrorText}
            </div>
          ) : null}

          {jobFailedReason ? (
            <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 shrink-0" size={18} />
              <div>
                <div className="font-semibold">SSL job failed</div>
                <div className="mt-1 whitespace-pre-wrap break-words">{jobFailedReason}</div>
              </div>
            </div>
          ) : null}

          {activeJobId && liveJobState && liveJobState !== "failed" ? (
            <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <BadgeCheck size={18} />
              {liveJobState === "completed"
                ? "SSL job completed. Certificate status has been refreshed."
                : `SSL job ${liveJobState}. Waiting for worker... (${jobAgeSeconds}s)`}
            </div>
          ) : null}

          {preflight.data ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              SSL readiness check passed for {preflight.data.dnsChecks.filter((check) => !check.skipped).map((check) => check.host).join(", ")}.
              {preflight.data.dnsChecks.some((check) => check.skipped)
                ? ` Skipped ${preflight.data.dnsChecks.filter((check) => check.skipped).map((check) => check.host).join(", ")} because DNS is not pointed to this VPS.`
                : ""}
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
              <div className="mt-2 text-lg font-semibold">{status?.forceSsl ? "On" : "Off"}</div>
              <div className="mt-1 text-xs text-panel-muted">{status?.sslEnabled ? "Applied through Nginx vhost" : "Applies after certificate issue"}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {!subdomainId ? (
              <button className="rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={isBusy} onClick={() => update.mutate(!domain.data?.forceSsl)} type="button">
                Toggle Force HTTPS
              </button>
            ) : null}
            <button className="rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={isBusy} onClick={() => preflight.mutate()} type="button">
              Check Readiness
            </button>
            <button className="rounded-md bg-panel-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60" disabled={isBusy} onClick={() => issue.mutate()} type="button">
              Issue Certificate
            </button>
            <button className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={isBusy} onClick={() => renew.mutate()} type="button">
              <RefreshCw size={15} />
              Renew
            </button>
          </div>

          <div className="rounded-md border border-dashed border-panel-line p-4 text-sm text-panel-muted">
            Live SSL uses Certbot webroot validation, then writes a 443 Nginx vhost after the certificate succeeds. Subdomains get their own certificate and do not use the root domain certificate.
          </div>
        </div>
      </section>
    </>
  );
}
