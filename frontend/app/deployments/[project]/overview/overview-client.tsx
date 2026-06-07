"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Cpu, Database, FolderGit2, Globe2, HardDrive, HeartPulse, KeyRound, ListChecks, MemoryStick, Network, RefreshCw, TerminalSquare, Wrench } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { Deployment, DeploymentDoctorApproval, DeploymentDoctorResponse, DeploymentMetrics, PreflightResponse, QueueResponse } from "../../deployment-types";
import { ActionButton, DeploymentSummary, EmptyState, Metric, ProjectTabs, ResultNotice, actionIcon, formatDate, formatDuration, statusBadge } from "../../deployment-ui";

export function DeploymentOverviewClient({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["deployment", project],
    queryFn: () => apiGet<Deployment>(`/deployments/${project}`),
    refetchInterval: 8000
  });
  const doctor = useQuery({
    queryKey: ["deployment-doctor", project],
    queryFn: () => apiGet<DeploymentDoctorResponse>(`/deployments/${project}/doctor`),
    enabled: Boolean(detail.data),
    refetchInterval: 20_000
  });
  const metrics = useQuery({
    queryKey: ["deployment-metrics", project],
    queryFn: () => apiGet<DeploymentMetrics>(`/deployments/${project}/metrics`),
    enabled: Boolean(detail.data),
    refetchInterval: 15000
  });
  const approvals = useQuery({
    queryKey: ["deployment-doctor-approvals", project],
    queryFn: () => apiGet<DeploymentDoctorApproval[]>(`/deployments/${project}/doctor/approvals`),
    enabled: Boolean(detail.data),
    refetchInterval: 20_000
  });
  const [notice, setNotice] = useStateMessage();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
  };

  const action = useMutation({
    mutationFn: (name: "deploy" | "redeploy" | "pull" | "rollback" | "start" | "stop" | "restart" | "health" | "preflight") => apiPost<QueueResponse | PreflightResponse>(`/deployments/${project}/${name}`),
    onSuccess: async (_result, name) => {
      setNotice(`${name} requested.`);
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Action failed")
  });
  const repair = useMutation({
    mutationFn: (name: "auto" | "sync-runtime" | "health" | "restart" | "redeploy" | "rollback" | "set-node-memory" | "sync-public-env" | "rewrite-nginx" | "request-approval") => apiPost<any>(`/deployments/${project}/doctor/repair`, { action: name }),
    onSuccess: async (result, name) => {
      setNotice(result?.approvalRequired ? "Risky fix added to approval log." : `Doctor ${name} repair requested.`);
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ["deployment-doctor", project] }),
        queryClient.invalidateQueries({ queryKey: ["deployment-doctor-approvals", project] })
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Doctor repair failed")
  });
  const approvalAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" }) => apiPost(`/deployments/${project}/doctor/approvals/${id}/${action}`, {}),
    onSuccess: async (_result, input) => {
      setNotice(`Approval ${input.action} requested.`);
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ["deployment-doctor", project] }),
        queryClient.invalidateQueries({ queryKey: ["deployment-doctor-approvals", project] })
      ]);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Approval action failed")
  });

  const deployment = detail.data;

  return (
    <>
      <ProjectTabs active="overview" project={project} />
      <section className="space-y-6 p-8">
        {notice ? <ResultNotice message={notice} ok={!/failed|error|attention/i.test(notice)} /> : null}
        {deployment ? (
          <>
            <DeploymentSummary deployment={deployment} />
            <ResourceOverview metrics={metrics.data} loading={metrics.isLoading || metrics.isFetching} />

            <div className="flex flex-wrap items-center gap-2">
              {(["deploy", "redeploy", "pull", "rollback", "start", "stop", "restart"] as const).map((name) => (
                <ActionButton disabled={action.isPending} icon={actionIcon(name === "stop" ? "stop" : name === "rollback" || name === "redeploy" ? "rollback" : "deploy")} intent={name === "deploy" ? "primary" : name === "stop" ? "danger" : "default"} key={name} label={name} onClick={() => action.mutate(name)} />
              ))}
              <ActionButton disabled={action.isPending} icon={<ListChecks size={15} />} label="Preflight" onClick={() => action.mutate("preflight")} />
              <ActionButton disabled={action.isPending} icon={<HeartPulse size={15} />} label="Health" onClick={() => action.mutate("health")} />
            </div>

            {doctor.data ? (
              <div className="rounded-md border border-panel-line bg-white">
                <div className="flex items-center justify-between border-b border-panel-line p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Wrench size={16} />
                    Deployment Doctor
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${doctorBadge(doctor.data.status)}`}>{doctor.data.status}</span>
                    <button
                      className="rounded-md border border-panel-line px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                      disabled={doctor.isFetching}
                      onClick={() => doctor.refetch()}
                      type="button"
                    >
                      Diagnose
                    </button>
                    <button
                      className="rounded-md bg-panel-accent px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      disabled={repair.isPending || !doctor.data.recommendedAction}
                      onClick={() => repair.mutate("auto")}
                      type="button"
                    >
                      Auto Fix
                    </button>
                  </div>
                </div>
                  <div className="p-4">
                  <div className="text-sm font-medium">{doctor.data.summary}</div>
                  {doctor.data.resourceBudget ? (
                    <div className="mt-3 grid gap-2 rounded-md border border-panel-line bg-slate-50 p-3 text-xs text-panel-muted sm:grid-cols-2 lg:grid-cols-4">
                      <div><span className="font-semibold text-panel-ink">{doctor.data.resourceBudget.deployMemoryMb}MB</span><br />Deploy memory</div>
                      <div><span className="font-semibold text-panel-ink">{doctor.data.resourceBudget.nodeHeapMb}MB</span><br />Node heap</div>
                      <div><span className="font-semibold text-panel-ink">{doctor.data.resourceBudget.nextWorkers}</span><br />Next workers</div>
                      <div><span className="font-semibold text-panel-ink">{doctor.data.resourceBudget.appReserveMb}MB</span><br />App reserve</div>
                    </div>
                  ) : null}
                  <div className="mt-3 grid gap-2">
                    {doctor.data.checks.map((check) => (
                      <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm" key={check.key}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 font-medium">
                              <CheckCircle2 size={14} className={check.status === "pass" ? "text-emerald-700" : check.status === "warn" ? "text-amber-700" : "text-panel-danger"} />
                              {check.label}
                            </div>
                            <div className="mt-1 break-words text-xs text-panel-muted">{check.detail}</div>
                            {check.fix ? <div className="mt-2 text-xs text-slate-700">{check.fix}</div> : null}
                          </div>
                          {check.repairAction ? (
                            <button
                              className="shrink-0 rounded-md border border-panel-line bg-white px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                              disabled={repair.isPending}
                              onClick={() => repair.mutate(check.repairAction as "sync-runtime" | "health" | "restart" | "redeploy" | "rollback" | "set-node-memory" | "sync-public-env" | "rewrite-nginx" | "request-approval")}
                              type="button"
                            >
                              {check.repairAction}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  {(doctor.data.envSuggestions ?? []).length ? (
                    <div className="mt-4 rounded-md border border-panel-line bg-white p-3">
                      <div className="text-xs font-semibold uppercase text-panel-muted">Suggested Env Fixes</div>
                      <div className="mt-2 grid gap-2">
                        {doctor.data.envSuggestions.slice(0, 8).map((item) => (
                          <div className="flex items-center justify-between gap-3 text-xs" key={`${item.key}-${item.value}`}>
                            <div className="min-w-0">
                              <div className="truncate font-mono font-semibold">{item.key}={item.value}</div>
                              <div className="truncate text-panel-muted">{item.reason}</div>
                            </div>
                            <button
                              className="shrink-0 rounded-md border border-panel-line px-2 py-1 font-medium hover:bg-slate-50 disabled:opacity-50"
                              disabled={repair.isPending}
                              onClick={() => repair.mutate(item.repairAction as "set-node-memory" | "sync-public-env")}
                              type="button"
                            >
                              Apply
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(doctor.data.riskyActions ?? []).length ? (
                    <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-xs font-semibold uppercase text-amber-800">Approval Required</div>
                          <div className="mt-1 text-xs text-amber-900">These fixes change server packages, permissions, Supervisor, or Nginx routing.</div>
                        </div>
                        <button
                          className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                          disabled={repair.isPending}
                          onClick={() => repair.mutate("request-approval")}
                          type="button"
                        >
                          Request Approval
                        </button>
                      </div>
                      <div className="mt-3 grid gap-2">
                        {doctor.data.riskyActions.map((item) => (
                          <div className="rounded-md border border-amber-200 bg-white p-2 text-xs" key={item.key}>
                            <div className="font-semibold">{item.label}</div>
                            <div className="mt-1 text-amber-900">{item.reason}</div>
                            <code className="mt-2 block break-words rounded bg-slate-950 p-2 font-mono text-slate-100">{item.command}</code>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(approvals.data ?? []).length ? (
                    <div className="mt-4 rounded-md border border-panel-line bg-white p-3">
                      <div className="text-xs font-semibold uppercase text-panel-muted">Approval History</div>
                      <div className="mt-2 grid gap-2">
                        {(approvals.data ?? []).slice(0, 8).map((item) => (
                          <div className="rounded-md border border-panel-line bg-slate-50 p-2 text-xs" key={item.id}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-semibold">{item.label} <span className={`ml-2 rounded px-1.5 py-0.5 ${approvalBadge(item.status)}`}>{item.status}</span></div>
                                <div className="mt-1 text-panel-muted">{item.reason}</div>
                                <code className="mt-2 block break-words rounded bg-slate-950 p-2 font-mono text-slate-100">{item.command}</code>
                              </div>
                              {item.status === "PENDING" || item.status === "APPROVED" ? (
                                <div className="flex shrink-0 gap-1">
                                  <button className="rounded-md border border-panel-line bg-white px-2 py-1 font-medium hover:bg-slate-50 disabled:opacity-50" disabled={approvalAction.isPending} onClick={() => approvalAction.mutate({ id: item.id, action: "approve" })} type="button">Approve</button>
                                  <button className="rounded-md border border-red-200 bg-white px-2 py-1 font-medium text-panel-danger hover:bg-red-50 disabled:opacity-50" disabled={approvalAction.isPending} onClick={() => approvalAction.mutate({ id: item.id, action: "reject" })} type="button">Reject</button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(doctor.data.evidence ?? []).length ? (
                    <div className="mt-4">
                      <div className="text-xs font-semibold uppercase text-panel-muted">Evidence</div>
                      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{doctor.data.evidence.join("\n")}</pre>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
              <div className="space-y-6">
                <div className="rounded-md border border-panel-line bg-white">
                  <div className="border-b border-panel-line p-4 text-sm font-semibold">Build Pipeline</div>
                  <div className="grid grid-cols-2 gap-3 p-4 text-sm">
                    <Command label="Install" value={deployment.installCommand} />
                    <Command label="Build" value={deployment.buildCommand} />
                    <Command label="Start" value={deployment.startCommand} />
                    <Command label="Output" value={deployment.outputDirectory} />
                  </div>
                </div>

                <ResourceHistory metrics={metrics.data} />

                <div className="rounded-md border border-panel-line bg-white">
                  <div className="flex items-center justify-between border-b border-panel-line p-4">
                    <div className="text-sm font-semibold">Latest Releases</div>
                    <Link className="text-sm font-medium text-panel-accent" href={`/deployments/${project}/logs`}>View logs</Link>
                  </div>
                  <div className="divide-y divide-panel-line">
                    {(deployment.releases ?? []).slice(0, 6).map((release) => (
                      <div className="grid grid-cols-[160px_1fr_100px_160px] items-center gap-3 px-4 py-3 text-sm" key={release.id}>
                        {statusBadge(release.status)}
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{release.commitSha ?? release.id}</div>
                          <div className="mt-1 truncate text-xs text-panel-muted">{release.sourcePath ?? deployment.rootPath}</div>
                        </div>
                        <div className="text-xs text-panel-muted">{formatDuration(release.durationMs)}</div>
                        <div className="text-xs text-panel-muted">{formatDate(release.createdAt)}</div>
                      </div>
                    ))}
                    {(deployment.releases ?? []).length === 0 ? <div className="p-4 text-sm text-panel-muted">No release history yet.</div> : null}
                  </div>
                </div>
              </div>

              <aside className="space-y-3">
                <Metric icon={<FolderGit2 size={16} />} label="Source" value={`${deployment.sourceProvider}${deployment.githubRepo ? ` · ${deployment.githubOwner}/${deployment.githubRepo}` : ""}`} />
                <Metric icon={<Globe2 size={16} />} label="Domain" value={deployment.domain?.name ?? "Not linked"} />
                <Metric icon={<TerminalSquare size={16} />} label="Runtime" value={`${deployment.framework} · ${deployment.processManager ?? "no manager"} · :${deployment.port}`} />
                <Metric icon={<KeyRound size={16} />} label="Environment" value={`${deployment.env?.length ?? deployment._count?.env ?? 0} variables`} />
                <Metric icon={<Database size={16} />} label="Database" value={deployment.dbType ? `${deployment.dbType} · ${deployment.dbName ?? "pending"}` : "None"} />
                <Metric icon={<RefreshCw size={16} />} label="Updated" value={formatDate(deployment.updatedAt)} />
              </aside>
            </div>
          </>
        ) : detail.isLoading ? (
          <div className="rounded-md border border-panel-line bg-white p-8 text-sm text-panel-muted">Loading deployment...</div>
        ) : (
          <EmptyState title="Deployment not found" detail="The project slug or id did not return a deployment." />
        )}
      </section>
    </>
  );
}

function Command({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className="text-xs uppercase text-panel-muted">{label}</div>
      <div className="mt-2 break-words font-mono text-xs">{value || "-"}</div>
    </div>
  );
}

function ResourceOverview({ metrics, loading }: { metrics?: DeploymentMetrics; loading: boolean }) {
  const process = metrics?.process;
  const traffic = metrics?.traffic;
  return (
    <div className="grid gap-3 lg:grid-cols-4">
      <UsageCard icon={<MemoryStick size={17} />} label="RAM" value={loading && !metrics ? "Loading..." : formatBytes(process?.memoryBytes ?? 0)} detail={`${process?.processCount ?? 0} processes`} />
      <UsageCard icon={<Cpu size={17} />} label="CPU" value={`${(process?.cpuPercent ?? 0).toFixed(1)}%`} detail="live process usage" />
      <UsageCard icon={<HardDrive size={17} />} label="Storage" value={formatBytes(metrics?.storage.bytes ?? 0)} detail={metrics?.storage.rootPath ?? "-"} />
      <UsageCard icon={<Database size={17} />} label="DB storage" value={formatBytes(metrics?.database.sizeBytes ?? 0)} detail={metrics?.database.name ?? "No database"} />
      <UsageCard icon={<ArrowDownToLine size={17} />} label="Incoming traffic" value={formatBytes(traffic?.incomingBytes ?? 0)} detail="last 24h" />
      <UsageCard icon={<ArrowUpFromLine size={17} />} label="Outgoing traffic" value={formatBytes(traffic?.outgoingBytes ?? 0)} detail={`${traffic?.requests ?? 0} requests`} />
      <UsageCard icon={<Network size={17} />} label="Bandwidth" value={formatBytes(traffic?.bandwidthBytes ?? 0)} detail={traffic?.note ?? "last 24h"} />
      <UsageCard icon={<Activity size={17} />} label="Metrics" value={metrics?.ok === false ? "Unavailable" : "Live"} detail={metrics?.generatedAt ? formatDate(metrics.generatedAt) : "-"} />
    </div>
  );
}

function UsageCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-panel-line bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-panel-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-3 truncate text-xl font-semibold text-panel-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-panel-muted" title={typeof detail === "string" ? detail : undefined}>{detail}</div>
    </div>
  );
}

function ResourceHistory({ metrics }: { metrics?: DeploymentMetrics }) {
  const history = metrics?.history ?? [];
  return (
    <div className="rounded-md border border-panel-line bg-white">
      <div className="flex items-center justify-between border-b border-panel-line p-4">
        <div className="text-sm font-semibold">Last 24h Resource Usage</div>
        <span className="text-xs text-panel-muted">{history.length} samples</span>
      </div>
      <div className="grid gap-0 lg:grid-cols-2">
        <UsageTrend title="RAM" unit="bytes" values={history.map((sample) => ({ timestamp: sample.timestamp, value: sample.memoryBytes }))} />
        <UsageTrend title="CPU" unit="percent" values={history.map((sample) => ({ timestamp: sample.timestamp, value: sample.cpuPercent }))} />
      </div>
    </div>
  );
}

function UsageTrend({ title, unit, values }: { title: string; unit: "bytes" | "percent"; values: Array<{ timestamp: string; value: number }> }) {
  const recent = values.slice(-96);
  const current = recent.at(-1)?.value ?? 0;
  const peak = recent.reduce((max, item) => Math.max(max, item.value), 0);
  const average = recent.length ? recent.reduce((total, item) => total + item.value, 0) / recent.length : 0;
  const scale = Math.max(peak, unit === "percent" ? 100 : 1);
  return (
    <div className="min-w-0 border-b border-panel-line p-4 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase text-panel-muted">{title}</div>
        <div className="text-xs text-panel-muted">last 24h</div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <TrendStat label="Now" value={formatMetricValue(current, unit)} />
        <TrendStat label="Peak" value={formatMetricValue(peak, unit)} />
        <TrendStat label="Avg" value={formatMetricValue(average, unit)} />
      </div>
      <div className="mt-4 flex h-24 items-end gap-1 overflow-hidden rounded-md border border-panel-line bg-slate-50 px-2 py-2">
        {recent.length ? recent.map((item, index) => (
          <div
            className="min-w-[3px] flex-1 rounded-t bg-panel-accent"
            key={`${item.timestamp}-${index}`}
            style={{ height: `${Math.max(4, Math.min(100, (item.value / scale) * 100))}%` }}
            title={`${formatDate(item.timestamp)}: ${formatMetricValue(item.value, unit)}`}
          />
        )) : <div className="flex h-full w-full items-center justify-center text-xs text-panel-muted">Resource samples will appear after the next refresh.</div>}
      </div>
    </div>
  );
}

function TrendStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-2">
      <div className="text-[10px] uppercase text-panel-muted">{label}</div>
      <div className="mt-1 truncate font-semibold text-panel-ink">{value}</div>
    </div>
  );
}

function formatMetricValue(value: number, unit: "bytes" | "percent") {
  if (unit === "bytes") return formatBytes(value);
  return `${Number.isFinite(value) ? value.toFixed(1) : "0.0"}%`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function doctorBadge(status: "pass" | "warn" | "fail") {
  if (status === "pass") return "bg-emerald-50 text-emerald-700";
  if (status === "warn") return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-panel-danger";
}

function approvalBadge(status: string) {
  if (status === "EXECUTED") return "bg-emerald-50 text-emerald-700";
  if (status === "FAILED" || status === "REJECTED") return "bg-red-50 text-panel-danger";
  return "bg-amber-50 text-amber-700";
}

function useStateMessage() {
  const [message, setMessage] = useState("");
  return [message, setMessage] as [string, (message: string) => void];
}
