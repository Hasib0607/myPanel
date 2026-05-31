"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCircle2, Lock, Plus, RefreshCw, Shield, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

type FirewallAction = "ALLOW" | "DENY" | "LIMIT";
type FirewallDirection = "IN" | "OUT";

type FirewallRule = {
  id: string;
  port: number;
  protocol: string;
  direction: FirewallDirection;
  action: FirewallAction;
  sourceIp: string | null;
  note: string | null;
  createdAt: string;
};

type Preset = {
  key: string;
  port: number;
  protocol: string;
  action: FirewallAction;
  direction: FirewallDirection;
  note: string;
};

type CommandResult = {
  dryRun?: boolean;
  command?: string[];
  stdout?: string;
  stderr?: string;
  returncode?: number;
};

type FirewallOverview = {
  localRules: FirewallRule[];
  liveRules: CommandResult | { unavailable: true };
  status: {
    firewall?: CommandResult;
    firewallDetails?: CommandResult;
    ufw?: CommandResult;
    fail2ban?: CommandResult;
    liveCommandsEnabled?: boolean;
    unavailable?: true;
  };
  security: {
    activeSshSessions?: CommandResult;
    failedSshAttempts?: CommandResult;
    rootLogin?: CommandResult;
    passwordAuthentication?: CommandResult;
    fail2banSshd?: CommandResult;
    liveCommandsEnabled?: boolean;
    unavailable?: true;
  };
  presets: Preset[];
};

function commandText(result?: CommandResult | { unavailable: true }) {
  if (!result) return "Not loaded";
  if ("unavailable" in result) return "Sysagent unavailable";
  if (result.stdout?.trim()) return result.stdout.trim();
  if (result.stderr?.trim()) return result.stderr.trim();
  if (result.command?.length) return `${result.dryRun ? "Dry-run: " : ""}${result.command.join(" ")}`;
  return "No output";
}

function actionClass(action: FirewallAction) {
  if (action === "ALLOW") return "bg-emerald-50 text-emerald-700";
  if (action === "DENY") return "bg-red-50 text-panel-danger";
  return "bg-amber-50 text-amber-700";
}

