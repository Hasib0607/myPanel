"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, HardDrive, MemoryStick, RadioTower, RefreshCw, ServerCrash, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/api";

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
          port: number | null;
          status: "healthy" | "down";
          systemdState: string;
          detail: string;
          portListening: boolean | null;
        }>;
        ports: Array<{ port: number; listening: boolean; owner?: { process?: string; pid?: number } }>;
        security: { sshFailures: number; ufw?: CommandOutput; fail2ban?: CommandOutput };
        logs: { nginxErrors: number; badHttpResponses: number };
        pm2: { available: boolean; detail?: string; raw?: string };
      }
    | { unavailable: true; incidents: []; services: []; ports: [] };
  incidents: Incident[];
  deployments: Array<{ id: string; name: string; slug: string; status: string; healthStatus: string; port: number; lastHealthCheckAt: string | null }>;
  sslDomains: Array<{ id: string; name: string; sslEnabled: boolean; sslExpiry: string | null; daysRemaining: number | null }>;
  generatedAt: string;
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

  return (
    <>
      <PageHeader
        title="Guardian"
        description="Read-only server monitoring, incident detection, and deployment health signals."
        action={
          <button
            className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50"
            onClick={() => overview.refetch()}
            type="button"
          >
            <RefreshCw size={16} />
            Run Diagnosis
          </button>
        }
      />
      <section className="space-y-6 p-8">
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
                      </div>
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
                  </tr>
                </thead>
                <tbody>
                  {(!unavailable ? diagnosis?.services ?? [] : []).map((service) => (
                    <tr className="border-t border-panel-line" key={service.key}>
                      <td className="px-4 py-3 font-medium">{service.name}</td>
                      <td className="px-4 py-3"><span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusClass(service.status)}`}>{service.status}</span></td>
                      <td className="px-4 py-3">{service.port ?? "-"}</td>
                      <td className="px-4 py-3 text-panel-muted">{service.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 text-sm font-semibold">Security Signals</div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between gap-3"><span className="text-panel-muted">SSH failures</span><span className="font-medium">{!unavailable ? diagnosis?.security.sshFailures ?? 0 : "-"}</span></div>
                <div><div className="text-panel-muted">UFW</div><pre className="mt-1 max-h-24 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{!unavailable ? firstLine(diagnosis?.security.ufw) : "Sysagent unavailable"}</pre></div>
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
                    <span className="truncate font-medium">{domain.name}</span>
                    <span className={domain.daysRemaining !== null && domain.daysRemaining <= 14 ? "text-amber-700" : "text-panel-muted"}>
                      {domain.daysRemaining === null ? "unknown" : `${domain.daysRemaining}d`}
                    </span>
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
