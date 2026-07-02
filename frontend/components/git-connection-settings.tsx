"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Github, KeyRound, Link2Off, RefreshCw, Save } from "lucide-react";
import { apiGet, apiPut } from "@/lib/api";

type GitHubConnection = {
  connected: boolean;
  username: string | null;
  installationId?: string | null;
  scopes: string[];
  connectedAt?: string | null;
};

export function GitConnectionSettings({ apiBase, scopeLabel }: { apiBase: string; scopeLabel: string }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [notice, setNotice] = useState("");
  const connection = useQuery({
    queryKey: ["github-connection-settings", apiBase],
    queryFn: () => apiGet<GitHubConnection>(`${apiBase}/connection`)
  });

  const saveToken = useMutation({
    mutationFn: () => apiPut<GitHubConnection>(`${apiBase}/connection`, {
      token,
      username: username.trim() || undefined,
      scopes: []
    }),
    onSuccess: async () => {
      setToken("");
      setUsername("");
      setNotice("GitHub connected. New deployments can sync private repositories.");
      await queryClient.invalidateQueries({ queryKey: ["github-connection-settings", apiBase] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-connection"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-repos"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not connect GitHub token.")
  });

  const disconnect = useMutation({
    mutationFn: () => apiPut<GitHubConnection>(`${apiBase}/connection`, {
      token: null,
      scopes: []
    }),
    onSuccess: async () => {
      setToken("");
      setUsername("");
      setNotice("GitHub disconnected.");
      await queryClient.invalidateQueries({ queryKey: ["github-connection-settings", apiBase] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-connection"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-repos"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not disconnect GitHub.")
  });

  const connected = Boolean(connection.data?.connected);
  const scopes = connection.data?.scopes ?? [];

  return (
    <section className="space-y-5 p-6">
      <div className="rounded-md border border-panel-line bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white"><Github size={17} /></span>
            <div>
              <div className="text-sm font-semibold text-panel-ink">GitHub connection</div>
              <div className="text-xs text-panel-muted">{scopeLabel}</div>
            </div>
          </div>
          <button
            className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
            disabled={connection.isFetching}
            onClick={() => connection.refetch()}
            type="button"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>

        <div className="grid gap-5 p-4 xl:grid-cols-[minmax(280px,420px)_1fr]">
          <div className="rounded-md border border-panel-line bg-slate-50 p-4">
            <div className="text-xs font-semibold uppercase text-panel-muted">Current status</div>
            {connection.isLoading ? (
              <div className="mt-3 text-sm text-panel-muted">Loading connection...</div>
            ) : (
              <div className="mt-3 space-y-3">
                <div className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${connected ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                  {connected ? "Connected" : "Not connected"}
                </div>
                <div className="text-sm text-panel-ink">
                  {connected ? `Connected${connection.data?.username ? ` as ${connection.data.username}` : ""}.` : "Private GitHub repositories will fail to deploy until a token is connected."}
                </div>
                {scopes.length > 0 ? <div className="text-xs text-panel-muted">Scopes: {scopes.join(", ")}</div> : null}
                {connection.data?.connectedAt ? <div className="text-xs text-panel-muted">Connected at {new Date(connection.data.connectedAt).toLocaleString()}</div> : null}
                <button
                  className="flex h-9 items-center gap-2 rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  disabled={!connected || disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                  type="button"
                >
                  <Link2Off size={15} /> {disconnect.isPending ? "Disconnecting..." : "Disconnect"}
                </button>
              </div>
            )}
          </div>

          <div className="rounded-md border border-panel-line p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-panel-ink"><KeyRound size={16} />Connect or reconnect token</div>
            <div className="mt-4 grid gap-3 md:grid-cols-[minmax(160px,260px)_1fr]">
              <Field label="GitHub username" value={username} onChange={setUsername} placeholder="optional" />
              <Field label="Personal access token" value={token} onChange={setToken} placeholder="github_pat_..." type="password" />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={!token.trim() || saveToken.isPending}
                onClick={() => saveToken.mutate()}
                type="button"
              >
                <Save size={16} /> {saveToken.isPending ? "Saving..." : connected ? "Reconnect GitHub" : "Connect GitHub"}
              </button>
              <span className="text-xs text-panel-muted">Token is stored encrypted and used only for GitHub API and deploy source sync.</span>
            </div>
          </div>
        </div>
      </div>

      {notice ? <div className="rounded-md border border-panel-line bg-white px-4 py-3 text-sm text-panel-ink">{notice}</div> : null}
    </section>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-panel-ink">{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} value={value} />
    </label>
  );
}
