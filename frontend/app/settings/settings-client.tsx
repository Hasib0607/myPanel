"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, RotateCcw, Save, Settings2 } from "lucide-react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

type SettingsResponse = {
  username: string;
  envFile: string;
  entries: Array<{ key: string; value: string; masked: boolean; secret: boolean }>;
};

type EnvSaveResponse = {
  ok: boolean;
  updated: string[];
  restartRequired: boolean;
};

export function SettingsClient() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/settings")
  });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!settings.data) return;
    const next: Record<string, string> = {};
    for (const entry of settings.data.entries) next[entry.key] = entry.value;
    setEnvDraft(next);
  }, [settings.data]);

  const visibleEntries = useMemo(() => settings.data?.entries ?? [], [settings.data]);

  const changePassword = useMutation({
    mutationFn: () => apiPost("/settings/password", {
      currentPassword: password.currentPassword,
      newPassword: password.newPassword
    }),
    onSuccess: () => {
      setPassword({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setNotice("Panel password changed.");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not change password.")
  });

  const saveEnv = useMutation({
    mutationFn: () => apiPut<EnvSaveResponse>("/settings/env", {
      entries: visibleEntries
        .map((entry) => ({ key: entry.key, value: envDraft[entry.key] ?? "" }))
        .filter((entry) => {
          const original = visibleEntries.find((item) => item.key === entry.key);
          if (!original) return false;
          if (original.secret && original.masked && entry.value.trim() === "") return false;
          return entry.value !== original.value;
        })
    }),
    onSuccess: async (result) => {
      setNotice(result.updated.length > 0 ? `Saved ${result.updated.length} setting(s). Restart affected services to apply runtime-only changes.` : "No changes to save.");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save environment.")
  });

  const passwordInvalid = password.newPassword.length < 10 || password.newPassword !== password.confirmPassword || !password.currentPassword;

  return (
    <section className="space-y-5 p-6">
      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center gap-3 border-b border-panel-line px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><KeyRound size={17} /></span>
            <div>
              <div className="text-sm font-semibold text-panel-ink">Panel password</div>
              <div className="text-xs text-panel-muted">Signed in as {settings.data?.username ?? "admin"}</div>
            </div>
          </div>
          <div className="space-y-3 p-4">
            <Field label="Current password" type="password" value={password.currentPassword} onChange={(currentPassword) => setPassword({ ...password, currentPassword })} />
            <Field label="New password" type="password" value={password.newPassword} onChange={(newPassword) => setPassword({ ...password, newPassword })} />
            <Field label="Confirm password" type="password" value={password.confirmPassword} onChange={(confirmPassword) => setPassword({ ...password, confirmPassword })} />
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60"
              disabled={passwordInvalid || changePassword.isPending}
              onClick={() => changePassword.mutate()}
              type="button"
            >
              <Save size={16} /> {changePassword.isPending ? "Saving..." : "Change password"}
            </button>
          </div>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><Settings2 size={17} /></span>
              <div>
                <div className="text-sm font-semibold text-panel-ink">Environment</div>
                <div className="text-xs text-panel-muted">{settings.data?.envFile ?? "Panel .env"}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={() => settings.refetch()} type="button">
                <RotateCcw size={15} /> Refresh
              </button>
              <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={saveEnv.isPending} onClick={() => saveEnv.mutate()} type="button">
                <Save size={15} /> {saveEnv.isPending ? "Saving..." : "Save env"}
              </button>
            </div>
          </div>

          <div className="max-h-[calc(100vh-190px)] overflow-auto">
            <table className="min-w-full divide-y divide-panel-line text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-panel-muted">
                <tr>
                  <th className="w-72 px-4 py-3">Key</th>
                  <th className="px-4 py-3">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-panel-line">
                {visibleEntries.map((entry) => {
                  const showSecret = revealed[entry.key] || !entry.secret;
                  return (
                    <tr key={entry.key}>
                      <td className="px-4 py-3 font-mono text-xs text-panel-ink">{entry.key}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <input
                            className="h-10 min-w-0 flex-1 rounded-md border border-panel-line px-3 font-mono text-xs"
                            onChange={(event) => setEnvDraft({ ...envDraft, [entry.key]: event.target.value })}
                            placeholder={entry.secret && entry.masked ? "Leave blank to keep current value" : ""}
                            type={showSecret ? "text" : "password"}
                            value={envDraft[entry.key] ?? ""}
                          />
                          {entry.secret ? (
                            <button
                              className="grid h-10 w-10 place-items-center rounded-md border border-panel-line hover:bg-slate-50"
                              onClick={() => setRevealed({ ...revealed, [entry.key]: !revealed[entry.key] })}
                              title={showSecret ? "Hide value" : "Show value"}
                              type="button"
                            >
                              {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {notice ? (
        <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm text-panel-ink">{notice}</div>
      ) : null}
    </section>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-panel-ink">{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => onChange(event.target.value)} type={type} value={value} />
    </label>
  );
}
