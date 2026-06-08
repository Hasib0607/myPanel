"use client";

import type React from "react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Columns3, Copy, Database, Download, Eye, KeyRound, Plus, RefreshCw, ShieldCheck, Table2, Trash2, Upload, UserRound } from "lucide-react";
import { apiDeleteBody, apiGet, apiPost, apiUploadWithProgress } from "@/lib/api";

type Engine = "POSTGRESQL" | "MYSQL";
type CommandResult = { dryRun?: boolean; command?: string[]; stdout?: string; stderr?: string; returncode?: number };
type DatabaseItem = { name: string; owner: string | null; tableCount?: number; rowCount?: number; sizeBytes?: number };
type DatabaseUser = { name: string; host: string | null };
type EngineOverview = {
  engine: Engine;
  installed: boolean;
  databases: DatabaseItem[];
  users: DatabaseUser[];
  checks: Record<string, CommandResult>;
};
type DatabaseOverview = { engines: EngineOverview[] };
type CredentialResult = { engine: Engine; database?: string; username: string; password?: string; result: unknown };
type ExportResult = { engine: Engine; database: string; dump: string };
type TableListResult = { engine: Engine; database: string; tables: string[] };
type ColumnListResult = { engine: Engine; database: string; table: string; columns: Array<{ name: string; type: string; nullable: string }> };
type RowPreviewResult = { engine: Engine; database: string; table: string; format: string; rows: string };
type TableExportResult = { engine: Engine; database: string; table: string; dump: string };
type TableCsvExportResult = { engine: Engine; database: string; table: string; format: string; content: string };

const engines: Engine[] = ["POSTGRESQL", "MYSQL"];
const initialForm = { engine: "POSTGRESQL" as Engine, database: "", username: "", password: "" };
const maxSqlUploadBytes = 3 * 1024 * 1024 * 1024;

function humanBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function cleanIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function copyText(value: string, setNotice: (value: string) => void) {
  await navigator.clipboard?.writeText(value);
  setNotice("Copied.");
}