export function FirewallClient() {
  const queryClient = useQueryClient();
  const [port, setPort] = useState("22");
  const [protocol, setProtocol] = useState("tcp");
  const [direction, setDirection] = useState<FirewallDirection>("IN");
  const [action, setAction] = useState<FirewallAction>("LIMIT");
  const [sourceIp, setSourceIp] = useState("");
  const [note, setNote] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [permitRootLogin, setPermitRootLogin] = useState(false);
  const [passwordAuthentication, setPasswordAuthentication] = useState(false);
  const [lastResult, setLastResult] = useState("");

  const overview = useQuery({
    queryKey: ["firewall-overview"],
    queryFn: () => apiGet<FirewallOverview>("/firewall/overview"),
    refetchInterval: 30000
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["firewall-overview"] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const createRule = useMutation({
    mutationFn: () =>
      apiPost<FirewallRule>("/firewall/rules", {
        port: Number(port),
        protocol,
        direction,
        action,
        sourceIp: sourceIp.trim() || undefined,
        note: note.trim() || undefined
      }),
    onSuccess: async () => {
      setSourceIp("");
      setNote("");
      setLastResult("Rule saved and sysagent apply requested.");
      await invalidate();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create rule")
  });

  const applyPreset = useMutation({
    mutationFn: (key: string) => apiPost(`/firewall/presets/${key}`, {}),
    onSuccess: async () => {
      setLastResult("Preset saved and sysagent apply requested.");
      await invalidate();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not apply preset")
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => apiDelete(`/firewall/rules/${id}`),
    onSuccess: async () => {
      setLastResult("Local rule removed.");
      await invalidate();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not delete rule")
  });

  const firewallSwitch = useMutation({
    mutationFn: (mode: "enable" | "disable") => apiPost<CommandResult | { unavailable: true }>(`/firewall/${mode}`, {}),
    onSuccess: async (result) => {
      setLastResult(commandText(result));
      await invalidate();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not change firewall status")
  });

  const hardenSsh = useMutation({
    mutationFn: () =>
      apiPost("/firewall/ssh-hardening", {
        port: Number(sshPort),
        permitRootLogin,
        passwordAuthentication
      }),
    onSuccess: async (result) => {
      setLastResult(JSON.stringify(result));
      await invalidate();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not submit SSH hardening")
  });

  function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createRule.mutate();
  }

  function submitSsh(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    hardenSsh.mutate();
  }

  const liveCommands = overview.data?.status.liveCommandsEnabled ?? false;

  return (
    <section className="space-y-6 p-8">
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Saved Rules</div>
          <div className="mt-1 text-2xl font-semibold">{overview.data?.localRules.length ?? 0}</div>
        </div>
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Firewall Mode</div>
          <div className="mt-1 text-sm font-semibold">{liveCommands ? "Live commands enabled" : "Dry-run protected"}</div>
        </div>
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Fail2Ban</div>
          <div className="mt-1 truncate text-sm font-semibold">{commandText(overview.data?.status.fail2ban).split("\n")[0]}</div>
        </div>
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="text-xs text-panel-muted">Sysagent</div>
          <div className="mt-1 text-sm font-semibold">{overview.data?.status.unavailable ? "Unavailable" : "Reachable"}</div>
        </div>
      </div>

      {lastResult ? (
        <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm text-slate-700">{lastResult}</div>
      ) : null}

      <div className="grid grid-cols-[1fr_360px] gap-6">
        <div className="space-y-6">
          <div className="rounded-md border border-panel-line bg-white">
            <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
              <div className="text-sm font-semibold">Saved Firewall Rules</div>
              <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => overview.refetch()} type="button">
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                <tr>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Port</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Note</th>
                  <th className="px-4 py-3">Manage</th>
                </tr>
              </thead>
              <tbody>
                {(overview.data?.localRules ?? []).map((rule) => (
                  <tr className="border-t border-panel-line" key={rule.id}>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${actionClass(rule.action)}`}>{rule.action}</span>
                    </td>
                    <td className="px-4 py-3">{rule.direction} {rule.port}/{rule.protocol}</td>
                    <td className="px-4 py-3">{rule.sourceIp ?? "any"}</td>
                    <td className="px-4 py-3 text-panel-muted">{rule.note ?? "-"}</td>
                    <td className="px-4 py-3">
                      <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50" onClick={() => deleteRule.mutate(rule.id)} title="Delete local rule" type="button">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Shield size={16} />
                Live Firewall Status
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-xs text-slate-100">{commandText(overview.data?.liveRules)}</pre>
              <div className="mt-3 flex gap-2">
                <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => firewallSwitch.mutate("enable")} type="button">
                  <CheckCircle2 size={15} />
                  Enable
                </button>
                <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm text-panel-danger hover:bg-red-50" onClick={() => firewallSwitch.mutate("disable")} type="button">
                  <Ban size={15} />
                  Disable
                </button>
              </div>
            </div>

            <div className="rounded-md border border-panel-line bg-white p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Lock size={16} />
                SSH Security
              </div>
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-xs uppercase text-panel-muted">Active sessions</div>
                  <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs">{commandText(overview.data?.security.activeSshSessions)}</pre>
                </div>
                <div>
                  <div className="text-xs uppercase text-panel-muted">Failed SSH attempts</div>
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs">{commandText(overview.data?.security.failedSshAttempts)}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="space-y-6">
          <form className="rounded-md border border-panel-line bg-white p-4" onSubmit={submitRule}>
            <div className="mb-4 text-sm font-semibold">Add Rule</div>
            <div className="space-y-3">
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" min={1} max={65535} onChange={(event) => setPort(event.target.value)} type="number" value={port} />
              <div className="grid grid-cols-3 gap-2">
                <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setProtocol(event.target.value)} value={protocol}>
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
                <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDirection(event.target.value as FirewallDirection)} value={direction}>
                  <option value="IN">IN</option>
                  <option value="OUT">OUT</option>
                </select>
                <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setAction(event.target.value as FirewallAction)} value={action}>
                  <option value="ALLOW">ALLOW</option>
                  <option value="DENY">DENY</option>
                  <option value="LIMIT">LIMIT</option>
                </select>
              </div>
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setSourceIp(event.target.value)} placeholder="Source IP or CIDR, optional" value={sourceIp} />
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setNote(event.target.value)} placeholder="Note" value={note} />
              <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!port || createRule.isPending} type="submit">
                <Plus size={16} />
                Save Rule
              </button>
            </div>
          </form>

          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="text-sm font-semibold">Presets</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {(overview.data?.presets ?? []).map((preset) => (
                <button key={preset.key} className="h-10 rounded-md border border-panel-line text-sm hover:bg-slate-100" onClick={() => applyPreset.mutate(preset.key)} type="button">
                  {preset.port}/{preset.protocol}
                </button>
              ))}
            </div>
          </div>

          <form className="rounded-md border border-panel-line bg-white p-4" onSubmit={submitSsh}>
            <div className="mb-4 text-sm font-semibold">SSH Hardening</div>
            <div className="space-y-3">
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" min={1} max={65535} onChange={(event) => setSshPort(event.target.value)} type="number" value={sshPort} />
              <label className="flex items-center gap-2 text-sm">
                <input checked={permitRootLogin} onChange={(event) => setPermitRootLogin(event.target.checked)} type="checkbox" />
                Permit root login
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input checked={passwordAuthentication} onChange={(event) => setPasswordAuthentication(event.target.checked)} type="checkbox" />
                Password authentication
              </label>
              <button className="h-10 w-full rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" type="submit">
                Apply SSH Policy
              </button>
            </div>
          </form>
        </aside>
      </div>
    </section>
  );
}
