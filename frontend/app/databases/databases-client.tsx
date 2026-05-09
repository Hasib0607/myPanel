"use client";

import type React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Database, Download, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2, Upload, UserRound } from "lucide-react";
import { apiDeleteBody, apiGet, apiPost } from "@/lib/api";

type Engine = "POSTGRESQL" | "MYSQL";
type CommandResult = { dryRun?: boolean; command?: string[]; stdout?: string; stderr?: string; returncode?: number };
type DatabaseItem = { name: string; owner: string | null };
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

const engines: Engine[] = ["POSTGRESQL", "MYSQL"];
const initialForm = { engine: "POSTGRESQL" as Engine, database: "", username: "", password: "" };

function cleanIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function copyText(value: string, setNotice: (value: string) => void) {
  await navigator.clipboard?.writeText(value);
  setNotice("Copied.");
}

export function DatabasesClient() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(initialForm);
  const [grant, setGrant] = useState(initialForm);
  const [passwordForm, setPasswordForm] = useState({ engine: "POSTGRESQL" as Engine, username: "", password: "" });
  const [transfer, setTransfer] = useState({ engine: "POSTGRESQL" as Engine, database: "", sql: "" });
  const [lastSecret, setLastSecret] = useState<CredentialResult | null>(null);

  const overview = useQuery({
    queryKey: ["databases-overview"],
    queryFn: () => apiGet<DatabaseOverview>("/databases")
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["databases-overview"] });
  };

  const createDb = useMutation({
    mutationFn: () => apiPost<CredentialResult>("/databases", { ...form, password: form.password || undefined }),
    onSuccess: async (result) => {
      setLastSecret(result);
      setNotice(`${form.database} created.`);
      setForm(initialForm);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create database")
  });

  const changePassword = useMutation({
    mutationFn: () => apiPost<CredentialResult>("/databases/password", { ...passwordForm, password: passwordForm.password || undefined }),
    onSuccess: async (result) => {
      setLastSecret(result);
      setNotice(`${passwordForm.username} password changed.`);
      setPasswordForm({ engine: passwordForm.engine, username: "", password: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not change password")
  });

  const grantAccess = useMutation({
    mutationFn: () => apiPost("/databases/grant", grant),
    onSuccess: async () => {
      setNotice(`Granted ${grant.username} access to ${grant.database}.`);
      setGrant({ ...grant, database: "", username: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not grant access")
  });

  const deleteDatabase = useMutation({
    mutationFn: (input: { engine: Engine; database: string }) => apiDeleteBody("/databases", input),
    onSuccess: async (_result, input) => {
      setNotice(`${input.database} deleted.`);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete database")
  });

  const exportDatabase = useMutation({
    mutationFn: () => apiPost<ExportResult>("/databases/export", { engine: transfer.engine, database: transfer.database }),
    onSuccess: (result) => {
      const blob = new Blob([result.dump], { type: "application/sql;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      anchor.href = url;
      anchor.download = `${result.database}-${stamp}.sql`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice(`${result.database} exported.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not export database")
  });

  const importDatabase = useMutation({
    mutationFn: () => apiPost("/databases/import", transfer),
    onSuccess: async () => {
      setNotice(`Imported SQL into ${transfer.database}.`);
      setTransfer({ ...transfer, sql: "" });
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import database")
  });

  const engineMap = useMemo(() => new Map((overview.data?.engines ?? []).map((item) => [item.engine, item])), [overview.data]);

  return (
    <div className="space-y-5 p-6">
      {notice ? <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div> : null}

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
                      <div className="flex items-center justify-between border-b border-panel-line px-4 py-3 last:border-b-0" key={database.name}>
                        <div>
                          <div className="font-mono text-sm font-semibold">{database.name}</div>
                          <div className="text-xs text-panel-muted">{database.owner ? `owner ${database.owner}` : "owner unknown"}</div>
                        </div>
                        <button className="rounded-md border border-panel-line p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteDatabase.mutate({ engine, database: database.name })} type="button" title="Delete database">
                          <Trash2 size={15} />
                        </button>
                        <button
                          className="rounded-md border border-panel-line p-2 hover:bg-slate-50"
                          onClick={() => setTransfer({ ...transfer, engine, database: database.name })}
                          type="button"
                          title="Use in import/export"
                        >
                          <Download size={15} />
                        </button>
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
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-semibold disabled:opacity-60" disabled={!transfer.database || exportDatabase.isPending} onClick={() => exportDatabase.mutate()} type="button">
              <Download size={15} /> {exportDatabase.isPending ? "Exporting..." : "Export SQL"}
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