function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const [name, ...rest] = filename.split(".");
  anchor.href = url;
  anchor.download = `${name}-${stamp}${rest.length ? `.${rest.join(".")}` : ""}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type DatabasesClientProps = {
  apiBase?: string;
};

export function DatabasesClient({ apiBase = "/databases" }: DatabasesClientProps = {}) {
  const queryClient = useQueryClient();
  const [notice, setNoticeState] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [form, setForm] = useState(initialForm);
  const [grant, setGrant] = useState(initialForm);
  const [passwordForm, setPasswordForm] = useState({ engine: "POSTGRESQL" as Engine, username: "", password: "" });
  const [transfer, setTransfer] = useState({ engine: "POSTGRESQL" as Engine, database: "", sql: "" });
  const [transferFile, setTransferFile] = useState<File | null>(null);
  const [tableTools, setTableTools] = useState({ engine: "POSTGRESQL" as Engine, database: "", table: "", content: "", format: "SQL" as "SQL" | "CSV" });
  const [tables, setTables] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnListResult["columns"]>([]);
  const [rowPreview, setRowPreview] = useState("");
  const [lastSecret, setLastSecret] = useState<CredentialResult | null>(null);
  const [rowImportTarget, setRowImportTarget] = useState<{ engine: Engine; database: string } | null>(null);
  const [importProgress, setImportProgress] = useState<{ database: string; file: string; percent: number; phase: "uploading" | "importing" | "done" } | null>(null);
  const rowImportInputRef = useRef<HTMLInputElement | null>(null);
  const setNotice = (text: string, tone: "success" | "error" = "success") => setNoticeState({ text, tone });

  const overview = useQuery({
    queryKey: ["databases-overview", apiBase],
    queryFn: () => apiGet<DatabaseOverview>(apiBase)
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["databases-overview", apiBase] });
  };

  const createDb = useMutation({
    mutationFn: () => apiPost<CredentialResult>(apiBase, { ...form, password: form.password || undefined }),
    onSuccess: async (result) => {
      setLastSecret(result);
      setNotice(`${result.database ?? form.database} created.`);
      setForm(initialForm);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create database", "error")
  });

  const changePassword = useMutation({
    mutationFn: () => apiPost<CredentialResult>(`${apiBase}/password`, { ...passwordForm, password: passwordForm.password || undefined }),
    onSuccess: async (result) => {
      setLastSecret(result);
      setNotice(`${passwordForm.username} password changed.`);
      setPasswordForm({ engine: passwordForm.engine, username: "", password: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not change password", "error")
  });

  const grantAccess = useMutation({
    mutationFn: () => apiPost(`${apiBase}/grant`, grant),
    onSuccess: async () => {
      setNotice(`Granted ${grant.username} access to ${grant.database}.`);
      setGrant({ ...grant, database: "", username: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not grant access", "error")
  });

  const deleteDatabase = useMutation({
    mutationFn: (input: { engine: Engine; database: string }) => apiDeleteBody(apiBase, input),
    onSuccess: async (_result, input) => {
      setNotice(`${input.database} deleted.`);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete database", "error")
  });

  const exportDatabase = useMutation({
    mutationFn: (input: { engine: Engine; database: string }) => apiPost<ExportResult>(`${apiBase}/export`, input),
    onSuccess: (result) => {
      downloadText(`${result.database}.sql`, result.dump, "application/sql;charset=utf-8");
      setNotice(`${result.database} exported.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not export database", "error")
  });

  const importDatabase = useMutation({
    mutationFn: () => apiPost(`${apiBase}/import`, transfer),
    onSuccess: async () => {
      setNotice(`Imported SQL into ${transfer.database}.`);
      setTransfer({ ...transfer, sql: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import database", "error")
  });

  const importDatabaseUpload = useMutation({
    mutationFn: async (input: { engine: Engine; database: string; file: File }) => {
      if (input.file.size > maxSqlUploadBytes) throw new Error("SQL upload exceeds the 3GB limit");
      const params = new URLSearchParams({
        engine: input.engine,
        database: input.database,
        filename: input.file.name
      });
      setImportProgress({ database: input.database, file: input.file.name, percent: 0, phase: "uploading" });
      return apiUploadWithProgress(`${apiBase}/import/upload?${params.toString()}`, input.file, "application/vnd.vps-panel.db-import", (percent) => {
        setImportProgress({ database: input.database, file: input.file.name, percent, phase: percent >= 100 ? "importing" : "uploading" });
      });
    },
    onSuccess: async (_result, input) => {
      setNotice(`Imported ${input.file.name} into ${input.database}.`);
      setImportProgress({ database: input.database, file: input.file.name, percent: 100, phase: "done" });
      if (rowImportTarget && rowImportTarget.engine === input.engine && rowImportTarget.database === input.database) {
        setRowImportTarget(null);
      } else {
        setTransferFile(null);
      }
      await refresh();
      window.setTimeout(() => setImportProgress(null), 2500);
    },
    onError: (error) => {
      setImportProgress(null);
      setNotice(error instanceof Error ? error.message : "Could not upload SQL file", "error");
    }
  });

  const listTables = useMutation({
    mutationFn: () => apiPost<TableListResult>(`${apiBase}/tables`, { engine: tableTools.engine, database: tableTools.database }),
    onSuccess: (result) => {
      setTables(result.tables);
      setColumns([]);
      setRowPreview("");
      setNotice(`${result.tables.length} tables loaded.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not list tables", "error")
  });

  const listColumns = useMutation({
    mutationFn: () => apiPost<ColumnListResult>(`${apiBase}/columns`, tableTools),
    onSuccess: (result) => {
      setColumns(result.columns);
      setNotice(`${result.table} columns loaded.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not list columns", "error")
  });

  const previewRows = useMutation({
    mutationFn: () => apiPost<RowPreviewResult>(`${apiBase}/rows`, { ...tableTools, limit: 50, offset: 0 }),
    onSuccess: (result) => {
      setRowPreview(result.rows);
      setNotice(`${result.table} row preview loaded.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not preview rows", "error")
  });

  const exportTableSql = useMutation({
    mutationFn: () => apiPost<TableExportResult>(`${apiBase}/table/export`, tableTools),
    onSuccess: (result) => {
      downloadText(`${result.database}.${result.table}.sql`, result.dump, "application/sql;charset=utf-8");
      setNotice(`${result.table} SQL exported.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not export table", "error")
  });

  const exportTableCsv = useMutation({
    mutationFn: () => apiPost<TableCsvExportResult>(`${apiBase}/table/export-csv`, tableTools),
    onSuccess: (result) => {
      downloadText(`${result.database}.${result.table}.${result.format === "CSV" ? "csv" : "tsv"}`, result.content, "text/plain;charset=utf-8");
      setNotice(`${result.table} ${result.format} exported.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not export rows", "error")
  });

  const importTable = useMutation({
    mutationFn: () => apiPost(`${apiBase}/table/import`, { ...tableTools, content: tableTools.content }),
    onSuccess: async () => {
      setNotice(`Imported ${tableTools.format} into ${tableTools.table}.`);
      setTableTools({ ...tableTools, content: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import table data", "error")
  });

  const engineMap = useMemo(() => new Map((overview.data?.engines ?? []).map((item) => [item.engine, item])), [overview.data]);

  function openRowImport(engine: Engine, database: string) {
    setRowImportTarget({ engine, database });
    rowImportInputRef.current?.click();
  }

  function browserHref(engine: Engine, database: string) {
    const scope = apiBase.startsWith("/account") ? "/account/databases" : "/databases";
    return `${scope}/${encodeURIComponent(engine)}/${encodeURIComponent(database)}`;
  }

  async function handleRowImportSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !rowImportTarget) return;
    importDatabaseUpload.mutate({ engine: rowImportTarget.engine, database: rowImportTarget.database, file });
    event.target.value = "";
  }

  return (
    <div className="space-y-5 p-6">
      <input accept=".sql,.txt,.dump" className="hidden" onChange={handleRowImportSelection} ref={rowImportInputRef} type="file" />
      {notice ? (
        <div className={`rounded-md border p-3 text-sm ${notice.tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
          {notice.text}
        </div>
      ) : null}

      <div className="grid grid-cols-[1fr_380px] gap-5">
        <div className="space-y-5">
          {engines.map((engine) => {
            const item = engineMap.get(engine);
            return (
              <section className="rounded-md border border-panel-line bg-white" key={engine}>
                <div className="flex items-center justify-between border-b border-panel-line p-4">
                  <div className="flex items-center gap-2">
                    <Database size={18} />
                    <div>
                      <div className="font-semibold">{engine === "POSTGRESQL" ? "PostgreSQL" : "MySQL / MariaDB"}</div>
                      <div className="text-xs text-panel-muted">{item?.installed ? `${item.databases.length} databases · ${item.users.length} users` : "Service or CLI not reachable"}</div>
                    </div>
                  </div>
                  <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => refresh()} type="button">
                    <RefreshCw size={15} /> Refresh
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-0">
                  <div className="border-r border-panel-line">
                    <div className="border-b border-panel-line px-4 py-2 text-xs font-semibold uppercase text-panel-muted">Databases</div>
                    {(item?.databases ?? []).map((database) => (
                      <div className="flex items-center justify-between gap-3 border-b border-panel-line px-4 py-3 last:border-b-0" key={database.name}>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-sm font-semibold">{database.name}</div>
                          <div className="text-xs text-panel-muted">{database.owner ? `owner ${database.owner}` : "owner unknown"}</div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-panel-muted">
                            <span className="rounded bg-slate-100 px-2 py-1">{compactNumber(database.tableCount ?? 0)} tables</span>
                            <span className="rounded bg-slate-100 px-2 py-1">{compactNumber(database.rowCount ?? 0)} rows</span>
                            <span className="rounded bg-slate-100 px-2 py-1">{humanBytes(database.sizeBytes ?? 0)}</span>
                          </div>
                          {importProgress?.database === database.name ? (
                            <div className="mt-3">
                              <div className="mb-1 flex items-center justify-between text-xs text-panel-muted">
                                <span className="truncate">{importProgress.phase === "done" ? "Import complete" : importProgress.phase === "importing" ? "Importing into database" : `Uploading ${importProgress.file}`}</span>
                                <span>{importProgress.percent}%</span>
                              </div>
                              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                <div className="h-full rounded-full bg-panel-accent transition-all" style={{ width: `${importProgress.percent}%` }} />
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <Link
                            className="rounded-md border border-panel-line p-2 hover:bg-slate-50"
                            href={browserHref(engine, database.name)}
                            title="Browse database"
                          >
                            <Database size={15} />
                          </Link>
                          <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" disabled={exportDatabase.isPending} onClick={() => exportDatabase.mutate({ engine, database: database.name })} type="button" title="Export SQL">
                            <Download size={15} />
                          </button>
                          <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" disabled={importDatabaseUpload.isPending} onClick={() => openRowImport(engine, database.name)} type="button" title="Import SQL file">
                            <Upload size={15} />
                          </button>
                          <button className="rounded-md border border-panel-line p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteDatabase.mutate({ engine, database: database.name })} type="button" title="Delete database">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    ))}
                    {item && item.databases.length === 0 ? <div className="p-6 text-sm text-panel-muted">No app databases found.</div> : null}
                  </div>

                  <div>
                    <div className="border-b border-panel-line px-4 py-2 text-xs font-semibold uppercase text-panel-muted">Users</div>
                    {(item?.users ?? []).map((user) => (
                      <div className="flex items-center justify-between border-b border-panel-line px-4 py-3 last:border-b-0" key={`${user.name}:${user.host ?? ""}`}>
                        <div>
                          <div className="font-mono text-sm font-semibold">{user.name}</div>
                          <div className="text-xs text-panel-muted">{user.host ?? "local"}</div>
                        </div>
                        <button
                          className="rounded-md border border-panel-line p-2 hover:bg-slate-50"
                          onClick={() => setPasswordForm({ engine, username: user.name, password: "" })}
                          title="Rotate password"
                          type="button"
                        >
                          <KeyRound size={15} />
                        </button>
                      </div>
                    ))}
                    {item && item.users.length === 0 ? <div className="p-6 text-sm text-panel-muted">No users found.</div> : null}
                  </div>
                </div>
              </section>
            );
          })}
        </div>

        <aside className="space-y-4">
          <ActionPanel icon={<Plus size={16} />} title="Create database">
            <EngineSelect value={form.engine} onChange={(engine) => setForm({ ...form, engine })} />
            <Input label="Database" value={form.database} onChange={(value) => setForm({ ...form, database: cleanIdentifier(value) })} />
            <Input label="Username" value={form.username} onChange={(value) => setForm({ ...form, username: cleanIdentifier(value) })} />
            <Input label="Password" placeholder="Auto-generate if empty" value={form.password} onChange={(value) => setForm({ ...form, password: value })} />
            <button className="h-10 w-full rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!form.database || !form.username || createDb.isPending} onClick={() => createDb.mutate()} type="button">
              {createDb.isPending ? "Creating..." : "Create database"}
            </button>
          </ActionPanel>

          <ActionPanel icon={<KeyRound size={16} />} title="Change password">
            <EngineSelect value={passwordForm.engine} onChange={(engine) => setPasswordForm({ ...passwordForm, engine })} />
            <Input label="Username" value={passwordForm.username} onChange={(value) => setPasswordForm({ ...passwordForm, username: cleanIdentifier(value) })} />
            <Input label="New password" placeholder="Auto-generate if empty" value={passwordForm.password} onChange={(value) => setPasswordForm({ ...passwordForm, password: value })} />
            <button className="h-10 w-full rounded-md bg-panel-ink text-sm font-semibold text-white disabled:opacity-60" disabled={!passwordForm.username || changePassword.isPending} onClick={() => changePassword.mutate()} type="button">
              {changePassword.isPending ? "Saving..." : "Change password"}
            </button>
          </ActionPanel>

          <ActionPanel icon={<ShieldCheck size={16} />} title="Grant access">
            <EngineSelect value={grant.engine} onChange={(engine) => setGrant({ ...grant, engine })} />
            <Input label="Database" value={grant.database} onChange={(value) => setGrant({ ...grant, database: cleanIdentifier(value) })} />
            <Input label="Username" value={grant.username} onChange={(value) => setGrant({ ...grant, username: cleanIdentifier(value) })} />
            <button className="h-10 w-full rounded-md border border-panel-line text-sm font-semibold disabled:opacity-60" disabled={!grant.database || !grant.username || grantAccess.isPending} onClick={() => grantAccess.mutate()} type="button">
              Grant privileges
            </button>
          </ActionPanel>

          <ActionPanel icon={<Download size={16} />} title="Import / export">
            <EngineSelect value={transfer.engine} onChange={(engine) => setTransfer({ ...transfer, engine })} />
            <Input label="Database" value={transfer.database} onChange={(value) => setTransfer({ ...transfer, database: cleanIdentifier(value) })} />
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-semibold disabled:opacity-60" disabled={!transfer.database || exportDatabase.isPending} onClick={() => exportDatabase.mutate({ engine: transfer.engine, database: transfer.database })} type="button">
              <Download size={15} /> {exportDatabase.isPending ? "Exporting..." : "Export SQL"}
            </button>
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              SQL file upload
              <input
                accept=".sql,.txt,.dump"
                className="block h-10 w-full rounded-md border border-panel-line px-3 py-2 text-sm text-panel-ink file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium"
                onChange={(event) => setTransferFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <div className="rounded-md border border-panel-line bg-slate-50 px-3 py-2 text-xs text-panel-muted">
              {transferFile ? `${transferFile.name} · ${humanBytes(transferFile.size)}` : "Upload a .sql dump directly from your browser."}
              <div>Maximum file size: 3GB.</div>
            </div>
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-semibold disabled:opacity-60"
              disabled={!transfer.database || !transferFile || transferFile.size > maxSqlUploadBytes || importDatabaseUpload.isPending}
              onClick={() => transferFile && importDatabaseUpload.mutate({ engine: transfer.engine, database: transfer.database, file: transferFile })}
              type="button"
            >
              <Upload size={15} /> {importDatabaseUpload.isPending ? "Uploading..." : "Upload and import SQL"}
            </button>
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              SQL import
              <textarea
                className="h-36 w-full rounded-md border border-panel-line p-3 font-mono text-xs text-panel-ink"
                onChange={(event) => setTransfer({ ...transfer, sql: event.target.value })}
                placeholder="Paste .sql content here"
                value={transfer.sql}
              />
            </label>
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-ink text-sm font-semibold text-white disabled:opacity-60" disabled={!transfer.database || !transfer.sql.trim() || importDatabase.isPending} onClick={() => importDatabase.mutate()} type="button">
              <Upload size={15} /> {importDatabase.isPending ? "Importing..." : "Import SQL"}
            </button>
          </ActionPanel>

          <ActionPanel icon={<Table2 size={16} />} title="Table tools">
            <EngineSelect value={tableTools.engine} onChange={(engine) => setTableTools({ ...tableTools, engine })} />
            <Input label="Database" value={tableTools.database} onChange={(value) => setTableTools({ ...tableTools, database: cleanIdentifier(value) })} />
            <div className="grid grid-cols-2 gap-2">
              <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium disabled:opacity-60" disabled={!tableTools.database || listTables.isPending} onClick={() => listTables.mutate()} type="button">
                <Table2 size={14} /> Tables
              </button>
              <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium disabled:opacity-60" disabled={!tableTools.table || listColumns.isPending} onClick={() => listColumns.mutate()} type="button">
                <Columns3 size={14} /> Columns
              </button>
            </div>
            {tables.length ? (
              <select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => setTableTools({ ...tableTools, table: event.target.value })} value={tableTools.table}>
                <option value="">Select table</option>
                {tables.map((table) => <option key={table} value={table}>{table}</option>)}
              </select>
            ) : (
              <Input label="Table" value={tableTools.table} onChange={(value) => setTableTools({ ...tableTools, table: cleanIdentifier(value) })} />
            )}
            <div className="grid grid-cols-3 gap-2">
              <button className="flex h-9 items-center justify-center gap-1 rounded-md border border-panel-line text-xs font-medium disabled:opacity-60" disabled={!tableTools.table || previewRows.isPending} onClick={() => previewRows.mutate()} type="button">
                <Eye size={14} /> Rows
              </button>
              <button className="flex h-9 items-center justify-center gap-1 rounded-md border border-panel-line text-xs font-medium disabled:opacity-60" disabled={!tableTools.table || exportTableSql.isPending} onClick={() => exportTableSql.mutate()} type="button">
                SQL
              </button>
              <button className="flex h-9 items-center justify-center gap-1 rounded-md border border-panel-line text-xs font-medium disabled:opacity-60" disabled={!tableTools.table || exportTableCsv.isPending} onClick={() => exportTableCsv.mutate()} type="button">
                CSV
              </button>
            </div>
            {columns.length ? <pre className="max-h-28 overflow-auto rounded-md bg-slate-50 p-2 font-mono text-xs">{columns.map((column) => `${column.name}  ${column.type}  ${column.nullable}`).join("\n")}</pre> : null}
            {rowPreview ? <pre className="max-h-36 overflow-auto rounded-md bg-slate-50 p-2 font-mono text-xs">{rowPreview}</pre> : null}
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Import format
              <select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => setTableTools({ ...tableTools, format: event.target.value as "SQL" | "CSV" })} value={tableTools.format}>
                <option value="SQL">SQL</option>
                <option value="CSV">CSV rows with header</option>
              </select>
            </label>
            <textarea
              className="h-32 w-full rounded-md border border-panel-line p-3 font-mono text-xs text-panel-ink"
              onChange={(event) => setTableTools({ ...tableTools, content: event.target.value })}
              placeholder={tableTools.format === "CSV" ? "id,name,email\n1,Alice,alice@example.com" : "Paste table SQL here"}
              value={tableTools.content}
            />
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-ink text-sm font-semibold text-white disabled:opacity-60" disabled={!tableTools.table || !tableTools.content.trim() || importTable.isPending} onClick={() => importTable.mutate()} type="button">
              <Upload size={15} /> {importTable.isPending ? "Importing..." : "Import table data"}
            </button>
          </ActionPanel>

          {lastSecret?.password ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900"><UserRound size={16} /> New credential</div>
              <div className="font-mono text-xs text-amber-900">{lastSecret.username}</div>
              <div className="mt-2 rounded border border-amber-200 bg-white p-2 font-mono text-xs">{lastSecret.password}</div>
              <button className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-md border border-amber-300 bg-white text-sm font-medium text-amber-900" onClick={() => copyText(lastSecret.password ?? "", setNotice)} type="button">
                <Copy size={15} /> Copy password
              </button>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function ActionPanel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">{icon}{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function EngineSelect({ value, onChange }: { value: Engine; onChange: (value: Engine) => void }) {
  return (
    <label className="space-y-1 text-xs font-medium text-panel-muted">
      Engine
      <select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange(event.target.value as Engine)} value={value}>
        <option value="POSTGRESQL">PostgreSQL</option>
        <option value="MYSQL">MySQL / MariaDB</option>
      </select>
    </label>
  );
}

function Input({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="space-y-1 text-xs font-medium text-panel-muted">
      {label}
      <input className="h-9 w-full rounded-md border border-panel-line px-3 font-mono text-sm text-panel-ink" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} />
    </label>
  );
}
