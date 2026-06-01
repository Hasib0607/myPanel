"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, HardDrive, MemoryStick, RadioTower, RefreshCw, Rocket, ServerCrash, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

type Incident = {
  severity: "critical" | "warning" | string;
  category: string;
  title: string;
  detail: string;
  safeAction?: string;
};

type GuardianOverview = {
  diagnosis:
    | {
        unavailable?: false;
        generatedAt: string;
        host: { hostname: string; platform: string };
        resources: {
          cpuPercent: number;
          loadAverage: number[];
          memory: { total: number; used: number; percent: number };
          disk: { total: number; used: number; free: number; percent: number };
        };
        services: Array<{
          key: string;
          name: string;
          unit: string;
          ports: number[];
          status: "healthy" | "down";
          systemdState: string;
          detail: string;
          portListening: boolean | null;
          optional?: boolean;
        }>;
        ports: Array<{ port: number; listening: boolean; owner?: { process?: string; pid?: number } }>;
        security: { sshFailures: number; firewall?: CommandOutput; ufw?: CommandOutput; fail2ban?: CommandOutput; fail2banSshd?: CommandOutput; suspiciousIps?: SuspiciousIp[] };
        logs: {
          nginxErrors: number;
          badHttpResponses: number;
          nginxAccess?: {
            sampleSize: number;
            parsed: number;
            statusCounts: Array<{ status: string; count: number }>;
            topIps: Array<{ ip: string; count: number }>;
            topBadIps: Array<{ ip: string; count: number }>;
            topBadPaths: Array<{ path: string; count: number }>;
          };
        };
        pm2: {
          available: boolean;
          detail?: string;
          online?: number;
          total?: number;
          items: Array<{ name: string; pmId?: number; pid?: number; status: string; healthy: boolean; restarts: number; unstableRestarts: number; cpuPercent?: number; memoryBytes?: number }>;
        };
      }
    | { unavailable: true; incidents: []; services: []; ports: [] };
  incidents: Incident[];
  storedIncidents: Array<{ id: string; title: string; detail: string; severity: string; status: string; lastSeenAt: string }>;
  recentActions: Array<{
    id: string;
    action: string;
    target: string;
    status: "SKIPPED" | "SUCCEEDED" | "FAILED";
    reason: string | null;
    retryCount: number;
    createdAt: string;
    incident: { title: string; severity: string; status: string } | null;
    result?: unknown;
  }>;
  deployments: Array<{ id: string; name: string; slug: string; status: string; healthStatus: string; port: number; lastHealthCheckAt: string | null }>;
  sslDomains: Array<{
    id: string;
    name: string;
    sslEnabled: boolean;
    sslExpiry: string | null;
    daysRemaining: number | null;
    liveSsl: { ok: boolean; issuer?: string; validFrom?: string; validTo?: string; daysRemaining?: number; error?: string } | null;
  }>;
  security: {
    suspiciousIps: Array<SuspiciousIp & { allowlisted: boolean; blocked: boolean }>;
    allowlist: Array<{ id: string; cidr: string; label: string | null; expiresAt: string | null }>;
    trustedCidrs: string[];
    loginAnomalies: Array<{ ip: string; failures: number; usernames: number; risk: string }>;
    settings: { autoBlockMode: "monitor" | "suggest" | "auto"; blockDurationMinutes: number };
    activeBlocks: Array<{ id: string; ip: string; reason: string; score: number; status: string; expiresAt: string | null }>;
  };
  fileFindings: Array<{ id: string; path: string; reason: string; risk: string; status: string; sizeBytes: number; mode: string | null; owner: string | null; modifiedAt: string | null }>;
  generatedAt: string;
};

type SuspiciousIp = {
  ip: string;
  score: number;
  sshFailures: number;
  badHttp: number;
  requests: number;
  reasons: string[];
  recommendation: "monitor" | "suggest-block" | "auto-block";
};

