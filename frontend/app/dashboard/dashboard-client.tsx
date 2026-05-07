"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, Download, Play, Plus, RefreshCw, RotateCw, ServerCrash, Square, Terminal, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

type ServiceStatus = "healthy" | "down" | "pending";
type ManagedServiceAction = "install" | "start" | "stop" | "restart" | "enable" | "disable";

type DashboardData = {
  counts: {
    domains: number;
    activeDomains: number;
    suspendedDomains: number;
    dnsRecords: number;
    nameServers: number;
    mailboxes: number;
    deployments: number;
    firewallRules: number;
  };
  deploymentStatus: Array<{ status: string; count: number }>;
  systemStats:
    | {
        unavailable?: false;
        cpuPercent: number;
        loadAverage: number[];
        memory: { total: number; used: number; percent: number };
        disk: { total: number; used: number; free: number };
        network: Record<string, number>;
      }
    | { unavailable: true };
  services: Array<{
    key?: string;
    name: string;
    port: number;
    status: ServiceStatus;
    detail: string;
    installed?: boolean;
    manageable?: boolean;
    availableActions?: string[];
  }>;
  generatedAt: string;
};

type NameServer = {
  id: string;
  hostname: string;
  ipv4: string | null;
  ipv6: string | null;
  sortOrder: number;
  active: boolean;
};

type PanelUpdateStatus = {
  status: {
    state: "unknown" | "queued" | "running" | "succeeded" | "failed";
    message: string;
    branch?: string;
    commit?: string;
    commitSubject?: string;
    dirtyFiles?: string;
    updatedAt: string | null;
    logFile?: string;
  };
  recentLog: string[];
};

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function StatusIcon({ status }: { status: ServiceStatus }) {
  if (status === "healthy") return <CheckCircle2 className="text-emerald-600" size={17} />;
  if (status === "down") return <ServerCrash className="text-panel-danger" size={17} />;
  return <Clock3 className="text-panel-warn" size={17} />;
}

function Meter({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-panel-muted">{Math.round(value)}%</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div className="h-2 rounded-full bg-panel-accent" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      {detail ? <div className="mt-2 text-xs text-panel-muted">{detail}</div> : null}
    </div>
  );
}

