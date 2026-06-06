"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, Eye, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
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

type RestoreJob = {
  id: string;
  source: "LOCAL" | "GOOGLE_DRIVE";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  phase: string;
  percent: number;
  message: string;
  remotePath?: string;
  localPath?: string;
  downloadSkipped?: boolean;
  error?: string;
};

type BackupJob = {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  phase: string;
  percent: number;
  message: string;
  backupId?: string;
  archivePath?: string;
  error?: string;
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
  includeMail: true,
  includeSsl: true,
  includeLogs: false,
  excludePatterns: "node_modules\n.next/cache\ncache\ntmp\n*.log",
  encryptPassphrase: ""
};
const initialSettings = {
  scheduleEnabled: true,
  timezone: "Asia/Dhaka",
  scheduleTimes: "11:01\n23:01",
  retentionKeepLast: "2",
  remoteProvider: "GOOGLE_DRIVE",
  remoteTarget: "mypanel-drive:vps-panel-backups",
  googleDriveAuthMode: "SERVICE_ACCOUNT",
  googleDriveFolderId: "",
  googleDriveTeamDriveId: "",
  googleDriveClientId: "",
  googleDriveClientSecret: "",
  googleDriveRefreshToken: "",
  googleDriveServiceAccountJson: "",
  googleDriveClientIdConfigured: false,
  googleDriveClientSecretConfigured: false,
  googleDriveRefreshTokenConfigured: false,
  googleDriveServiceAccountConfigured: false,
  encryptionEnabled: false
};