type CommandOutput = {
  available?: boolean;
  stdout?: string;
  stderr?: string;
  returncode?: number;
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

function firstLine(output?: CommandOutput) {
  if (!output) return "Not checked";
  if (output.stdout?.trim()) return output.stdout.trim().split("\n")[0];
  if (output.stderr?.trim()) return output.stderr.trim().split("\n")[0];
  return output.available === false ? "Unavailable" : "No output";
}

function severityClass(severity: string) {
  if (severity === "critical") return "border-red-200 bg-red-50 text-panel-danger";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function statusClass(status: string) {
  return status === "healthy" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-panel-danger";
}

const restartableServiceKeys = new Set(["nginx", "postgres", "pgbouncer", "panel-api", "panel-frontend", "panel-workers"]);

function canRestartService(serviceKey: string) {
  return restartableServiceKeys.has(serviceKey);
}

function actionStatusClass(status: string) {
  if (status === "SUCCEEDED") return "bg-emerald-50 text-emerald-700";
  if (status === "FAILED") return "bg-red-50 text-panel-danger";
  return "bg-slate-100 text-slate-700";
}

function actionDetail(action: GuardianOverview["recentActions"][number]) {
  if (action.reason) return action.reason;
  const result = action.result as any;
  if (action.action === "reload-nginx" && result?.test) {
    const testText = result.test.stderr || result.test.stdout || "nginx -t completed";
    const reloadText = result.reload?.stderr || result.reload?.stdout || (result.reloaded ? "reload requested" : "reload skipped");
    return `${testText.toString().trim().split("\n")[0]} / ${reloadText.toString().trim().split("\n")[0]}`;
  }
  if (result?.restart?.result) {
    return result.restart.result.stderr || result.restart.result.stdout || `returncode ${result.restart.result.returncode}`;
  }
  if (result?.freedBytes !== undefined) {
    return `${result.removed?.length ?? 0} files, ${formatBytes(result.freedBytes)} ${result.dryRun ? "would be freed" : "freed"}`;
  }
  return action.incident?.title ?? "Guardian action";
}

function commandLine(result: any) {
  const command = result?.restart?.result?.command ?? result?.result?.command;
  return Array.isArray(command) ? command.join(" ") : null;
}

function serviceActionMessage(result: any, serviceKey: string) {
  const status = result?.action?.status;
  const reason = result?.action?.reason;
  const serviceStatus = result?.serviceStatus;
  const command = commandLine(result);
  const dryRun = result?.restart?.result?.dryRun;
  if (status === "SUCCEEDED") return `${serviceKey} restarted and is healthy now.`;
  if (dryRun) return `Dry-run only: live system commands are disabled. Command not executed${command ? `: ${command}` : ""}.`;
  if (reason) return `Restart did not fix ${serviceKey}: ${reason}${command ? ` (${command})` : ""}.`;
  if (serviceStatus?.status === "down") return `Restart ran, but ${serviceKey} is still down: ${serviceStatus.detail}.`;
  return `Restart result for ${serviceKey}: ${status ?? "unknown"}.`;
}

function Meter({ label, value, detail, icon: Icon }: { label: string; value: number; detail: string; icon: typeof HardDrive }) {
  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon size={16} />
          {label}
        </div>
        <span className="text-sm text-panel-muted">{Math.round(value)}%</span>
      </div>
      <div className="mt-3 h-2 rounded-full bg-slate-100">
        <div className="h-2 rounded-full bg-panel-accent" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <div className="mt-2 text-xs text-panel-muted">{detail}</div>
    </div>
  );
}

export function GuardianClient() {
  const [autoHealResult, setAutoHealResult] = useState<string | null>(null);
  const [autoHealBusy, setAutoHealBusy] = useState(false);
  const [panelUpdateBusy, setPanelUpdateBusy] = useState(false);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [allowCidr, setAllowCidr] = useState("");
  const [blockDuration, setBlockDuration] = useState(60);
  const [evidenceText, setEvidenceText] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["guardian-overview"],
    queryFn: () => apiGet<GuardianOverview>("/guardian/overview"),
    refetchInterval: 30_000
  });

  const diagnosis = overview.data?.diagnosis;
  const unavailable = diagnosis?.unavailable;
  const resources = !unavailable ? diagnosis?.resources : null;
  const incidents = overview.data?.incidents ?? [];
  const criticalCount = incidents.filter((incident) => incident.severity === "critical").length;

  async function runAutoHeal() {
    setAutoHealBusy(true);
    setAutoHealResult(null);
    try {
      const result = await apiPost<{ actions: Array<{ action: string; target: string; status: string; reason?: string | null }> }>("/guardian/auto-heal", {});
      const skipped = result.actions.filter((action) => action.status === "SKIPPED").length;
      const failed = result.actions.filter((action) => action.status === "FAILED").length;
      setAutoHealResult(`${result.actions.length} safe actions evaluated${skipped ? `, ${skipped} skipped` : ""}.`);
      if (failed) setAutoHealResult(`${result.actions.length} safe actions evaluated, ${failed} failed, ${skipped} skipped.`);
      await overview.refetch();
    } catch (error) {
      setAutoHealResult(error instanceof Error ? error.message : "Guardian auto-heal failed.");
    } finally {
      setAutoHealBusy(false);
    }
  }

  async function runPanelUpdate() {
    setPanelUpdateBusy(true);
    setAutoHealResult(null);
    try {
      const result = await apiPost<{ pid: number | null }>("/guardian/panel-update/rebuild", {});
      setAutoHealResult(`Panel update started${result.pid ? ` with pid ${result.pid}` : ""}.`);
      await overview.refetch();
    } catch (error) {
      setAutoHealResult(error instanceof Error ? error.message : "Could not start panel update.");
    } finally {
      setPanelUpdateBusy(false);
    }
  }

  async function restartService(serviceKey: string) {
    setServiceBusy(serviceKey);
    setAutoHealResult(null);
    try {
      const result = await apiPost<any>(`/guardian/services/${encodeURIComponent(serviceKey)}/restart`, {});
      setAutoHealResult(serviceActionMessage(result, serviceKey));
      await overview.refetch();
    } catch (error) {
      setAutoHealResult(error instanceof Error ? error.message : `Could not restart ${serviceKey}.`);
    } finally {
      setServiceBusy(null);
    }
  }

  async function reloadNginx() {
    setServiceBusy("nginx-reload");
    setAutoHealResult(null);
    try {
      await apiPost("/guardian/nginx/reload", {});
      setAutoHealResult("Nginx config test and reload requested.");
      await overview.refetch();
    } catch (error) {
      setAutoHealResult(error instanceof Error ? error.message : "Could not reload Nginx.");
    } finally {
      setServiceBusy(null);
    }
  }

  async function blockIp(ip: string) {
    setSecurityNotice(null);
    try {
      await apiPost("/guardian/block-ip", { ip, reason: "Guardian suspicious IP", durationMinutes: blockDuration });
      setSecurityNotice(`Block requested for ${ip}.`);
      await overview.refetch();
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "Could not block IP.");
    }
  }

  async function unblockIp(ip: string) {
    setSecurityNotice(null);
    try {
      await apiPost("/guardian/unblock-ip", { ip, reason: "Guardian manual unblock" });
      setSecurityNotice(`Unblock requested for ${ip}.`);
      await overview.refetch();
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "Could not unblock IP.");
    }
  }

  async function scanFiles() {
    setSecurityNotice(null);
    try {
      const result = await apiGet<{ scan: { scanned: number; findings: unknown[] } }>("/guardian/file-watch/scan");
      setSecurityNotice(`File watch scanned ${result.scan.scanned} files and found ${result.scan.findings.length} suspicious items.`);
      await overview.refetch();
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "File watch scan failed.");
    }
  }

  async function syncCloudflare() {
    setSecurityNotice(null);
    try {
      const result = await apiPost<{ count: number }>("/guardian/cloudflare/sync", {});
      setSecurityNotice(`Synced ${result.count} Cloudflare CIDRs.`);
      await overview.refetch();
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "Cloudflare sync failed.");
    }
  }

  async function showEvidence(ip: string) {
    try {
      const result = await apiGet<{ access: string[]; error: string[]; auth: string[] }>(`/guardian/ip/${encodeURIComponent(ip)}/evidence`);
      setEvidenceText([...result.auth, ...result.access, ...result.error].slice(-12).join("\n") || "No recent evidence lines found.");
    } catch (error) {
      setEvidenceText(error instanceof Error ? error.message : "Evidence lookup failed.");
    }
  }

  async function updateSecurityMode(autoBlockMode: "monitor" | "suggest" | "auto") {
    const duration = overview.data?.security.settings.blockDurationMinutes ?? blockDuration;
    await apiPost("/guardian/settings/security", { autoBlockMode, blockDurationMinutes: duration });
    await overview.refetch();
  }

  async function trustFile(id: string) {
    await apiPost(`/guardian/file-watch/${id}/trust`, {});
    await overview.refetch();
  }

  async function quarantineFile(id: string) {
    await apiPost(`/guardian/file-watch/${id}/quarantine`, {});
    await overview.refetch();
  }

  async function applyRateLimit(mode: "balanced" | "strict") {
    setSecurityNotice(null);
    try {
      const result = await apiPost<any>("/guardian/rate-limit/apply", { mode });
      setSecurityNotice(result?.dryRun ? `${mode} rate-limit template is ready as dry-run.` : `${mode} rate-limit template applied; nginx config tested.`);
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "Could not apply rate-limit template.");
    }
  }

  async function addAllowlist() {
    const cidr = allowCidr.trim();
    if (!cidr) return;
    setSecurityNotice(null);
    try {
      await apiPost("/guardian/allowlist", { cidr, label: "Guardian allowlist" });
      setAllowCidr("");
      setSecurityNotice(`${cidr} added to allowlist.`);
      await overview.refetch();
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "Could not add allowlist entry.");
    }
  }

  async function removeAllowlist(id: string) {
    setSecurityNotice(null);
    try {
      await apiDelete(`/guardian/allowlist/${id}`);
      setSecurityNotice("Allowlist entry removed.");
      await overview.refetch();
    } catch (error) {
      setSecurityNotice(error instanceof Error ? error.message : "Could not remove allowlist entry.");
    }
  }

  return (
    <>
      <PageHeader
        title="Guardian"
        description="Read-only server monitoring, incident detection, and deployment health signals."
        action={
          <div className="flex items-center gap-2">
            <button
              className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50"
              disabled={autoHealBusy}
              onClick={runAutoHeal}
              type="button"
            >
              <ServerCrash size={16} />
              Auto-Heal
            </button>
            <button
              className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50"
              disabled={panelUpdateBusy}
              onClick={runPanelUpdate}
              type="button"
            >
              <Rocket size={16} />
              Panel Update
            </button>
            <button
              className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50"
              onClick={() => overview.refetch()}
              type="button"
            >
              <RefreshCw size={16} />
              Run Diagnosis
            </button>
          </div>
        }
      />
      <section className="space-y-6 p-8">
        {autoHealResult ? (
          <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm text-slate-700">{autoHealResult}</div>
        ) : null}
        {securityNotice ? (
          <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm text-slate-700">{securityNotice}</div>
        ) : null}
        {evidenceText ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-slate-950 p-4 text-xs text-slate-100">{evidenceText}</pre>
        ) : null}

        {overview.isError ? (
          <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-panel-danger">
            <AlertTriangle size={18} />
            {overview.error instanceof Error ? overview.error.message : "Guardian overview could not be loaded."}
          </div>
        ) : null}

        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="text-xs text-panel-muted">Guardian Mode</div>
            <div className="mt-1 text-2xl font-semibold">Read-only</div>
          </div>
          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="text-xs text-panel-muted">Incidents</div>
            <div className="mt-1 text-2xl font-semibold">{incidents.length}</div>
          </div>
          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="text-xs text-panel-muted">Critical</div>
            <div className="mt-1 text-2xl font-semibold">{criticalCount}</div>
          </div>
          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="text-xs text-panel-muted">Sysagent</div>
            <div className="mt-1 text-sm font-semibold">{unavailable ? "Unavailable" : "Reachable"}</div>
          </div>
        </div>

        {resources ? (
          <div className="grid grid-cols-3 gap-4">
            <Meter detail={`load ${resources.loadAverage.map((item) => item.toFixed(2)).join(" / ")}`} icon={RadioTower} label="CPU" value={resources.cpuPercent} />
            <Meter detail={`${formatBytes(resources.memory.used)} of ${formatBytes(resources.memory.total)}`} icon={MemoryStick} label="Memory" value={resources.memory.percent} />
            <Meter detail={`${formatBytes(resources.disk.free)} free`} icon={HardDrive} label="Disk" value={resources.disk.percent} />
          </div>
        ) : null}

        <div className="grid grid-cols-[1.2fr_0.8fr] gap-6">
          <div className="space-y-6">
            <div className="rounded-md border border-panel-line bg-white">
              <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
                <div className="text-sm font-semibold">Live Incidents</div>
                <Clock3 size={16} className="text-panel-muted" />
              </div>
              <div className="divide-y divide-panel-line">
                {incidents.length === 0 ? (
                  <div className="flex items-center gap-3 px-4 py-5 text-sm text-emerald-700">
                    <CheckCircle2 size={17} />
                    No active Guardian incidents.
                  </div>
                ) : incidents.map((incident, index) => (
                  <div className="px-4 py-3" key={`${incident.category}-${incident.title}-${index}`}>
                    <div className="flex items-start gap-3">
                      <ShieldAlert size={17} className={incident.severity === "critical" ? "mt-0.5 text-panel-danger" : "mt-0.5 text-amber-700"} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{incident.title}</span>
                          <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${severityClass(incident.severity)}`}>{incident.severity}</span>
                        </div>
                        <div className="mt-1 text-sm text-panel-muted">{incident.detail}</div>
                        {incident.safeAction ? <div className="mt-1 text-xs text-panel-muted">Safe action candidate: {incident.safeAction}</div> : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(() => {
                            const service = !unavailable ? diagnosis?.services.find((item) => incident.title.includes(item.name) || incident.detail.includes(`${item.key}:`)) : null;
                            if (incident.category === "nginx") {
                              return (
                                <button
                                  className="inline-flex items-center gap-1 rounded-md border border-panel-line px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                                  disabled={serviceBusy !== null}
                                  onClick={reloadNginx}
                                  type="button"
                                >
                                  <RefreshCw size={13} />
                                  {serviceBusy === "nginx-reload" ? "Reloading..." : "Test & reload Nginx"}
                                </button>
                              );
                            }
                            if (service && canRestartService(service.key)) {
                              return (
                                <button
                                  className="inline-flex items-center gap-1 rounded-md border border-panel-line px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                                  disabled={serviceBusy !== null}
                                  onClick={() => restartService(service.key)}
                                  type="button"
                                >
                                  <RefreshCw size={13} />
                                  {serviceBusy === service.key ? "Restarting..." : `Restart ${service.name}`}
                                </button>
                              );
                            }
                            if (incident.safeAction) {
                              return (
                                <button
                                  className="inline-flex items-center gap-1 rounded-md border border-panel-line px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                                  disabled={autoHealBusy}
                                  onClick={runAutoHeal}
                                  type="button"
                                >
                                  <RefreshCw size={13} />
                                  Run safe fix
                                </button>
                              );
                            }
                            return null;
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Auto-Heal History</div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.recentActions ?? []).length === 0 ? (
                  <div className="px-4 py-5 text-sm text-panel-muted">No Guardian actions recorded yet.</div>
                ) : (overview.data?.recentActions ?? []).map((action) => (
                  <div className="px-4 py-3 text-sm" key={action.id}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{action.action} / {action.target}</div>
                        <div className="truncate text-xs text-panel-muted">{actionDetail(action)}</div>
                      </div>
                      <div className="text-right">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${actionStatusClass(action.status)}`}>{action.status}</span>
                        <div className="mt-1 text-xs text-panel-muted">retry {action.retryCount}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Incident History</div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.storedIncidents ?? []).length === 0 ? (
                  <div className="px-4 py-5 text-sm text-panel-muted">No stored Guardian incidents.</div>
                ) : (overview.data?.storedIncidents ?? []).map((incident) => (
                  <div className="px-4 py-3 text-sm" key={incident.id}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{incident.title}</div>
                        <div className="truncate text-xs text-panel-muted">{incident.detail}</div>
                      </div>
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${incident.severity === "CRITICAL" ? "bg-red-50 text-panel-danger" : "bg-amber-50 text-amber-700"}`}>{incident.severity}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Watched Services</div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                  <tr>
                    <th className="px-4 py-3">Service</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Port</th>
                    <th className="px-4 py-3">Detail</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(!unavailable ? diagnosis?.services ?? [] : []).map((service) => (
                    <tr className="border-t border-panel-line" key={service.key}>
                      <td className="px-4 py-3 font-medium">{service.name}</td>
                      <td className="px-4 py-3"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass(service.status)}`}>{service.status}</span></td>
                      <td className="px-4 py-3">{service.ports.length ? service.ports.join(", ") : "-"}</td>
                      <td className="px-4 py-3 text-panel-muted">{service.detail}</td>
                      <td className="px-4 py-3 text-right">
                        {canRestartService(service.key) ? (
                          <button
                            className="inline-flex items-center gap-1 rounded-md border border-panel-line px-2 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                            disabled={serviceBusy !== null}
                            onClick={() => restartService(service.key)}
                            type="button"
                          >
                            <RefreshCw size={13} />
                            {serviceBusy === service.key ? "Restarting" : "Restart"}
                          </button>
                        ) : (
                          <span className="text-xs text-panel-muted">Monitor</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-md border border-panel-line bg-white">
              <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
                <div className="text-sm font-semibold">Suspicious IPs</div>
                <span className="text-xs text-panel-muted">{overview.data?.security.suspiciousIps.length ?? 0} detected</span>
              </div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.security.suspiciousIps ?? []).length === 0 ? (
                  <div className="px-4 py-5 text-sm text-panel-muted">No suspicious IPs in the current log sample.</div>
                ) : (overview.data?.security.suspiciousIps ?? []).slice(0, 6).map((item) => (
                  <div className="px-4 py-3 text-sm" key={item.ip}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{item.ip}</div>
                        <div className="truncate text-xs text-panel-muted">score {item.score} / {item.reasons.join(", ") || "monitor"}</div>
                      </div>
                      {item.blocked ? (
                        <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => unblockIp(item.ip)} type="button">Unblock</button>
                      ) : (
                        <div className="flex gap-1">
                          <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => showEvidence(item.ip)} type="button">Evidence</button>
                          <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50" disabled={item.allowlisted} onClick={() => blockIp(item.ip)} type="button">
                            {item.allowlisted ? "Allowed" : "Block"}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
                <div className="text-sm font-semibold">File Watch</div>
                <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={scanFiles} type="button">Scan</button>
              </div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.fileFindings ?? []).length === 0 ? (
                  <div className="px-4 py-5 text-sm text-panel-muted">No suspicious files recorded.</div>
                ) : (overview.data?.fileFindings ?? []).slice(0, 6).map((finding) => (
                  <div className="px-4 py-3 text-sm" key={finding.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{finding.path}</div>
                        <div className="truncate text-xs text-panel-muted">{finding.reason}</div>
                        <div className="mt-1 text-xs text-panel-muted">{formatBytes(finding.sizeBytes)} / {finding.mode ?? "-"}</div>
                      </div>
                      <div className="flex flex-col gap-1 text-right">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${finding.risk === "CRITICAL" ? "bg-red-50 text-panel-danger" : "bg-amber-50 text-amber-700"}`}>{finding.risk}</span>
                        <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => trustFile(finding.id)} type="button">Trust</button>
                        <button className="rounded-md border border-panel-line px-2 py-1 text-xs text-panel-danger hover:bg-red-50" onClick={() => quarantineFile(finding.id)} type="button">Quarantine</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Blocked IPs</div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.security.activeBlocks ?? []).length === 0 ? (
                  <div className="px-4 py-5 text-sm text-panel-muted">No active Guardian IP blocks.</div>
                ) : (overview.data?.security.activeBlocks ?? []).slice(0, 6).map((block) => (
                  <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={block.id}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{block.ip}</div>
                      <div className="truncate text-xs text-panel-muted">{block.reason}</div>
                    </div>
                    <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => unblockIp(block.ip)} type="button">Unblock</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Login Anomalies</div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.security.loginAnomalies ?? []).length === 0 ? (
                  <div className="px-4 py-5 text-sm text-panel-muted">No failed-login anomaly in the last hour.</div>
                ) : (overview.data?.security.loginAnomalies ?? []).slice(0, 6).map((item) => (
                  <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={item.ip}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.ip}</div>
                      <div className="truncate text-xs text-panel-muted">{item.failures} failures / {item.usernames} usernames</div>
                    </div>
                    <span className={item.risk === "high" ? "text-panel-danger" : "text-amber-700"}>{item.risk}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Nginx Rate Limit Templates</div>
              <div className="flex gap-2">
                <button className="rounded-md border border-panel-line px-3 py-2 text-sm hover:bg-slate-50" onClick={() => applyRateLimit("balanced")} type="button">Balanced</button>
                <button className="rounded-md border border-panel-line px-3 py-2 text-sm hover:bg-slate-50" onClick={() => applyRateLimit("strict")} type="button">Strict</button>
              </div>
              <div className="mt-2 text-xs text-panel-muted">Writes `/etc/nginx/conf.d/vps-panel-guardian-rate-limit.conf` only when live Nginx commands are enabled.</div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Security Mode</div>
              <div className="flex flex-wrap gap-2">
                {(["monitor", "suggest", "auto"] as const).map((mode) => (
                  <button
                    className={`rounded-md border px-3 py-2 text-sm hover:bg-slate-50 ${overview.data?.security.settings.autoBlockMode === mode ? "border-panel-accent text-panel-accent" : "border-panel-line"}`}
                    key={mode}
                    onClick={() => updateSecurityMode(mode)}
                    type="button"
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-panel-muted">Block minutes</span>
                <input className="h-8 w-24 rounded-md border border-panel-line px-2 text-sm" min={5} onChange={(event) => setBlockDuration(Number(event.target.value))} type="number" value={blockDuration} />
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Allowlist</div>
              <div className="flex gap-2">
                <input
                  className="h-9 min-w-0 flex-1 rounded-md border border-panel-line px-3 text-sm"
                  onChange={(event) => setAllowCidr(event.target.value)}
                  placeholder="IP or CIDR"
                  value={allowCidr}
                />
                <button className="rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={addAllowlist} type="button">Add</button>
                <button className="rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={syncCloudflare} type="button">Cloudflare</button>
              </div>
              <div className="mt-3 space-y-2">
                {(overview.data?.security.trustedCidrs ?? []).slice(0, 4).map((cidr) => (
                  <div className="flex items-center justify-between gap-2 text-sm" key={cidr}>
                    <span className="truncate">{cidr}</span>
                    <span className="text-xs text-panel-muted">trusted</span>
                  </div>
                ))}
                {(overview.data?.security.allowlist ?? []).length === 0 ? (
                  <div className="text-sm text-panel-muted">No allowlist entries.</div>
                ) : (overview.data?.security.allowlist ?? []).slice(0, 6).map((item) => (
                  <div className="flex items-center justify-between gap-2 text-sm" key={item.id}>
                    <span className="truncate">{item.cidr}</span>
                    <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => removeAllowlist(item.id)} type="button">Remove</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">PM2 Apps</div>
              <div className="space-y-2 text-sm">
                {unavailable ? <div className="text-panel-muted">Sysagent unavailable</div> : null}
                {!unavailable && diagnosis?.pm2.available === false ? <div className="text-panel-muted">{diagnosis.pm2.detail ?? "PM2 unavailable"}</div> : null}
                {!unavailable && diagnosis?.pm2.available !== false && diagnosis?.pm2.items.length === 0 ? <div className="text-panel-muted">No PM2 apps found.</div> : null}
                {!unavailable && diagnosis?.pm2.items.map((app) => (
                  <div className="rounded-md border border-panel-line px-3 py-2" key={`${app.name}-${app.pmId ?? app.pid ?? "unknown"}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-medium">{app.name}</span>
                      <span className={app.healthy ? "text-emerald-700" : "text-panel-danger"}>{app.status}</span>
                    </div>
                    <div className="mt-1 text-xs text-panel-muted">
                      restarts {app.restarts} / cpu {app.cpuPercent ?? 0}% / {app.memoryBytes ? formatBytes(app.memoryBytes) : "0 B"}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Nginx Access Signals</div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-panel-muted">Parsed sample</span>
                  <span className="font-medium">{!unavailable ? `${diagnosis?.logs.nginxAccess?.parsed ?? 0}/${diagnosis?.logs.nginxAccess?.sampleSize ?? 0}` : "-"}</span>
                </div>
                <div>
                  <div className="text-panel-muted">Status counts</div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(!unavailable ? diagnosis?.logs.nginxAccess?.statusCounts ?? [] : []).slice(0, 8).map((item) => (
                      <span className="rounded-md bg-slate-100 px-2 py-1 text-xs" key={item.status}>{item.status}: {item.count}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-panel-muted">Top bad IPs</div>
                  <div className="mt-1 space-y-1">
                    {(!unavailable ? diagnosis?.logs.nginxAccess?.topBadIps ?? [] : []).slice(0, 5).map((item) => (
                      <div className="flex justify-between gap-3 text-xs" key={item.ip}><span className="truncate">{item.ip}</span><span>{item.count}</span></div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Security Signals</div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between gap-3"><span className="text-panel-muted">SSH failures</span><span className="font-medium">{!unavailable ? diagnosis?.security.sshFailures ?? 0 : "-"}</span></div>
                <div><div className="text-panel-muted">Firewall</div><pre className="mt-1 max-h-24 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{!unavailable ? firstLine(diagnosis?.security.firewall ?? diagnosis?.security.ufw) : "Sysagent unavailable"}</pre></div>
                <div><div className="text-panel-muted">Fail2Ban</div><pre className="mt-1 max-h-24 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{!unavailable ? firstLine(diagnosis?.security.fail2ban) : "Sysagent unavailable"}</pre></div>
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Watched Ports</div>
              <div className="grid grid-cols-2 gap-2">
                {(!unavailable ? diagnosis?.ports ?? [] : []).map((port) => (
                  <div className="rounded-md border border-panel-line px-3 py-2 text-sm" key={port.port}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{port.port}</span>
                      <span className={port.listening ? "text-emerald-700" : "text-panel-muted"}>{port.listening ? "open" : "closed"}</span>
                    </div>
                    <div className="mt-1 truncate text-xs text-panel-muted">{port.owner?.process ?? "no listener"}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Deployment Watch</div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.deployments ?? []).map((deployment) => (
                  <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={deployment.id}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{deployment.name}</div>
                      <div className="text-xs text-panel-muted">:{deployment.port} / {deployment.healthStatus}</div>
                    </div>
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${deployment.status === "RUNNING" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{deployment.status}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">SSL Watch</div>
              <div className="divide-y divide-panel-line">
                {(overview.data?.sslDomains ?? []).map((domain) => (
                  <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={domain.id}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{domain.name}</div>
                      <div className="truncate text-xs text-panel-muted">{domain.liveSsl?.ok ? `live ${domain.liveSsl.issuer ?? "certificate"}` : domain.liveSsl?.error ?? "DB expiry only"}</div>
                    </div>
                    <div className="text-right">
                      <div className={domain.liveSsl?.daysRemaining !== undefined && domain.liveSsl.daysRemaining <= 14 ? "text-amber-700" : "text-panel-muted"}>
                        {domain.liveSsl?.daysRemaining !== undefined ? `${domain.liveSsl.daysRemaining}d` : domain.daysRemaining === null ? "unknown" : `${domain.daysRemaining}d`}
                      </div>
                      <div className="text-xs text-panel-muted">{domain.liveSsl?.daysRemaining !== undefined ? "live" : "db"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
