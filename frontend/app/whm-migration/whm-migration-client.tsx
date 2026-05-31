"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Database, Download, FileText, Mail, Play, RefreshCw, RotateCcw, ServerCog, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

type Migration = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  verifySsl: boolean;
  status: string;
  summary: Record<string, unknown>;
  serverInfo: Record<string, unknown>;
  lastScanAt: string | null;
  _count?: { items: number; tasks: number };
};

type MigrationItem = {
  id: string;
  type: string;
  sourceAccount: string | null;
  name: string;
  status: string;
  targetType: string | null;
  targetId: string | null;
  warnings: string[];
};

type MigrationTask = {
  id: string;
  type: string;
  account: string | null;
  domain: string | null;
  status: string;
  command: string | null;
};

const emptyConnection = {
  name: "WHM migration",
  host: "",
  port: "2087",
  username: "root",
  token: "",
  verifySsl: true
};

export function WhmMigrationClient() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(emptyConnection);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const migrations = useQuery({
    queryKey: ["whm-migrations"],
    queryFn: () => apiGet<{ items: Migration[] }>("/whm-migrations")
  });
  const activeId = selectedId ?? migrations.data?.items[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["whm-migration", activeId],
    enabled: !!activeId,
    queryFn: () => apiGet<{ migration: Migration; items: MigrationItem[]; tasks: MigrationTask[] }>(`/whm-migrations/${activeId}`)
  });
  const active = detail.data?.migration;
  const counts = useMemo(() => groupCounts(detail.data?.items ?? []), [detail.data?.items]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["whm-migrations"] });
    if (activeId) await queryClient.invalidateQueries({ queryKey: ["whm-migration", activeId] });
  };

  const create = useMutation({
    mutationFn: () => apiPost<Migration>("/whm-migrations", { ...draft, port: Number(draft.port) }),
    onSuccess: async (migration) => {
      setNotice("WHM connection saved.");
      setSelectedId(migration.id);
      setDraft(emptyConnection);
      await refresh();
    },
    onError: showError(setNotice)
  });
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => apiPost(path, body),
    onSuccess: async () => {
      setNotice("Action completed.");
      await refresh();
    },
    onError: showError(setNotice)
  });

  return (
    <section className="space-y-6 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-normal text-panel-ink">WHM Migration</h1>
          <p className="mt-1 text-sm text-panel-muted">Read-only discovery, import mapping, migration tasks, cutover, and rollback.</p>
        </div>
        <button className="rounded-md border border-panel-line p-2 hover:bg-white" onClick={() => refresh()} type="button" title="Refresh">
          <RefreshCw size={16} />
        </button>
      </header>

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <div className="space-y-6">
          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Connect WHM</div>
            <div className="space-y-3 p-4">
              <Input label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
              <Input label="Host / IP" value={draft.host} onChange={(host) => setDraft({ ...draft, host })} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Port" value={draft.port} onChange={(port) => setDraft({ ...draft, port: port.replace(/\D/g, "") })} />
                <Input label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username })} />
              </div>
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>API Token</span>
                <textarea className="min-h-24 w-full rounded-md border border-panel-line px-3 py-2 text-sm text-panel-ink" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input checked={draft.verifySsl} onChange={(event) => setDraft({ ...draft, verifySsl: event.target.checked })} type="checkbox" />
                Verify WHM SSL
              </label>
              <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.host || !draft.token || create.isPending} onClick={() => create.mutate()} type="button">
                <ServerCog size={15} />
                Save Connector
              </button>
              {notice ? <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">{notice}</div> : null}
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Saved Migrations</div>
            <div className="divide-y divide-panel-line">
              {(migrations.data?.items ?? []).map((item) => (
                <button className={`block w-full px-4 py-3 text-left hover:bg-slate-50 ${activeId === item.id ? "bg-slate-50" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)} type="button">
                  <div className="font-semibold text-panel-ink">{item.name}</div>
                  <div className="mt-1 text-xs text-panel-muted">{item.host}:{item.port} · {item.status} · {item._count?.items ?? 0} items</div>
                </button>
              ))}
              {!migrations.isLoading && !(migrations.data?.items ?? []).length ? <div className="p-4 text-sm text-panel-muted">No WHM migrations yet.</div> : null}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {active ? (
            <>
              <div className="rounded-md border border-panel-line bg-white">
                <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
                  <div>
                    <div className="font-semibold">{active.name}</div>
                    <div className="text-xs text-panel-muted">{active.host}:{active.port} · {active.username} · {active.status}</div>
                  </div>
                  <div className="flex gap-2">
                    <ActionButton icon={ShieldCheck} label="Test" onClick={() => action.mutate({ path: `/whm-migrations/${active.id}/test` })} />
                    <ActionButton icon={RefreshCw} label="Scan" onClick={() => action.mutate({ path: `/whm-migrations/${active.id}/scan` })} />
                    <ActionButton icon={Download} label="Import" onClick={() => action.mutate({ path: `/whm-migrations/${active.id}/import`, body: { includePackages: true, includeAccounts: true, includeDomains: true, includeDns: true } })} />
                    <ActionButton icon={Play} label="Prepare Tasks" onClick={() => action.mutate({ path: `/whm-migrations/${active.id}/tasks/prepare`, body: {} })} />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3 p-4">
                  <Stat label="Accounts" value={counts.ACCOUNT ?? 0} />
                  <Stat label="Domains" value={counts.DOMAIN ?? 0} />
                  <Stat label="DNS Records" value={counts.DNS_RECORD ?? 0} />
                  <Stat label="Mailboxes" value={counts.MAILBOX ?? 0} />
                </div>
              </div>

              <div className="rounded-md border border-panel-line bg-white">
                <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Discovery Items</div>
                <div className="max-h-[460px] divide-y divide-panel-line overflow-auto">
                  {(detail.data?.items ?? []).map((item) => (
                    <div className="grid grid-cols-[120px_1fr_120px_120px] gap-3 px-4 py-3 text-sm" key={item.id}>
                      <span className="font-medium text-panel-muted">{item.type}</span>
                      <span className="min-w-0 truncate font-semibold">{item.name}</span>
                      <span className="text-panel-muted">{item.sourceAccount ?? "-"}</span>
                      <span className={statusClass(item.status)}>{item.status}</span>
                    </div>
                  ))}
                  {detail.isLoading ? <div className="p-6 text-sm text-panel-muted">Loading migration details...</div> : null}
                </div>
              </div>

              <div className="rounded-md border border-panel-line bg-white">
                <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Migration Queue</div>
                <div className="divide-y divide-panel-line">
                  {(detail.data?.tasks ?? []).map((task) => (
                    <div className="space-y-2 px-4 py-3" key={task.id}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          <TaskIcon type={task.type} />
                          {task.type} {task.account ? `· ${task.account}` : ""}
                        </div>
                        <button className="rounded-md border border-panel-line px-3 py-1.5 text-xs font-semibold hover:bg-slate-50" onClick={() => action.mutate({ path: `/whm-migrations/${active.id}/tasks/${task.id}/run` })} type="button">
                          Preview
                        </button>
                      </div>
                      {task.command ? <pre className="overflow-auto rounded-md bg-slate-950 p-3 text-xs text-white">{task.command}</pre> : null}
                    </div>
                  ))}
                  {!(detail.data?.tasks ?? []).length ? <div className="p-6 text-sm text-panel-muted">No migration tasks prepared yet.</div> : null}
                </div>
              </div>
            </>
          ) : (
            <div className="rounded-md border border-panel-line bg-white p-8 text-sm text-panel-muted">Create or select a WHM migration connector.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function groupCounts(items: MigrationItem[]) {
  return items.reduce<Record<string, number>>((acc, item) => {
    acc[item.type] = (acc[item.type] ?? 0) + 1;
    return acc;
  }, {});
}

function showError(setNotice: (value: string) => void) {
  return (error: unknown) => setNotice(error instanceof Error ? error.message : "Action failed.");
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1 text-xs font-medium text-panel-muted">
      <span>{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ActionButton({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={onClick} type="button">
      <Icon size={15} />
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-panel-line p-3">
      <div className="text-xs font-semibold uppercase text-panel-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-panel-accent">{value}</div>
    </div>
  );
}

function statusClass(status: string) {
  if (["IMPORTED", "SUCCEEDED"].includes(status)) return "text-emerald-700";
  if (["FAILED"].includes(status)) return "text-panel-danger";
  if (["RUNNING", "QUEUED"].includes(status)) return "text-amber-700";
  return "text-panel-muted";
}

function TaskIcon({ type }: { type: string }) {
  const Icon = type === "FILE_SYNC" ? FileText : type === "DATABASE_DUMP" ? Database : type === "MAIL_SYNC" ? Mail : type === "ROLLBACK" ? RotateCcw : CheckCircle2;
  return <Icon size={15} />;
}