function ServiceActionButton({ label, title, disabled, onClick, children }: { label: string; title: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-md border border-panel-line text-panel-muted hover:bg-slate-50 hover:text-panel-ink disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function ServiceActions({ serviceKey, status, installed, disabled, onAction }: { serviceKey: string; status: ServiceStatus; installed: boolean; disabled: boolean; onAction: (action: ManagedServiceAction) => void }) {
  if (!installed) {
    return (
      <div className="flex items-center gap-2">
        <ServiceActionButton disabled={disabled} label={`Install ${serviceKey}`} onClick={() => onAction("install")} title="Install service">
          <Download size={14} />
        </ServiceActionButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {status === "healthy" ? (
        <ServiceActionButton disabled={disabled} label={`Stop ${serviceKey}`} onClick={() => onAction("stop")} title="Stop service">
          <Square size={13} />
        </ServiceActionButton>
      ) : (
        <ServiceActionButton disabled={disabled} label={`Start ${serviceKey}`} onClick={() => onAction("start")} title="Start service">
          <Play size={14} />
        </ServiceActionButton>
      )}
      <ServiceActionButton disabled={disabled} label={`Restart ${serviceKey}`} onClick={() => onAction("restart")} title="Restart service">
        <RotateCw size={14} />
      </ServiceActionButton>
    </div>
  );
}

export function DashboardClient() {
  const queryClient = useQueryClient();
  const [nameServerForm, setNameServerForm] = useState({ hostname: "", ipv4: "", ipv6: "", sortOrder: 10 });
  const [nameServerError, setNameServerError] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);

  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiGet<DashboardData>("/dashboard"),
    refetchInterval: 10_000
  });
  const nameServers = useQuery({
    queryKey: ["nameservers"],
    queryFn: () => apiGet<NameServer[]>("/dns/nameservers")
  });
  const panelUpdate = useQuery({
    queryKey: ["panel-update-status"],
    queryFn: () => apiGet<PanelUpdateStatus>("/webhooks/panel-update/status"),
    refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.status.state ?? "") ? 5_000 : false
  });

  const refreshNameServers = async () => {
    await queryClient.invalidateQueries({ queryKey: ["nameservers"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const addNameServer = useMutation({
    mutationFn: () =>
      apiPost<NameServer>("/dns/nameservers", {
        hostname: nameServerForm.hostname,
        ipv4: nameServerForm.ipv4 || null,
        ipv6: nameServerForm.ipv6 || null,
        sortOrder: nameServerForm.sortOrder,
        active: true
      }),
    onSuccess: async () => {
      setNameServerError(null);
      setNameServerForm({ hostname: "", ipv4: "", ipv6: "", sortOrder: 10 });
      await refreshNameServers();
    },
    onError: (err) => setNameServerError(err instanceof Error ? err.message : "Could not add nameserver")
  });

  const createDefaults = useMutation({
    mutationFn: () => apiPost<NameServer[]>("/dns/nameservers/defaults"),
    onSuccess: async () => {
      setNameServerError(null);
      await refreshNameServers();
    },
    onError: (err) => setNameServerError(err instanceof Error ? err.message : "Could not create default nameservers")
  });

  const syncRecords = useMutation({
    mutationFn: () => apiPost<{ domains: number; nameServers: number; created: number; updated: number }>("/dns/nameservers/sync-records"),
    onSuccess: async () => {
      setNameServerError(null);
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setNameServerError(err instanceof Error ? err.message : "Could not sync DNS records")
  });

  const deleteNameServer = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/dns/nameservers/${id}`),
    onSuccess: refreshNameServers,
    onError: (err) => setNameServerError(err instanceof Error ? err.message : "Could not delete nameserver")
  });
  const serviceAction = useMutation({
    mutationFn: ({ serviceKey, action }: { serviceKey: string; action: ManagedServiceAction }) =>
      apiPost<{ serviceKey: string; action: string; result: { dryRun?: boolean; returncode?: number; stdout?: string; stderr?: string } }>(`/dashboard/services/${serviceKey}/${action}`),
    onSuccess: async (data) => {
      const dryRun = data.result?.dryRun ? "dry-run " : "";
      setServiceNotice(`${dryRun}${data.action} requested for ${data.serviceKey}`);
      await dashboard.refetch();
    },
    onError: (err) => setServiceNotice(err instanceof Error ? err.message : "Service action failed")
  });
  const rebuildPanel = useMutation({
    mutationFn: () => apiPost<{ accepted: boolean; queued: boolean; pid: number | null }>("/webhooks/panel-update/rebuild", {}),
    onSuccess: async () => {
      await panelUpdate.refetch();
    }
  });

  const data = dashboard.data;
  const statsUnavailable = data?.systemStats?.unavailable;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Server health, domain footprint, mail posture, and deployment activity."
        action={
          <button
            className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50"
            onClick={() => dashboard.refetch()}
            type="button"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
        }
      />
      <section className="space-y-6 p-8">
        {dashboard.isError ? (
          <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-panel-danger">
            <AlertTriangle size={18} />
            {dashboard.error instanceof Error ? dashboard.error.message : "Dashboard data could not be loaded."}
          </div>
        ) : null}

        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Domains" value={data?.counts.domains ?? "..."} />
          <StatCard label="Mailboxes" value={data?.counts.mailboxes ?? "..."} />
          <StatCard label="Deployments" value={data?.counts.deployments ?? "..."} />
          <StatCard label="Name Servers" value={data?.counts.nameServers ?? "..."} tone="warn" />
        </div>

        <div className="grid grid-cols-[1fr_380px] gap-6">
          <div className="rounded-md border border-panel-line bg-white">
            <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
              <div className="text-sm font-semibold">Service Health</div>
              <div className="text-xs text-panel-muted">{data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : "Loading..."}</div>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                <tr>
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Port</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3">Detail</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(data?.services ?? []).map((service) => (
                  <tr key={service.name} className="border-t border-panel-line">
                    <td className="px-4 py-3 font-medium">{service.name}</td>
                    <td className="px-4 py-3 text-panel-muted">{service.port}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <StatusIcon status={service.status} />
                        {service.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-panel-muted">{service.detail}</td>
                    <td className="px-4 py-3">
                      {service.key && service.manageable ? (
                        <ServiceActions
                          disabled={serviceAction.isPending}
                          installed={Boolean(service.installed)}
                          serviceKey={service.key}
                          status={service.status}
                          onAction={(action) => serviceAction.mutate({ serviceKey: service.key!, action })}
                        />
                      ) : (
                        <span className="text-xs text-panel-muted">system</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {serviceNotice ? <div className="border-t border-panel-line px-4 py-3 text-xs text-panel-muted">{serviceNotice}</div> : null}
          </div>

          <div className="space-y-6">
            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Terminal size={16} />
                    Panel Update
                  </div>
                  <div className="mt-1 text-xs text-panel-muted">Git push auto pull, build, migration, and service restart status.</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-60"
                    disabled={rebuildPanel.isPending || panelUpdate.data?.status.state === "queued" || panelUpdate.data?.status.state === "running"}
                    onClick={() => rebuildPanel.mutate()}
                    type="button"
                  >
                    <RotateCw size={14} />
                    Rebuild
                  </button>
                  <button
                    className="grid h-9 w-9 place-items-center rounded-md border border-panel-line hover:bg-slate-50"
                    onClick={() => panelUpdate.refetch()}
                    type="button"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>
              </div>
              <div className="mt-4 rounded-md border border-panel-line p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium capitalize">{panelUpdate.data?.status.state ?? "loading"}</span>
                  <span
                    className={[
                      "rounded-full px-2 py-1 text-xs font-semibold",
                      panelUpdate.data?.status.state === "queued" || panelUpdate.data?.status.state === "running" ? "bg-amber-50 text-amber-700" : "",
                      panelUpdate.data?.status.state === "succeeded" ? "bg-emerald-50 text-emerald-700" : "",
                      panelUpdate.data?.status.state === "failed" ? "bg-red-50 text-panel-danger" : "",
                      !panelUpdate.data || panelUpdate.data.status.state === "unknown" ? "bg-slate-100 text-panel-muted" : ""
                    ].join(" ")}
                  >
                    {panelUpdate.data?.status.updatedAt ? new Date(panelUpdate.data.status.updatedAt).toLocaleTimeString() : "No run yet"}
                  </span>
                </div>
                <div className="mt-2 text-xs text-panel-muted">{panelUpdate.data?.status.message ?? "Checking update status..."}</div>
                {panelUpdate.data?.status.commitSubject ? (
                  <div className="mt-2 text-xs font-medium text-panel-ink">{panelUpdate.data.status.commitSubject}</div>
                ) : null}
                {panelUpdate.data?.status.commit ? <div className="mt-1 font-mono text-xs text-panel-muted">Commit {panelUpdate.data.status.commit}</div> : null}
                {panelUpdate.data?.status.dirtyFiles ? (
                  <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-red-50 p-2 font-mono text-xs text-panel-danger">{panelUpdate.data.status.dirtyFiles}</pre>
                ) : null}
              </div>
              <div className="mt-3 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 font-mono text-xs text-slate-100">
                {(panelUpdate.data?.recentLog ?? []).slice(-8).map((line, index) => (
                  <div key={`${index}-${line}`} className="whitespace-pre-wrap break-words">{line}</div>
                ))}
                {panelUpdate.data?.recentLog.length === 0 ? <div className="text-slate-400">No update logs yet.</div> : null}
                {panelUpdate.isError ? <div className="text-red-200">{panelUpdate.error instanceof Error ? panelUpdate.error.message : "Could not load update status"}</div> : null}
                {rebuildPanel.isError ? <div className="text-red-200">{rebuildPanel.error instanceof Error ? rebuildPanel.error.message : "Could not start rebuild"}</div> : null}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="text-sm font-semibold">System Resources</div>
              <div className="mt-4 space-y-5">
                {!data || statsUnavailable ? (
                  <div className="rounded-md border border-dashed border-panel-line p-5 text-sm text-panel-muted">System agent stats unavailable.</div>
                ) : (
                  <>
                    <Meter label="CPU" value={data.systemStats.cpuPercent} detail={`Load ${data.systemStats.loadAverage.map((value) => value.toFixed(2)).join(" / ")}`} />
                    <Meter label="RAM" value={data.systemStats.memory.percent} detail={`${formatBytes(data.systemStats.memory.used)} of ${formatBytes(data.systemStats.memory.total)}`} />
                    <Meter
                      label="Disk"
                      value={(data.systemStats.disk.used / data.systemStats.disk.total) * 100}
                      detail={`${formatBytes(data.systemStats.disk.used)} used, ${formatBytes(data.systemStats.disk.free)} free`}
                    />
                  </>
                )}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="text-sm font-semibold">Domain Footprint</div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-md border border-panel-line p-3">
                  <div className="text-panel-muted">Active</div>
                  <div className="mt-1 text-lg font-semibold">{data?.counts.activeDomains ?? "..."}</div>
                </div>
                <div className="rounded-md border border-panel-line p-3">
                  <div className="text-panel-muted">Suspended</div>
                  <div className="mt-1 text-lg font-semibold">{data?.counts.suspendedDomains ?? "..."}</div>
                </div>
                <div className="rounded-md border border-panel-line p-3">
                  <div className="text-panel-muted">DNS Records</div>
                  <div className="mt-1 text-lg font-semibold">{data?.counts.dnsRecords ?? "..."}</div>
                </div>
                <div className="rounded-md border border-panel-line p-3">
                  <div className="text-panel-muted">Name Servers</div>
                  <div className="mt-1 text-lg font-semibold">{data?.counts.nameServers ?? "..."}</div>
                </div>
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Name Servers</div>
                  <div className="mt-1 text-xs text-panel-muted">Manage ns1/ns2 hostnames and sync them into domain DNS records.</div>
                </div>
                <button
                  className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                  disabled={createDefaults.isPending}
                  onClick={() => createDefaults.mutate()}
                  type="button"
                >
                  <Plus size={14} />
                  Defaults
                </button>
              </div>

              <form
                className="mt-4 grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  addNameServer.mutate();
                }}
              >
                <input
                  className="h-10 rounded-md border border-panel-line px-3 text-sm outline-none focus:border-panel-accent"
                  onChange={(event) => setNameServerForm((current) => ({ ...current, hostname: event.target.value }))}
                  placeholder="ns1.example.com"
                  value={nameServerForm.hostname}
                />
                <div className="grid grid-cols-[1fr_92px] gap-3">
                  <input
                    className="h-10 rounded-md border border-panel-line px-3 text-sm outline-none focus:border-panel-accent"
                    onChange={(event) => setNameServerForm((current) => ({ ...current, ipv4: event.target.value }))}
                    placeholder="129.121.99.82"
                    value={nameServerForm.ipv4}
                  />
                  <input
                    className="h-10 rounded-md border border-panel-line px-3 text-sm outline-none focus:border-panel-accent"
                    min={0}
                    onChange={(event) => setNameServerForm((current) => ({ ...current, sortOrder: Number(event.target.value) }))}
                    type="number"
                    value={nameServerForm.sortOrder}
                  />
                </div>
                <input
                  className="h-10 rounded-md border border-panel-line px-3 text-sm outline-none focus:border-panel-accent"
                  onChange={(event) => setNameServerForm((current) => ({ ...current, ipv6: event.target.value }))}
                  placeholder="IPv6 optional"
                  value={nameServerForm.ipv6}
                />
                <button
                  className="flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={addNameServer.isPending}
                  type="submit"
                >
                  <Plus size={16} />
                  Add nameserver
                </button>
              </form>

              {nameServerError ? <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-panel-danger">{nameServerError}</div> : null}

              <div className="mt-4 space-y-2">
                {(nameServers.data ?? []).map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-md border border-panel-line px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.hostname}</div>
                      <div className="truncate text-xs text-panel-muted">{[item.ipv4, item.ipv6].filter(Boolean).join(" / ") || "No address"}</div>
                    </div>
                    <button
                      aria-label={`Delete ${item.hostname}`}
                      className="grid h-8 w-8 place-items-center rounded-md border border-panel-line text-panel-muted hover:bg-red-50 hover:text-panel-danger disabled:opacity-50"
                      disabled={deleteNameServer.isPending}
                      onClick={() => deleteNameServer.mutate(item.id)}
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {nameServers.isLoading ? <div className="rounded-md border border-dashed border-panel-line p-3 text-sm text-panel-muted">Loading nameservers...</div> : null}
                {nameServers.data?.length === 0 ? <div className="rounded-md border border-dashed border-panel-line p-3 text-sm text-panel-muted">No nameservers saved yet.</div> : null}
              </div>

              <button
                className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
                disabled={syncRecords.isPending || (nameServers.data?.length ?? 0) === 0}
                onClick={() => syncRecords.mutate()}
                type="button"
              >
                <RotateCw size={16} />
                Sync DNS records
              </button>
              {syncRecords.data ? (
                <div className="mt-3 text-xs text-panel-muted">
                  Synced {syncRecords.data.nameServers} nameservers across {syncRecords.data.domains} domains. Created {syncRecords.data.created}, updated {syncRecords.data.updated}.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
