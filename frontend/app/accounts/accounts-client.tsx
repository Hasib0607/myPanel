"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { KeyRound, LogIn, Plus, RefreshCw, Trash2, UserRound } from "lucide-react";
import { ConfirmModal } from "@/components/confirm-modal";
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
  domainName: "",
  email: "",
  ownerName: "",
  password: "",
  confirmPassword: "",
  packageId: "",
  packageName: "Default",
  diskLimitGb: "10",
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
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const accounts = useQuery({
    queryKey: ["accounts", search, status],
    queryFn: () => apiGet<{ items: Account[] }>(`/accounts?search=${encodeURIComponent(search)}${status ? `&status=${status}` : ""}`)
  });
  const packages = useQuery({
    queryKey: ["packages"],
    queryFn: () => apiGet<{ items: HostingPackage[] }>("/packages")
  });
  const passwordMismatch = Boolean(draft.password || draft.confirmPassword) && draft.password !== draft.confirmPassword;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["accounts"] });

  const createAccount = useMutation({
    mutationFn: () => apiPost<Account>("/accounts", {
      username: draft.username,
      domainName: draft.domainName || undefined,
      email: draft.email || null,
      ownerName: draft.ownerName || null,
      password: draft.password || undefined,
      confirmPassword: draft.password ? draft.confirmPassword : undefined,
      packageId: draft.packageId || null,
      packageName: draft.packageName || null,
      diskLimitMb: draft.diskLimitGb ? Number(draft.diskLimitGb) * 1024 : null,
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

  const loginAsAccount = useMutation({
    mutationFn: (id: string) => apiPost<{ redirectTo?: string }>(`/auth/account/${id}/impersonate`, {}),
    onSuccess: (result) => window.location.assign(result.redirectTo ?? "/account"),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not login as account.")
  });

  const deleteAccount = useMutation({
    mutationFn: (id: string) => apiDelete(`/accounts/${id}?linkedResourceAction=unassign`),
    onSuccess: async () => {
      setNotice("Account deleted.");
      setDeleteTarget(null);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete account.")
  });

  return (
    <section className="grid gap-6 p-6 xl:grid-cols-[360px_1fr] xl:p-8">
      <div className="rounded-md border border-panel-line bg-white shadow-sm">
        <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Create Account</div>
        <div className="space-y-3 p-4">
          <Input label="Username" value={draft.username} onChange={(username) => setDraft({ ...draft, username: cleanUsername(username) })} />
          <Input label="Domain" value={draft.domainName} onChange={(domainName) => setDraft({ ...draft, domainName: cleanDomain(domainName) })} placeholder="example.com" />
          <Input label="Email" value={draft.email} onChange={(email) => setDraft({ ...draft, email })} />
          <Input label="Owner" value={draft.ownerName} onChange={(ownerName) => setDraft({ ...draft, ownerName })} />
          <Input label="Password" value={draft.password} onChange={(password) => setDraft({ ...draft, password })} type="password" />
          <Input label="Confirm password" value={draft.confirmPassword} onChange={(confirmPassword) => setDraft({ ...draft, confirmPassword })} type="password" />
          {passwordMismatch ? <div className="text-xs font-medium text-panel-danger">Passwords do not match.</div> : null}
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
                  diskLimitGb: selected?.diskLimitMb != null ? mbToGbInput(selected.diskLimitMb) : draft.diskLimitGb,
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
            <Input label="Disk GB" value={draft.diskLimitGb} onChange={(diskLimitGb) => setDraft({ ...draft, diskLimitGb: decimalNumber(diskLimitGb) })} />
            <Input label="Domains" value={draft.domainLimit} onChange={(domainLimit) => setDraft({ ...draft, domainLimit: digitsOnly(domainLimit) })} />
            <Input label="Mailboxes" value={draft.mailboxLimit} onChange={(mailboxLimit) => setDraft({ ...draft, mailboxLimit: digitsOnly(mailboxLimit) })} />
            <Input label="Databases" value={draft.databaseLimit} onChange={(databaseLimit) => setDraft({ ...draft, databaseLimit: digitsOnly(databaseLimit) })} />
            <Input label="Deployments" value={draft.deploymentLimit} onChange={(deploymentLimit) => setDraft({ ...draft, deploymentLimit: digitsOnly(deploymentLimit) })} />
          </div>
          <Input label="Package" value={draft.packageName} onChange={(packageName) => setDraft({ ...draft, packageName })} />
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.username || passwordMismatch || createAccount.isPending} onClick={() => createAccount.mutate()} type="button">
            <Plus size={15} />
            Create Account
          </button>
          {notice ? <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">{notice}</div> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-panel-line bg-white shadow-sm">
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
        <div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-panel-muted">
              <tr>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Usage</th>
                <th className="px-4 py-3">Limits</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(accounts.data?.items ?? []).map((account) => (
                <tr className="border-t border-panel-line" key={account.id}>
                  <td className="px-4 py-3">
                    <div className="flex min-w-56 items-center gap-2">
                      <UserRound className="text-panel-muted" size={16} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <Link className="truncate font-semibold text-panel-accent hover:underline" href={`/accounts/${account.id}`}>{account.username}</Link>
                          <button
                            className="shrink-0 rounded-md border border-panel-line p-1.5 text-panel-muted hover:bg-slate-50 hover:text-panel-accent disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={account.status !== "ACTIVE" || loginAsAccount.isPending}
                            onClick={() => loginAsAccount.mutate(account.id)}
                            title="Login as account"
                            type="button"
                          >
                            <LogIn size={13} />
                          </button>
                        </div>
                        <div className="mt-1 truncate font-mono text-xs text-panel-muted">{account.homeRoot}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{account.ownerName || "No owner"}</div>
                    <div className="mt-1 text-xs text-panel-muted">{account.email || "No email"}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-panel-muted">
                    <div>{account._count?.domains ?? 0} domains</div>
                    <div>{account._count?.deployments ?? 0} deployments</div>
                    <div>{account._count?.mailAccounts ?? 0} mailboxes</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-panel-muted">
                    <div>{formatDiskGb(account.diskLimitMb)} disk</div>
                    <div>{account.deploymentLimit ?? "-"} deploy limit</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${account.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-panel-danger"}`}>{account.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => resetPassword.mutate(account.id)} type="button" title="Reset password">
                        <KeyRound size={15} />
                      </button>
                      <button className="rounded-md border border-panel-line px-3 py-2 text-sm hover:bg-slate-50" onClick={() => updateStatus.mutate({ id: account.id, status: account.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" })} type="button">
                        {account.status === "ACTIVE" ? "Suspend" : "Activate"}
                      </button>
                      <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => setDeleteTarget(account)} type="button" title="Delete">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {accounts.isLoading ? <div className="p-8 text-sm text-panel-muted">Loading accounts...</div> : null}
          {!accounts.isLoading && !(accounts.data?.items ?? []).length ? <div className="p-8 text-sm text-panel-muted">No accounts created yet.</div> : null}
        </div>
      </div>
      <ConfirmModal
        confirmLabel="Delete account"
        message={`This will delete ${deleteTarget?.username ?? "this account"} and unassign linked resources. This action cannot be undone.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget ? deleteAccount.mutate(deleteTarget.id) : undefined}
        open={Boolean(deleteTarget)}
        pending={deleteAccount.isPending}
        title="Delete hosting account?"
      />
    </section>
  );
}

function cleanUsername(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function cleanDomain(value: string) {
  return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "").slice(0, 253);
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function decimalNumber(value: string) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const [head, ...tail] = cleaned.split(".");
  return tail.length > 0 ? `${head}.${tail.join("")}` : head;
}

function mbToGbInput(value: number) {
  const gb = value / 1024;
  return Number.isInteger(gb) ? gb.toString() : gb.toFixed(2).replace(/\.?0+$/, "");
}

function formatDiskGb(value: number | null) {
  if (value == null) return "unlimited";
  return `${mbToGbInput(value)} GB`;
}

function Input({ label, value, onChange, type = "text", placeholder }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string }) {
  return (
    <label className="block space-y-1 text-xs font-medium text-panel-muted">
      <span>{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} value={value} />
    </label>
  );
}
