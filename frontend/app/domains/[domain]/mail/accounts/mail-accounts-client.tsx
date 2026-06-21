"use client";

import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

type DomainDetail = {
  id: string;
  name: string;
  mailAccounts: Array<{ id: string; username: string; quotaMb: number; enabled: boolean }>;
};

type Alias = {
  id: string;
  source: string;
  target: string;
};

type AuthStatus = {
  domain: string;
  mailboxCount: number;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};

export function MailAccountsClient({ domainId }: { domainId: string }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [aliasSource, setAliasSource] = useState("");
  const [aliasTarget, setAliasTarget] = useState("");
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const domain = useQuery({ queryKey: ["domain", domainId], queryFn: () => apiGet<DomainDetail>(`/domains/${domainId}`) });
  const aliases = useQuery({ queryKey: ["mail-aliases", domainId], queryFn: () => apiGet<Alias[]>(`/mail/aliases?domainId=${domainId}`) });
  const authStatus = useQuery({ queryKey: ["mail-auth-status", domainId], queryFn: () => apiGet<AuthStatus>(`/mail/domains/${domainId}/auth-status`) });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["domain", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-aliases", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-auth-status", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const create = useMutation({
    mutationFn: () => apiPost("/mail/accounts", { domainId, username, password, quotaMb: 1024 }),
    onSuccess: async () => {
      setUsername("");
      setPassword("");
      await invalidate();
    }
  });
  const updateAccount = useMutation({
    mutationFn: ({ id, quotaMb, enabled }: { id: string; quotaMb?: number; enabled?: boolean }) => apiPatch(`/mail/accounts/${id}`, { quotaMb, enabled }),
    onSuccess: invalidate
  });
  const resetPassword = useMutation({
    mutationFn: ({ id, password: newPassword }: { id: string; password: string }) => apiPost(`/mail/accounts/${id}/reset-password`, { password: newPassword }),
    onSuccess: async (_data, vars) => {
      setResetPasswords((current) => ({ ...current, [vars.id]: "" }));
      await invalidate();
    }
  });
  const deleteAccount = useMutation({
    mutationFn: (id: string) => apiDelete(`/mail/accounts/${id}`),
    onSuccess: invalidate
  });
  const createAlias = useMutation({
    mutationFn: () => apiPost("/mail/aliases", { domainId, source: aliasSource, target: aliasTarget }),
    onSuccess: async () => {
      setAliasSource("");
      setAliasTarget("");
      await invalidate();
    }
  });
  const deleteAlias = useMutation({
    mutationFn: (id: string) => apiDelete(`/mail/aliases/${id}`),
    onSuccess: invalidate
  });
  const setupDkim = useMutation({
    mutationFn: () => apiPost(`/mail/domains/${domainId}/dkim/setup`, {}),
    onSuccess: invalidate
  });
  const reloadMail = useMutation({
    mutationFn: () => apiPost("/mail/services/reload", {})
  });

  const copyText = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  const smtpSettings = (address: string) => [
    `SMTP host: mail.${domain.data?.name ?? ""}`,
    "SMTP port: 587 (STARTTLS, recommended)",
    "Alternative: 465 (SSL/TLS)",
    `Username: ${address}`,
    "Password: mailbox password"
  ].join("\n");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }

  function submitAlias(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createAlias.mutate();
  }

  return (
    <>
      <PageHeader
        title={`${domain.data?.name ?? "Domain"} Mail Accounts`}
        description="Create mailboxes, reset passwords, quotas, aliases, and catch-all routing."
        action={
          <form className="flex gap-2" onSubmit={submit}>
            <input className="h-10 w-40 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setUsername(event.target.value)} placeholder="info" value={username} />
            <input className="h-10 w-56 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setPassword(event.target.value)} placeholder="strong password" type="password" value={password} />
            <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" disabled={!username || password.length < 10} type="submit"><Plus size={16} /> Add</button>
          </form>
        }
      />
      <section className="p-8">
        {notice ? <div className="mb-4 rounded-md border border-panel-line bg-white p-3 text-sm text-slate-700">{notice}</div> : null}
        <div className="mb-6 rounded-md border border-panel-line bg-white p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Mail Authentication</div>
              <div className="text-sm text-panel-muted">SPF, DKIM, DMARC, and PTR posture for this domain.</div>
            </div>
            <div className="flex gap-2">
              <button className="rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50" onClick={() => setupDkim.mutate()} type="button">Setup DKIM</button>
              <button className="rounded-md border border-panel-line px-3 py-2 text-sm font-semibold hover:bg-slate-50" onClick={() => reloadMail.mutate()} type="button">Reload Mail</button>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-3">
            {(authStatus.data?.checks ?? []).map((check) => (
              <div key={check.key} className="rounded-md border border-panel-line p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  {check.ok ? <CheckCircle2 className="text-emerald-600" size={16} /> : <CircleAlert className="text-panel-warn" size={16} />}
                  {check.label}
                </div>
                <div className="mt-2 text-xs text-panel-muted">{check.detail}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-6 rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Mailboxes</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr><th className="px-4 py-3">Mailbox</th><th className="px-4 py-3">Quota</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Password</th><th className="px-4 py-3">Actions</th></tr>
            </thead>
            <tbody>
              {(domain.data?.mailAccounts ?? []).map((account) => {
                const address = `${account.username}@${domain.data?.name}`;
                return (
                <tr key={account.id} className="border-t border-panel-line">
                  <td className="px-4 py-3">
                    <div className="font-medium">{address}</div>
                    <button className="mt-1 flex items-center gap-1 text-xs text-panel-accent hover:underline" onClick={() => copyText(smtpSettings(address), "SMTP settings copied.")} type="button">
                      <Copy size={12} />
                      Copy SMTP
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <input className="h-9 w-28 rounded-md border border-panel-line px-2" min={128} onBlur={(event) => updateAccount.mutate({ id: account.id, quotaMb: Number(event.target.value) })} type="number" defaultValue={account.quotaMb} /> MB
                  </td>
                  <td className="px-4 py-3">
                    <button className={`rounded-md px-3 py-1 text-xs font-semibold ${account.enabled ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-panel-danger"}`} onClick={() => updateAccount.mutate({ id: account.id, enabled: !account.enabled })} type="button">
                      {account.enabled ? "enabled" : "disabled"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <input className="h-9 w-44 rounded-md border border-panel-line px-2" onChange={(event) => setResetPasswords((current) => ({ ...current, [account.id]: event.target.value }))} placeholder="new password" type="password" value={resetPasswords[account.id] ?? ""} />
                      <button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50" disabled={(resetPasswords[account.id] ?? "").length < 10} onClick={() => resetPassword.mutate({ id: account.id, password: resetPasswords[account.id] })} type="button"><KeyRound size={15} /></button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50" onClick={() => deleteAccount.mutate(account.id)} type="button"><Trash2 size={15} /></button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Aliases</div>
          <form className="grid grid-cols-[1fr_1fr_100px] gap-2 border-b border-panel-line p-3" onSubmit={submitAlias}>
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setAliasSource(event.target.value)} placeholder="support or *" value={aliasSource} />
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setAliasTarget(event.target.value)} placeholder="info@example.com" value={aliasTarget} />
            <button className="h-10 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" disabled={!aliasSource || !aliasTarget} type="submit">Add</button>
          </form>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr><th className="px-4 py-3">Source</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">Actions</th></tr>
            </thead>
            <tbody>
              {(aliases.data ?? []).map((alias) => (
                <tr key={alias.id} className="border-t border-panel-line">
                  <td className="px-4 py-3 font-medium">{alias.source}@{domain.data?.name}</td>
                  <td className="px-4 py-3">{alias.target}</td>
                  <td className="px-4 py-3"><button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50" onClick={() => deleteAlias.mutate(alias.id)} type="button"><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
