"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, Eye, RefreshCw } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

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
  includeLogs: false
};

export function BackupsClient() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initialDraft);
  const [notice, setNotice] = useState("");
  const [restore, setRestore] = useState<string[]>([]);
  const backups = useQuery({
    queryKey: ["backups"],
    queryFn: () => apiGet<{ plan: { backupRoot: string; liveEnabled: boolean; includes: string[] }; archives: BackupArchive[]; records: BackupRecord[] }>("/backups")
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["backups"] });
  const create = useMutation({
    mutationFn: () => apiPost<BackupRecord>("/backups", draft),
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
            </div>
            {notice ? <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">{notice}</div> : null}
          </div>
        </div>

        <div className="space-y-6">
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
                  {item.archivePath ? <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => previewRestore.mutate(item.archivePath!)} type="button" title="Restore preview"><Eye size={15} /></button> : null}
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
                  <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => previewRestore.mutate(item.path)} type="button" title="Restore preview">
                    <Download size={15} />
                  </button>
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
