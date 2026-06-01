"use client";

import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, KeyRound, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import type { Deployment, DeploymentEnvVar } from "../../deployment-types";
import { EmptyState, ProjectTabs, ResultNotice } from "../../deployment-ui";

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

  const detail = useQuery({ queryKey: ["deployment", project], queryFn: () => apiGet<Deployment>(`/deployments/${project}`) });
  const env = useQuery({
    queryKey: ["deployment-env", project],
    queryFn: () => apiGet<DeploymentEnvVar[]>(`/deployments/${project}/env`)
  });
  const envText = useMemo(() => (env.data ?? []).map((item) => `${item.key}=${item.masked ? "[secret]" : item.value ?? ""}`).join("\n"), [env.data]);

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

  const hasDatabaseOverrides = (env.data ?? []).some((item) => item.key === "DB_PASSWORD" || item.key === "DATABASE_URL");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveOne.mutate();
  }

  return (
    <>
      <ProjectTabs active="env" project={project} />
      <section className="grid grid-cols-[minmax(0,1fr)_380px] gap-6 p-8">
        <main className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center justify-between border-b border-panel-line p-4">
            <div>
              <div className="text-sm font-semibold">{detail.data?.name ?? project} Environment</div>
              <div className="mt-1 text-xs text-panel-muted">Secrets are stored as references and masked when returned by the API.</div>
            </div>
            <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => env.refetch()} type="button"><RefreshCw size={15} />Refresh</button>
          </div>
          <div className="p-4">
            {notice ? <ResultNotice message={notice} ok={!/could|error|failed/i.test(notice)} /> : null}
            {detail.data?.dbType && hasDatabaseOverrides ? (
              <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <div className="font-semibold">Database password is managed by the panel</div>
                <p className="mt-1 text-xs leading-5 text-amber-900">
                  Clear manual <span className="font-mono">DB_PASSWORD</span> / <span className="font-mono">DATABASE_URL</span> values, then redeploy.
                </p>
                <button
                  className="mt-3 h-8 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold disabled:opacity-60"
                  disabled={clearDatabaseOverrides.isPending}
                  onClick={() => clearDatabaseOverrides.mutate()}
                  type="button"
                >
                  {clearDatabaseOverrides.isPending ? "Clearing..." : "Clear database env overrides"}
                </button>
              </div>
            ) : null}
            <div className="mt-4 overflow-x-auto rounded-md border border-panel-line">
              {(env.data ?? []).length > 0 ? (
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                    <tr>
                      <th className="px-4 py-3">Key</th>
                      <th className="px-4 py-3">Value</th>
                      <th className="px-4 py-3">Updated</th>
                      <th className="sticky right-0 bg-slate-50 px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(env.data ?? []).map((item) => (
                      <tr className="border-t border-panel-line" key={item.key}>
                        <td className="px-4 py-3 font-mono text-xs font-semibold">{item.key}</td>
                        <td className="max-w-md px-4 py-3">
                          <div className="flex min-w-0 items-start gap-2">
                            {item.masked ? <EyeOff size={14} className="mt-0.5 shrink-0" /> : null}
                            <span className="break-all font-mono text-xs">{item.masked ? item.secretRef ?? "[secret]" : item.value}</span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-panel-muted">{new Date(item.updatedAt).toLocaleString()}</td>
                        <td className="sticky right-0 bg-white px-4 py-3">
                          <button className="flex h-8 items-center gap-2 rounded-md border border-panel-line px-2 text-xs text-panel-danger hover:bg-red-50" onClick={() => remove.mutate(item.key)} type="button"><Trash2 size={13} />Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState title="No variables" detail="Add single keys or paste a .env block to seed runtime config." />
              )}
            </div>
          </div>
        </main>

        <aside className="space-y-4">
          <form className="rounded-md border border-panel-line bg-white p-4" onSubmit={submit}>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><KeyRound size={16} />Add Variable</div>
            <div className="space-y-3">
              <input className="h-9 w-full rounded-md border border-panel-line px-3 font-mono text-sm" onChange={(event) => setKey(event.target.value.toUpperCase())} placeholder="KEY" value={key} />
              <textarea className="h-24 w-full rounded-md border border-panel-line p-3 font-mono text-sm" onChange={(event) => setValue(event.target.value)} placeholder="value" value={value} />
              <label className="flex items-center gap-2 text-sm text-panel-muted"><input checked={isSecret} onChange={(event) => setIsSecret(event.target.checked)} type="checkbox" /> Store as secret reference</label>
              <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!key || saveOne.isPending} type="submit"><Plus size={15} />Save Variable</button>
            </div>
          </form>

          <div className="rounded-md border border-panel-line bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Upload size={16} />Bulk Import</div>
            <textarea className="h-48 w-full rounded-md border border-panel-line p-3 font-mono text-xs" onChange={(event) => setBulkText(event.target.value)} placeholder={`{\n  APP_NAME: "eBitans",\n  APP_ENV: "production"\n}\n\nor\n\nAPP_KEY=value`} value={bulkText} />
            <button className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50 disabled:opacity-60" disabled={!parseEnv(bulkText).length || saveBulk.isPending} onClick={() => saveBulk.mutate()} type="button"><Save size={15} />Import .env</button>
          </div>

          <div className="rounded-md border border-panel-line bg-slate-950 p-4">
            <div className="mb-2 text-xs font-semibold uppercase text-slate-400">Current .env</div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-100">{envText || "No variables"}</pre>
          </div>
        </aside>
      </section>
    </>
  );
}
