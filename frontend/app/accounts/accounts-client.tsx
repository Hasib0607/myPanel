"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { KeyRound, Plus, RefreshCw, Trash2, UserRound } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

type Account = {
  id: string;
  username: string;
  email: string | null;
  ownerName: string | null;
  status: "ACTIVE" | "SUSPENDED";
  homeRoot: string;
  packageName: string | null;
  diskLimitMb: number | null;
  domainLimit: number | null;
  mailboxLimit: number | null;
  databaseLimit: number | null;
  deploymentLimit: number | null;
  generatedPassword?: string;
  _count?: { domains: number; deployments: number; mailAccounts: number };
};
type HostingPackage = { id: string; name: string; diskLimitMb: number | null; domainLimit: number | null; mailboxLimit: number | null; databaseLimit: number | null; deploymentLimit: number | null };

const initialDraft = {
  username: "",
  email: "",
  ownerName: "",
  password: "",
  packageId: "",
  packageName: "Default",
  diskLimitMb: "10240",
  domainLimit: "5",
  mailboxLimit: "10",
  databaseLimit: "3",
  deploymentLimit: "5"
};

export function AccountsClient() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initialDraft);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const accounts = useQuery({
    queryKey: ["accounts", search, status],
    queryFn: () => apiGet<{ items: Account[] }>(`/accounts?search=${encodeURIComponent(search)}${status ? `&status=${status}` : ""}`)
  });
  const packages = useQuery({
    queryKey: ["packages"],
    queryFn: () => apiGet<{ items: HostingPackage[] }>("/packages")
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["accounts"] });

  const createAccount = useMutation({
    mutationFn: () => apiPost<Account>("/accounts", {
      username: draft.username,
      email: draft.email || null,
      ownerName: draft.ownerName || null,
      password: draft.password || undefined,
      packageId: draft.packageId || null,
      packageName: draft.packageName || null,
      diskLimitMb: draft.diskLimitMb ? Number(draft.diskLimitMb) : null,
      domainLimit: draft.domainLimit ? Number(draft.domainLimit) : null,
      mailboxLimit: draft.mailboxLimit ? Number(draft.mailboxLimit) : null,
      databaseLimit: draft.databaseLimit ? Number(draft.databaseLimit) : null,
      deploymentLimit: draft.deploymentLimit ? Number(draft.deploymentLimit) : null
    }),
    onSuccess: async (account) => {
      setDraft(initialDraft);
      setNotice(account.generatedPassword ? `Account ${account.username} created. Password: ${account.generatedPassword}` : `Account ${account.username} created.`);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create account.")
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "ACTIVE" | "SUSPENDED" }) => apiPatch(`/accounts/${id}`, { status }),
    onSuccess: async () => {
      setNotice("Account status updated.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update account.")
  });

  const resetPassword = useMutation({
    mutationFn: (id: string) => apiPost<{ username: string; generatedPassword?: string }>(`/accounts/${id}/password`, {}),
    onSuccess: (result) => setNotice(result.generatedPassword ? `${result.username} password: ${result.generatedPassword}` : "Password reset."),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not reset password.")
  });

  const deleteAccount = useMutation({
    mutationFn: (id: string) => apiDelete(`/accounts/${id}?linkedResourceAction=unassign`),
    onSuccess: async () => {
      setNotice("Account deleted.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete account.")
  });

  return (
    <section className="grid grid-cols-[360px_1fr] gap-6 p-8">
      <div className="rounded-md border border-panel-line bg-white">
        <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Create Account</div>
        <div className="space-y-3 p-4">
          <Input label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username: cleanUsername(username) })} />
          <Input label="Email" value={draft.email} onChange={(email) => setDraft({ ...draft, email })} />
          <Input label="Owner" value={draft.ownerName} onChange={(ownerName) => setDraft({ ...draft, ownerName })} />
          <Input label="Password (optional)" value={draft.password} onChange={(password) => setDraft({ ...draft, password })} type="password" />
          <label className="block space-y-1 text-xs font-medium text-panel-muted">
            <span>Package template</span>
            <select
              className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink"
              onChange={(event) => {
                const selected = packages.data?.items.find((item) => item.id === event.target.value);
                setDraft({
                  ...draft,
                  packageId: event.target.value,
                  packageName: selected?.name ?? draft.packageName,
                  diskLimitMb: selected?.diskLimitMb?.toString() ?? draft.diskLimitMb,
                  domainLimit: selected?.domainLimit?.toString() ?? draft.domainLimit,
                  mailboxLimit: selected?.mailboxLimit?.toString() ?? draft.mailboxLimit,
                  databaseLimit: selected?.databaseLimit?.toString() ?? draft.databaseLimit,
                  deploymentLimit: selected?.deploymentLimit?.toString() ?? draft.deploymentLimit
                });
              }}
              value={draft.packageId}
            >
              <option value="">Manual limits</option>
              {(packages.data?.items ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Disk MB" value={draft.diskLimitMb} onChange={(diskLimitMb) => setDraft({ ...draft, diskLimitMb: digitsOnly(diskLimitMb) })} />
            <Input label="Domains" value={draft.domainLimit} onChange={(domainLimit) => setDraft({ ...draft, domainLimit: digitsOnly(domainLimit) })} />
            <Input label="Mailboxes" value={draft.mailboxLimit} onChange={(mailboxLimit) => setDraft({ ...draft, mailboxLimit: digitsOnly(mailboxLimit) })} />
            <Input label="Databases" value={draft.databaseLimit} onChange={(databaseLimit) => setDraft({ ...draft, databaseLimit: digitsOnly(databaseLimit) })} />
            <Input label="Deployments" value={draft.deploymentLimit} onChange={(deploymentLimit) => setDraft({ ...draft, deploymentLimit: digitsOnly(deploymentLimit) })} />
          </div>
          <Input label="Package" value={draft.packageName} onChange={(packageName) => setDraft({ ...draft, packageName })} />
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.username || createAccount.isPending} onClick={() => createAccount.mutate()} type="button">
            <Plus size={15} />
            Create Account
          </button>
          {notice ? <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">{notice}</div> : null}
        </div>
      </div>

      <div className="rounded-md border border-panel-line bg-white">
        <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
          <div className="text-sm font-semibold">Hosting Accounts</div>
          <div className="flex items-center gap-2">
            <input className="h-9 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setSearch(event.target.value)} placeholder="Search" value={search} />
            <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setStatus(event.target.value)} value={status}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
            <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => refresh()} type="button" title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>
        </div>
        <div className="divide-y divide-panel-line">
          {(accounts.data?.items ?? []).map((account) => (
            <div className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3" key={account.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <UserRound size={16} />
                  <Link className="font-semibold text-panel-accent hover:underline" href={`/accounts/${account.id}`}>{account.username}</Link>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${account.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-panel-danger"}`}>{account.status}</span>
                </div>
                <div className="mt-1 text-sm text-panel-muted">{account.email || "No email"} · {account.ownerName || "No owner"}</div>
                <div className="mt-1 truncate font-mono text-xs text-panel-muted">{account.homeRoot}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-panel-muted">
                  <span>{account._count?.domains ?? 0} domains</span>
                  <span>{account._count?.deployments ?? 0} deployments</span>
                  <span>{account._count?.mailAccounts ?? 0} mailboxes</span>
                  <span>{account.diskLimitMb ?? "-"} MB</span>
                  <span>{account.deploymentLimit ?? "-"} deploy limit</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => resetPassword.mutate(account.id)} type="button" title="Reset password">
                  <KeyRound size={15} />
                </button>
                <button className="rounded-md border border-panel-line px-3 py-2 text-sm hover:bg-slate-50" onClick={() => updateStatus.mutate({ id: account.id, status: account.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" })} type="button">
                  {account.status === "ACTIVE" ? "Suspend" : "Activate"}
                </button>
                <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => window.confirm("Delete account and unassign linked resources?") ? deleteAccount.mutate(account.id) : undefined} type="button" title="Delete">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
          {accounts.isLoading ? <div className="p-8 text-sm text-panel-muted">Loading accounts...</div> : null}
          {!accounts.isLoading && !(accounts.data?.items ?? []).length ? <div className="p-8 text-sm text-panel-muted">No accounts created yet.</div> : null}
        </div>
      </div>
    </section>
  );
}

function cleanUsername(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block space-y-1 text-xs font-medium text-panel-muted">
      <span>{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => onChange(event.target.value)} type={type} value={value} />
    </label>
  );
}