export function BackupsClient() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initialDraft);
  const [notice, setNotice] = useState("");
  const [restore, setRestore] = useState<string[]>([]);
  const [restorePath, setRestorePath] = useState("");
  const [remoteRestorePath, setRemoteRestorePath] = useState("");
  const [activeBackupJobId, setActiveBackupJobId] = useState("");
  const [activeRestoreJobId, setActiveRestoreJobId] = useState("");
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
      timezone: String(saved.timezone ?? "Asia/Dhaka"),
      scheduleTimes: Array.isArray(saved.scheduleTimes) ? saved.scheduleTimes.join("\n") : "11:01\n23:01",
      retentionKeepLast: String(saved.retentionKeepLast ?? 2),
      remoteProvider: String(saved.remoteProvider ?? "GOOGLE_DRIVE"),
      remoteTarget: String(saved.remoteTarget ?? "mypanel-drive:vps-panel-backups"),
      googleDriveAuthMode: String(saved.googleDriveAuthMode ?? "SERVICE_ACCOUNT"),
      googleDriveFolderId: String(saved.googleDriveFolderId ?? ""),
      googleDriveTeamDriveId: String(saved.googleDriveTeamDriveId ?? ""),
      googleDriveClientId: "",
      googleDriveClientSecret: "",
      googleDriveRefreshToken: "",
      googleDriveServiceAccountJson: "",
      googleDriveClientIdConfigured: Boolean(saved.googleDriveClientIdConfigured),
      googleDriveClientSecretConfigured: Boolean(saved.googleDriveClientSecretConfigured),
      googleDriveRefreshTokenConfigured: Boolean(saved.googleDriveRefreshTokenConfigured),
      googleDriveServiceAccountConfigured: Boolean(saved.googleDriveServiceAccountConfigured),
      encryptionEnabled: Boolean(saved.encryptionEnabled)
    });
  }, [backups.data?.settings]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["backups"] });
  useEffect(() => {
    setActiveBackupJobId(localStorage.getItem("activeBackupJobId") ?? "");
    setActiveRestoreJobId(localStorage.getItem("activeRestoreJobId") ?? "");
  }, []);
  const backupJob = useQuery({
    queryKey: ["backup-job", activeBackupJobId],
    queryFn: () => apiGet<BackupJob>(`/backups/jobs/${activeBackupJobId}`),
    enabled: Boolean(activeBackupJobId),
    refetchInterval: 1000
  });
  useEffect(() => {
    if (!activeBackupJobId) return;
    localStorage.setItem("activeBackupJobId", activeBackupJobId);
  }, [activeBackupJobId]);
  useEffect(() => {
    const status = backupJob.data?.status;
    if (status === "SUCCEEDED" || status === "FAILED") {
      void refresh();
    }
  }, [backupJob.data?.status]);
  const create = useMutation({
    mutationFn: () => apiPost<BackupJob>("/backups/jobs", {
      ...draft,
      excludePatterns: draft.excludePatterns.split("\n").map((item) => item.trim()).filter(Boolean),
      encryptPassphrase: draft.encryptPassphrase || undefined
    }),
    onSuccess: (job) => {
      setActiveBackupJobId(job.id);
      localStorage.setItem("activeBackupJobId", job.id);
      setNotice("");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Backup failed.")
  });
  const previewRestore = useMutation({
    mutationFn: (path: string) => apiPost<{ commands: string[] }>("/backups/restore-preview", { path }),
    onSuccess: (data) => setRestore(data.commands),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Restore preview failed.")
  });
  const restoreJob = useQuery({
    queryKey: ["backup-restore-job", activeRestoreJobId],
    queryFn: () => apiGet<RestoreJob>(`/backups/restore-jobs/${activeRestoreJobId}`),
    enabled: Boolean(activeRestoreJobId),
    refetchInterval: 1000
  });
  useEffect(() => {
    if (!activeRestoreJobId) return;
    localStorage.setItem("activeRestoreJobId", activeRestoreJobId);
  }, [activeRestoreJobId]);
  const startRestore = useMutation({
    mutationFn: (body: { source: "LOCAL" | "GOOGLE_DRIVE"; path: string }) => apiPost<RestoreJob>("/backups/restore-jobs", { ...body, execute: true, mode: "full" }),
    onSuccess: (job) => {
      setActiveRestoreJobId(job.id);
      localStorage.setItem("activeRestoreJobId", job.id);
      setNotice("");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Restore failed.")
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
    mutationFn: () => apiPost("/backups/prune", { keepLast: Number(settings.retentionKeepLast || 2) }),
    onSuccess: async () => {
      setNotice("Prune completed.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Prune failed.")
  });
  const saveSettings = useMutation({
    mutationFn: () => apiPut("/backups/settings", {
      ...settings,
      scheduleTimes: settings.scheduleTimes.split("\n").map((item) => item.trim()).filter(Boolean),
      retentionKeepLast: Number(settings.retentionKeepLast || 2)
    }),
    onSuccess: async () => {
      setNotice("Backup settings saved.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Settings failed.")
  });
  const runLocalRestore = (path: string, label = path) => {
    if (confirm(`Restore ${label}? This overwrites panel files, databases, DNS, mail, and service config.`)) {
      startRestore.mutate({ source: "LOCAL", path });
    }
  };
  const runDriveRestore = (path: string) => {
    if (confirm(`Download and restore ${path}? If download already exists locally, it will be reused.`)) {
      startRestore.mutate({ source: "GOOGLE_DRIVE", path });
    }
  };

  return (
    <section className="space-y-6 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-normal text-panel-ink">Backups</h1>
          <p className="mt-1 text-sm text-panel-muted">Full myPanel archive with code, env, databases, accounts, domains, DNS, mail, SSL, and storage.</p>
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
              ["includeMail", "Mail config and mailboxes"],
              ["includeSsl", "SSL certificates"],
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
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Schedule, Retention, Drive</div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <label className="flex items-center gap-2 text-sm">
                <input checked={settings.scheduleEnabled} onChange={(event) => setSettings({ ...settings, scheduleEnabled: event.target.checked })} type="checkbox" />
                Scheduled
              </label>
              <Input label="Timezone" value={settings.timezone} onChange={(timezone) => setSettings({ ...settings, timezone })} />
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>Daily Times</span>
                <textarea className="min-h-20 w-full rounded-md border border-panel-line px-3 py-2 text-sm text-panel-ink" value={settings.scheduleTimes} onChange={(event) => setSettings({ ...settings, scheduleTimes: event.target.value })} />
              </label>
              <Input label="Keep Last" value={settings.retentionKeepLast} onChange={(retentionKeepLast) => setSettings({ ...settings, retentionKeepLast: retentionKeepLast.replace(/\D/g, "") })} />
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>Remote Provider</span>
                <select className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" value={settings.remoteProvider} onChange={(event) => setSettings({ ...settings, remoteProvider: event.target.value })}>
                  {["GOOGLE_DRIVE", "NONE", "S3", "R2", "B2", "SFTP"].map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <Input label="Drive Target" value={settings.remoteTarget} onChange={(remoteTarget) => setSettings({ ...settings, remoteTarget })} />
              <button className="rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => saveSettings.mutate()} type="button">Save</button>
              <button className="rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => prune.mutate()} type="button">Prune</button>
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Google Drive Secrets</div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>Auth Mode</span>
                <select className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" value={settings.googleDriveAuthMode} onChange={(event) => setSettings({ ...settings, googleDriveAuthMode: event.target.value })}>
                  <option value="SERVICE_ACCOUNT">Service Account JSON</option>
                  <option value="OAUTH_REFRESH_TOKEN">OAuth Refresh Token</option>
                  <option value="RCLONE_REMOTE">Existing rclone remote</option>
                </select>
              </label>
              <Input label="Drive Folder ID" value={settings.googleDriveFolderId} onChange={(googleDriveFolderId) => setSettings({ ...settings, googleDriveFolderId })} />
              <Input label="Shared Drive ID" value={settings.googleDriveTeamDriveId} onChange={(googleDriveTeamDriveId) => setSettings({ ...settings, googleDriveTeamDriveId })} />
              <Input label={`Client ID${settings.googleDriveClientIdConfigured ? " configured" : ""}`} value={settings.googleDriveClientId} onChange={(googleDriveClientId) => setSettings({ ...settings, googleDriveClientId })} />
              <Input label={`Client Secret${settings.googleDriveClientSecretConfigured ? " configured" : ""}`} value={settings.googleDriveClientSecret} onChange={(googleDriveClientSecret) => setSettings({ ...settings, googleDriveClientSecret })} />
              <Input label={`Refresh Token${settings.googleDriveRefreshTokenConfigured ? " configured" : ""}`} value={settings.googleDriveRefreshToken} onChange={(googleDriveRefreshToken) => setSettings({ ...settings, googleDriveRefreshToken })} />
              <label className="col-span-2 block space-y-1 text-xs font-medium text-panel-muted">
                <span>Service Account JSON{settings.googleDriveServiceAccountConfigured ? " configured" : ""}</span>
                <textarea className="min-h-28 w-full rounded-md border border-panel-line px-3 py-2 font-mono text-xs text-panel-ink" value={settings.googleDriveServiceAccountJson} onChange={(event) => setSettings({ ...settings, googleDriveServiceAccountJson: event.target.value })} />
              </label>
              <button className="col-span-2 rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50" onClick={() => saveSettings.mutate()} type="button">Save Google Secrets</button>
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Restore Backup</div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 p-4">
              <Input label="Archive Path" value={restorePath} onChange={setRestorePath} />
              <button className="mt-5 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={!restorePath.trim()} onClick={() => previewRestore.mutate(restorePath)} type="button">Preview</button>
              <button className="mt-5 rounded-md border border-red-200 px-3 text-sm font-semibold text-panel-danger hover:bg-red-50 disabled:opacity-50" disabled={!restorePath.trim()} onClick={() => runLocalRestore(restorePath)} type="button">Restore Now</button>
              <Input label="Drive Archive Name / Path" value={remoteRestorePath} onChange={setRemoteRestorePath} />
              <button className="mt-5 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={!remoteRestorePath.trim()} onClick={() => runDriveRestore(remoteRestorePath)} type="button">Download + Restore</button>
              <div className="mt-5 rounded-md border border-panel-line px-3 py-2 text-xs text-panel-muted">Downloaded file stays if restore fails, and is reused next retry.</div>
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
                    <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => runLocalRestore(item.archivePath!, item.label)} type="button" title="Restore now"><RotateCcw size={15} /></button>
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
                    <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => runLocalRestore(item.path, item.name)} type="button" title="Restore now"><RotateCcw size={15} /></button>
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
      {activeRestoreJobId ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-md bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
              <div className="text-sm font-semibold">Restore Progress</div>
              <button className="rounded-md border border-panel-line px-2 py-1 text-xs disabled:opacity-50" disabled={restoreJob.data?.status === "RUNNING" || restoreJob.data?.status === "QUEUED"} onClick={() => { localStorage.removeItem("activeRestoreJobId"); setActiveRestoreJobId(""); }} type="button">Close</button>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <div className="mb-2 flex justify-between text-sm">
                  <span>{restoreJob.data?.phase ?? "QUEUED"}</span>
                  <span>{restoreJob.data?.percent ?? 1}%</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full ${restoreJob.data?.status === "FAILED" ? "bg-red-500" : "bg-panel-accent"}`} style={{ width: `${restoreJob.data?.percent ?? 1}%` }} />
                </div>
              </div>
              <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">
                {restoreJob.data?.message ?? "Starting restore..."}
                {restoreJob.data?.downloadSkipped ? <div className="mt-1 text-xs text-panel-muted">Local file was already present, download skipped.</div> : null}
                {restoreJob.data?.localPath ? <div className="mt-1 truncate text-xs text-panel-muted">Local: {restoreJob.data.localPath}</div> : null}
                {restoreJob.data?.remotePath ? <div className="mt-1 truncate text-xs text-panel-muted">Drive: {restoreJob.data.remotePath}</div> : null}
                {restoreJob.data?.error ? <div className="mt-2 text-xs text-panel-danger">{restoreJob.data.error}</div> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {activeBackupJobId ? (
        <ProgressModal
          title="Backup Progress"
          status={backupJob.data?.status}
          phase={backupJob.data?.phase}
          percent={backupJob.data?.percent}
          message={backupJob.data?.message}
          error={backupJob.data?.error}
          lines={[
            backupJob.data?.archivePath ? `Archive: ${backupJob.data.archivePath}` : "",
            backupJob.data?.backupId ? `Backup ID: ${backupJob.data.backupId}` : ""
          ]}
          onClose={() => {
            localStorage.removeItem("activeBackupJobId");
            setActiveBackupJobId("");
          }}
        />
      ) : null}
    </section>
  );
}

function ProgressModal({ title, status, phase, percent, message, error, lines, onClose }: { title: string; status?: string; phase?: string; percent?: number; message?: string; error?: string; lines?: string[]; onClose: () => void }) {
  const running = status === "RUNNING" || status === "QUEUED" || !status;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
      <div className="w-full max-w-lg rounded-md bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
          <div className="text-sm font-semibold">{title}</div>
          <button className="rounded-md border border-panel-line px-2 py-1 text-xs disabled:opacity-50" disabled={running} onClick={onClose} type="button">Close</button>
        </div>
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-2 flex justify-between text-sm">
              <span>{phase ?? "QUEUED"}</span>
              <span>{percent ?? 1}%</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full ${status === "FAILED" ? "bg-red-500" : "bg-panel-accent"}`} style={{ width: `${percent ?? 1}%` }} />
            </div>
          </div>
          <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">
            {message ?? "Starting..."}
            {(lines ?? []).filter(Boolean).map((line) => <div className="mt-1 truncate text-xs text-panel-muted" key={line}>{line}</div>)}
            {error ? <div className="mt-2 text-xs text-panel-danger">{error}</div> : null}
          </div>
        </div>
      </div>
    </div>
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
