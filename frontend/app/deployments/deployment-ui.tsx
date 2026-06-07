"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Activity, CheckCircle2, CircleAlert, CircleDot, Clock3, GitBranch, HeartPulse, Play, RotateCcw, Square } from "lucide-react";
import type { Deployment, DeploymentHealthStatus, DeploymentLog, DeploymentStatus, ReleaseStatus } from "./deployment-types";

const statusClasses: Record<DeploymentStatus | ReleaseStatus, string> = {
  BUILDING: "bg-blue-50 text-blue-700 border-blue-200",
  CANCELLED: "bg-slate-50 text-slate-600 border-slate-200",
  DEPLOYING: "bg-blue-50 text-blue-700 border-blue-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  QUEUED: "bg-amber-50 text-amber-700 border-amber-200",
  ROLLED_BACK: "bg-slate-50 text-slate-600 border-slate-200",
  RUNNING: "bg-emerald-50 text-emerald-700 border-emerald-200",
  STOPPED: "bg-slate-50 text-slate-600 border-slate-200",
  SUCCEEDED: "bg-emerald-50 text-emerald-700 border-emerald-200"
};

const healthClasses: Record<DeploymentHealthStatus, string> = {
  DEGRADED: "text-amber-700",
  DOWN: "text-red-700",
  HEALTHY: "text-emerald-700",
  UNKNOWN: "text-slate-500"
};

export function queryString(values: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  return params.toString();
}

export function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "-";
}

export function formatLogTime(value?: string | null) {
  if (!value) return "--:--:--";
  const d = new Date(value);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function logMetadataPreview(metadata: DeploymentLog["metadata"]) {
  if (!metadata || typeof metadata !== "object") return "";
  try {
    const text = JSON.stringify(metadata, null, 2);
    return text === "{}" ? "" : text;
  } catch {
    return "";
  }
}

export function formatDuration(ms?: number | null) {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

export function statusBadge(status: DeploymentStatus | ReleaseStatus) {
  return (
    <span className={`inline-flex h-7 items-center rounded-md border px-2 text-xs font-semibold ${statusClasses[status]}`}>
      {status}
    </span>
  );
}

export function healthBadge(status: DeploymentHealthStatus) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${healthClasses[status]}`}>
      <HeartPulse size={14} />
      {status}
    </span>
  );
}

export function ProjectTabs({ project, active }: { project: string; active: "overview" | "history" | "logs" | "env" | "database" | "files" | "settings" }) {
  const tabs = [
    { key: "overview", label: "Overview", href: `/deployments/${project}/overview` },
    { key: "history", label: "Deploy History", href: `/deployments/${project}/history` },
    { key: "logs", label: "Logs", href: `/deployments/${project}/logs` },
    { key: "env", label: "Environment", href: `/deployments/${project}/env` },
    { key: "database", label: "Database", href: `/deployments/${project}/database` },
    { key: "files", label: "File Manager", href: `/deployments/${project}/files` },
    { key: "settings", label: "Settings", href: `/deployments/${project}/settings` }
  ] as const;
  return (
    <div className="flex items-center gap-1 border-b border-panel-line bg-white px-8">
      {tabs.map((tab) => (
        <Link
          className={`border-b-2 px-3 py-3 text-sm font-medium ${active === tab.key ? "border-panel-accent text-panel-ink" : "border-transparent text-panel-muted hover:text-panel-ink"}`}
          href={tab.href}
          key={tab.key}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

export function DeploymentSummary({ deployment }: { deployment: Deployment }) {
  const latest = deployment.releases?.[0];
  return (
    <div className="grid grid-cols-4 gap-3">
      <Metric icon={<Activity size={16} />} label="Status" value={statusBadge(deployment.status)} />
      <Metric icon={<HeartPulse size={16} />} label="Health" value={healthBadge(deployment.healthStatus)} />
      <Metric icon={<GitBranch size={16} />} label="Branch" value={deployment.branch} />
      <Metric icon={<Clock3 size={16} />} label="Last release" value={latest ? `${latest.status} · ${formatDate(latest.createdAt)}` : "No release"} />
    </div>
  );
}

export function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="flex items-center gap-2 text-xs uppercase text-panel-muted">
        {icon}
        {label}
      </div>
      <div className="mt-3 min-h-7 text-sm font-semibold">{value}</div>
    </div>
  );
}

export function ActionButton({ icon, label, onClick, disabled, intent = "default" }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; intent?: "default" | "primary" | "danger" }) {
  const styles = intent === "primary"
    ? "bg-panel-accent text-white"
    : intent === "danger"
      ? "border-panel-line text-panel-danger hover:bg-red-50"
      : "border-panel-line text-slate-700 hover:bg-slate-50";
  return (
    <button className={`flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium disabled:opacity-55 ${styles}`} disabled={disabled} onClick={onClick} type="button">
      {icon}
      {label}
    </button>
  );
}

export function actionIcon(action: "deploy" | "start" | "stop" | "restart" | "rollback") {
  if (action === "stop") return <Square size={15} />;
  if (action === "restart" || action === "rollback") return <RotateCcw size={15} />;
  return <Play size={15} />;
}

export function LogLine({ log }: { log: DeploymentLog }) {
  const hasError = log.step === "FAILED" || /fail|error/i.test(log.message);
  const metadata = logMetadataPreview(log.metadata);
  return (
    <div className="grid grid-cols-[110px_150px_1fr] gap-3 border-b border-slate-800 px-4 py-2 font-mono text-xs">
      <span className="text-slate-400 tabular-nums">{formatLogTime(log.createdAt)}</span>
      <span className={hasError ? "text-red-300" : "text-cyan-300"}>{log.step}</span>
      <span className="min-w-0 text-slate-100">
        <span>{log.message}</span>
        {metadata ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-400">{metadata}</pre> : null}
      </span>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-dashed border-panel-line bg-white p-10 text-center">
      <CircleDot className="mx-auto text-panel-muted" size={24} />
      <div className="mt-3 text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-panel-muted">{detail}</div>
    </div>
  );
}

export function ResultNotice({ message, ok }: { message: string; ok?: boolean }) {
  if (!message) return null;
  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
      {ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
      {message}
    </div>
  );
}
