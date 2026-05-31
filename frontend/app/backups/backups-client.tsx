"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, Eye, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiDeleteBody, apiGet, apiPost, apiPut } from "@/lib/api";

type BackupRecord = {
  id: string;
  label: string;
  status: string;
  archivePath: string | null;
  sizeBytes: number | null;
  includes: string[];
  result: { result?: { dryRun?: boolean; command?: string[]; stdout?: string; stderr?: string; returncode?: number } };
  createdAt: string;
  finishedAt: string | null;
};

type BackupArchive = {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  checksumPath: string;
};

const initialDraft = {
  label: "manual",
  appDir: "/opt/vps-panel",
  includeApp: true,
  includeEnv: true,
  includeDatabase: true,
  includeAccounts: true,
  includeDeployments: true,
  includeNginx: true,
  includeDns: true,
  includeLogs: false,
  excludePatterns: "node_modules\n.next/cache\ncache\ntmp\n*.log",
  encryptPassphrase: ""
};
const initialSettings = {
  scheduleEnabled: false,
  cron: "0 3 * * *",
  retentionKeepLast: "14",
  remoteProvider: "NONE",
  remoteTarget: "",
  encryptionEnabled: false
};

export function BackupsClient() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initialDraft);
  const [notice, setNotice] = useState("");
  const [restore, setRestore] = useState<string[]>([]);
  const [manifest, setManifest] = useState<string[]>([]);
  const [settings, setSettings] = useState(initialSettings);
  const backups = useQuery({
    queryKey: ["backups"],
    queryFn: () => apiGet<{ plan: { backupRoot: string; liveEnabled: boolean; freeBytes: number; includes: string[] }; archives: BackupArchive[]; records: BackupRecord[]; settings: any }>("/backups")
  });
  useEffect(() => {
    const saved = backups.data?.settings;
    if (!saved) return;
    setSettings({
      scheduleEnabled: Boolean(saved.scheduleEnabled),
      cron: String(saved.cron ?? "0 3 * * *"),
      retentionKeepLast: String(saved.retentionKeepLast ?? 14),
      remoteProvider: String(saved.remoteProvider ?? "NONE"),
      remoteTarget: String(saved.remoteTarget ?? ""),
      encryptionEnabled: Boolean(saved.encryptionEnabled)
    });
  }, [backups.data?.settings]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["backups"] });
  const create = useMutation({
    mutationFn: () => apiPost<BackupRecord>("/backups", {
      ...draft,
      excludePatterns: draft.excludePatterns.split("\n").map((item) => item.trim()).filter(Boolean),
      encryptPassphrase: draft.encryptPassphrase || undefined
    }),
    onSuccess: async (record) => {
      setNotice(record.result?.result?.dryRun ? "Backup preview created. Enable live backup on sysagent to write archives." : "Backup completed.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Backup failed.")
  });
  const previewRestore = useMutation({
    mutationFn: (path: string) => apiPost<{ commands: string[] }>("/backups/restore-preview", { path }),
    onSuccess: (data) => setRestore(data.commands),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Restore preview failed.")
  });
  const verify = useMutation({
    mutationFn: (path: string) => apiPost<{ ok: boolean; error?: string }>("/backups/verify", { path }),
    onSuccess: (data) => setNotice(data.ok ? "Checksum verified." : data.error ?? "Checksum failed."),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Verify failed.")
  });
  const loadManifest = useMutation({
    mutationFn: (path: string) => apiPost<{ entries: string[] }>("/backups/manifest", { path }),
    onSuccess: (data) => setManifest(data.entries),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Manifest failed.")
  });
  const deleteArchive = useMutation({
    mutationFn: (path: string) => apiDeleteBody("/backups/archive", { path }),
    onSuccess: async () => {
      setNotice("Archive delete requested.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Delete failed.")
  });
  const prune = useMutation({
    mutationFn: () => apiPost("/backups/prune", { keepLast: Number(settings.retentionKeepLast || 14) }),
    onSuccess: async () => {
      setNotice("Prune completed.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Prune failed.")
  });
  const saveSettings = useMutation({
    mutationFn: () => apiPut("/backups/settings", { ...settings, retentionKeepLast: Number(settings.retentionKeepLast || 14) }),
    onSuccess: () => setNotice("Backup settings saved."),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Settings failed.")
  });

  return (
    <section className="space-y-6 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-normal text-panel-ink">Backups</h1>
          <p className="mt-1 text-sm text-panel-muted">Full myPanel archive with app, env, DB dump, account files, deployments, Nginx, and DNS zones.</p>
        </div>
        <button className="rounded-md border border-panel-line p-2 hover:bg-white" onClick={() => refresh()} type="button" title="Refresh">
          <RefreshCw size={16} />
        </button>
      </header>

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <div className="rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Create Backup</div>
          <div className="space-y-3 p-4">
            <Input label="Label" value={draft.label} onChange={(label) => setDraft({ ...draft, label })} />
            <Input label="App Directory" value={draft.appDir} onChange={(appDir) => setDraft({ ...draft, appDir })} />
            <label className="block space-y-1 text-xs font-medium text-panel-muted">
              <span>Exclude Patterns</span>
              <textarea className="min-h-24 w-full rounded-md border border-panel-line px-3 py-2 text-sm text-panel-ink" value={draft.excludePatterns} onChange={(event) => setDraft({ ...draft, excludePatterns: event.target.value })} />
            </label>
            <Input label="Encryption Passphrase" value={draft.encryptPassphrase} onChange={(encryptPassphrase) => setDraft({ ...draft, encryptPassphrase })} />
            {([
              ["includeApp", "App directory"],
              ["includeEnv", "Environment file"],
              ["includeDatabase", "PostgreSQL dump"],
              ["includeAccounts", "Account files"],
              ["includeDeployments", "Deployments"],
              ["includeNginx", "Nginx configs"],
              ["includeDns", "DNS zone files"],
              ["includeLogs", "Panel logs"]
            ] as const).map(([key, label]) => (
              <label className="flex items-center gap-2 text-sm" key={key}>
                <input checked={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} type="checkbox" />
                {label}
              </label>
            ))}
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={create.isPending} onClick={() => create.mutate()} type="button">
              <Archive size={15} />
              Create Full Backup
            </button>
            <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-xs text-panel-muted">
              Root: {backups.data?.plan.backupRoot ?? "/var/backups/vps-panel"} · Live: {backups.data?.plan.liveEnabled ? "enabled" : "dry-run"}
              <br />Free: {formatBytes(backups.data?.plan.freeBytes ?? null)}
            </div>
            {notice ? <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">{notice}</div> : null}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Schedule, Retention, Remote</div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <label className="flex items-center gap-2 text-sm">
                <input checked={settings.scheduleEnabled} onChange={(event) => setSettings({ ...settings, scheduleEnabled: event.target.checked })} type="checkbox" />
                Scheduled
              </label>
              <Input label="Cron" value={settings.cron} onChange={(cron) => setSettings({ ...settings, cron })} />
              <Input label="Keep Last" value={settings.retentionKeepLast} onChange={(retentionKeepLast) => setSettings({ ...settings, retentionKeepLast: retentionKeepLast.replace(/\D/g, "") })} />
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>Remote Provider</span>
                <select className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" value={settings.remoteProvider} onChange={(event) => setSettings({ ...settings, remoteProvider: event.target.value })}>
                  {["NONE", "S3", "R2", "B2", "SFTP"].map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <Input label="Remote Target" value={settings.remoteTarget} onChange={(remoteTarget) => setSettings({ ...settings, remoteTarget })} />
              <button className="rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => saveSettings.mutate()} type="button">Save</button>
              <button className="rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => prune.mutate()} type="button">Prune</button>
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Backup History</div>
            <div className="divide-y divide-panel-line">
              {(backups.data?.records ?? []).map((item) => (
                <div className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3" key={item.id}>
                  <div className="min-w-0">
                    <div className="font-semibold">{item.label} <span className={statusClass(item.status)}>{item.status}</span></div>
                    <div className="mt-1 truncate text-xs text-panel-muted">{item.archivePath ?? "No archive path yet"}</div>
                    <div className="mt-1 text-xs text-panel-muted">{formatBytes(item.sizeBytes)} · {new Date(item.createdAt).toLocaleString()}</div>
                  </div>
                  {item.archivePath ? <div className="flex gap-2">
                    <a className="rounded-md border border-panel-line p-2 hover:bg-slate-50" href={`/api/v1/backups/download?path=${encodeURIComponent(item.archivePath)}`} title="Download"><Download size={15} /></a>
                    <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => verify.mutate(item.archivePath!)} type="button" title="Verify"><ShieldCheck size={15} /></button>
                    <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => loadManifest.mutate(item.archivePath!)} type="button" title="Manifest"><Archive size={15} /></button>
                    <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => previewRestore.mutate(item.archivePath!)} type="button" title="Restore preview"><Eye size={15} /></button>
                    <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteArchive.mutate(item.archivePath!)} type="button" title="Delete"><Trash2 size={15} /></button>
                  </div> : null}
                </div>
              ))}
              {!backups.isLoading && !(backups.data?.records ?? []).length ? <div className="p-6 text-sm text-panel-muted">No backup records yet.</div> : null}
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Archives On Disk</div>
            <div className="divide-y divide-panel-line">
              {(backups.data?.archives ?? []).map((item) => (
                <div className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3" key={item.path}>
                  <div className="min-w-0">
                    <div className="font-semibold">{item.name}</div>
                    <div className="mt-1 truncate text-xs text-panel-muted">{item.path}</div>
                    <div className="mt-1 text-xs text-panel-muted">{formatBytes(item.sizeBytes)} · {new Date(item.modifiedAt).toLocaleString()}</div>
                  </div>
                  <div className="flex gap-2">
                    <a className="rounded-md border border-panel-line p-2 hover:bg-slate-50" href={`/api/v1/backups/download?path=${encodeURIComponent(item.path)}`} title="Download"><Download size={15} /></a>
                    <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => verify.mutate(item.path)} type="button" title="Verify"><ShieldCheck size={15} /></button>
                    <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => loadManifest.mutate(item.path)} type="button" title="Manifest"><Archive size={15} /></button>
                    <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => previewRestore.mutate(item.path)} type="button" title="Restore preview"><Eye size={15} /></button>
                    <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteArchive.mutate(item.path)} type="button" title="Delete"><Trash2 size={15} /></button>
                  </div>
                </div>
              ))}
              {!backups.isLoading && !(backups.data?.archives ?? []).length ? <div className="p-6 text-sm text-panel-muted">No archive files found.</div> : null}
            </div>
          </div>

          {restore.length ? (
            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Restore Preview</div>
              <pre className="overflow-auto p-4 text-xs">{restore.join("\n")}</pre>
            </div>
          ) : null}
          {manifest.length ? (
            <div className="rounded-md border border-panel-line bg-white">
              <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Manifest / Archive Entries</div>
              <pre className="max-h-80 overflow-auto p-4 text-xs">{manifest.join("\n")}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1 text-xs font-medium text-panel-muted">
      <span>{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function formatBytes(value: number | null) {
  if (!value) return "0 B";
  if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function statusClass(status: string) {
  if (status === "SUCCEEDED") return "text-emerald-700";
  if (status === "FAILED") return "text-panel-danger";
  return "text-amber-700";
}
