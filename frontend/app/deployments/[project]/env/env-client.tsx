"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, List, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import type { Deployment, DeploymentEnvVar } from "../../deployment-types";
import { ProjectTabs, ResultNotice } from "../../deployment-ui";

function normalizeEnvValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseEnv(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{")) {
    const parsed = Function(`"use strict"; return (${trimmed});`)() as Record<string, unknown>;
    return Object.entries(parsed).map(([key, value]) => ({
      key: key.trim().toUpperCase(),
      value: normalizeEnvValue(value == null ? "" : String(value)),
      isSecret: false
    })).filter((item) => item.key);
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return { key: line.slice(0, index).trim().toUpperCase(), value: normalizeEnvValue(line.slice(index + 1)), isSecret: false };
    });
}

export function DeploymentEnvClient({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [isSecret, setIsSecret] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [notice, setNotice] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const detail = useQuery({ queryKey: ["deployment", project], queryFn: () => apiGet<Deployment>(`/deployments/${project}`) });
  const env = useQuery({
    queryKey: ["deployment-env", project],
    queryFn: () => apiGet<DeploymentEnvVar[]>(`/deployments/${project}/env`)
  });
  const envItems = env.data ?? [];
  const envCount = envItems.length;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["deployment-env", project] });
    await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
  };

  const saveOne = useMutation({
    mutationFn: () => apiPut<DeploymentEnvVar>(`/deployments/${project}/env/${encodeURIComponent(key)}`, { value: normalizeEnvValue(value), isSecret }),
    onSuccess: async () => {
      setNotice(`${key} saved.`);
      setKey("");
      setValue("");
      setIsSecret(false);
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save variable")
  });

  const saveBulk = useMutation({
    mutationFn: () => apiPost<{ ok: true; items: DeploymentEnvVar[] }>(`/deployments/${project}/env/bulk`, { env: parseEnv(bulkText) }),
    onSuccess: async (result) => {
      setNotice(`${result.items.length} variables imported.`);
      setBulkText("");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import variables")
  });

  const remove = useMutation({
    mutationFn: (itemKey: string) => apiDelete<{ ok: true }>(`/deployments/${project}/env/${encodeURIComponent(itemKey)}`),
    onSuccess: async (_result, itemKey) => {
      setNotice(`${itemKey} deleted.`);
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete variable")
  });

  const clearDatabaseOverrides = useMutation({
    mutationFn: () => apiPost<{ ok: true; removed: string[] }>(`/deployments/${project}/env/clear-database-overrides`, {}),
    onSuccess: async (result) => {
      setNotice(
        result.removed.length
          ? `Removed ${result.removed.join(", ")}. Redeploy to apply the panel-managed database password.`
          : "No manual database env overrides were stored."
      );
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not clear database overrides")
  });

  const hasDatabaseOverrides = envItems.some((item) => item.key === "DB_PASSWORD" || item.key === "DATABASE_URL");
  const deployment = detail.data;

  let bulkCount = 0;
  try {
    bulkCount = parseEnv(bulkText).length;
  } catch {
    bulkCount = 0;
  }

  return (
    <>
      <ProjectTabs active="env" project={project} />
      <section className="p-8">
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => env.refetch()} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-4 text-sm font-semibold hover:bg-slate-50"
            onClick={() => setListOpen(true)}
            type="button"
          >
            <List size={16} />
            List
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-panel-muted">{envCount}</span>
          </button>
          <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" onClick={() => setAddOpen(true)} type="button">
            <Plus size={16} />
            Env add
          </button>
        </div>

        {notice ? <div className="mt-4"><ResultNotice message={notice} ok={!/could|error|failed/i.test(notice)} /></div> : null}

        {listOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
            <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-panel-line p-4">
                <div className="flex items-center gap-2 text-sm font-semibold"><List size={17} />Environment variables</div>
                <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={() => setListOpen(false)} type="button"><X size={16} /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {deployment?.dbType && hasDatabaseOverrides ? (
                  <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                    <button
                      className="h-8 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold disabled:opacity-60"
                      disabled={clearDatabaseOverrides.isPending}
                      onClick={() => clearDatabaseOverrides.mutate()}
                      type="button"
                    >
                      {clearDatabaseOverrides.isPending ? "Clearing..." : "Clear database env overrides"}
                    </button>
                  </div>
                ) : null}
                <div className="overflow-hidden rounded-md border border-panel-line">
                  {envItems.map((item) => (
                    <div className="flex items-start gap-3 border-b border-panel-line p-3 last:border-b-0" key={item.key}>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm font-semibold">{item.key}</div>
                        <div className="mt-1 break-all font-mono text-xs text-panel-muted">{item.masked ? item.secretRef ?? "[secret]" : item.value}</div>
                      </div>
                      <button className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-panel-line px-2 text-xs text-panel-danger hover:bg-red-50" onClick={() => remove.mutate(item.key)} type="button">
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </div>
                  ))}
                  {envItems.length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No environment variables.</div> : null}
                </div>
              </div>
              <div className="flex justify-end border-t border-panel-line p-4">
                <button className="h-9 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" onClick={() => setListOpen(false)} type="button">Close</button>
              </div>
            </div>
          </div>
        ) : null}

        {addOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
            <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-md border border-panel-line bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-panel-line p-4">
                <div className="flex items-center gap-2 text-sm font-semibold"><KeyRound size={17} />Env add</div>
                <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={() => setAddOpen(false)} type="button"><X size={16} /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <div className="space-y-3">
                  <input className="h-9 w-full rounded-md border border-panel-line px-3 font-mono text-sm" onChange={(event) => setKey(event.target.value.toUpperCase())} placeholder="KEY" value={key} />
                  <textarea className="h-28 w-full rounded-md border border-panel-line p-3 font-mono text-sm" onChange={(event) => setValue(event.target.value)} placeholder="value" value={value} />
                  <label className="flex items-center gap-2 text-sm text-panel-muted"><input checked={isSecret} onChange={(event) => setIsSecret(event.target.checked)} type="checkbox" /> Store as secret</label>
                  <button className="h-10 w-full rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!key || saveOne.isPending} onClick={() => saveOne.mutate(undefined, { onSuccess: () => setAddOpen(false) })} type="button">{saveOne.isPending ? "Saving..." : "Save variable"}</button>
                </div>
                <div className="mt-6 border-t border-panel-line pt-4">
                  <div className="mb-3 text-xs font-semibold uppercase text-panel-muted">Bulk import</div>
                  <textarea className="h-36 w-full rounded-md border border-panel-line p-3 font-mono text-xs" onChange={(event) => setBulkText(event.target.value)} placeholder="APP_NAME=eBitans" value={bulkText} />
                  <button className="mt-3 h-10 w-full rounded-md border border-panel-line text-sm font-semibold disabled:opacity-60" disabled={!bulkCount || saveBulk.isPending} onClick={() => saveBulk.mutate(undefined, { onSuccess: () => setAddOpen(false) })} type="button">{saveBulk.isPending ? "Importing..." : `Import ${bulkCount} variables`}</button>
                </div>
              </div>
              <div className="flex justify-end border-t border-panel-line p-4">
                <button className="h-9 rounded-md border border-panel-line px-4 text-sm font-medium hover:bg-slate-50" onClick={() => setAddOpen(false)} type="button">Close</button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
