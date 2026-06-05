"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { KeyRound, Link2, RefreshCw, Save, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

type AccountDetail = {
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
  usage: { domains: number; deployments: number; mailAccounts: number; databases: number };
  domains: Array<{ id: string; name: string; status: string }>;
  deployments: Array<{ id: string; name: string; slug: string; status: string }>;
  mailAccounts: Array<{ id: string; username: string; domainId: string }>;
  activity: Array<{ id: string; action: string; resource: string; description: string | null; createdAt: string }>;
};
type Assignable = {
  domains: Array<{ id: string; name: string }>;
  deployments: Array<{ id: string; name: string; slug: string }>;
  mailAccounts: Array<{ id: string; username: string; domain?: { name: string } }>;
};

export function AccountDetailClient({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const [limits, setLimits] = useState({ diskLimitMb: "", domainLimit: "", mailboxLimit: "", databaseLimit: "", deploymentLimit: "" });
  const [passwordDraft, setPasswordDraft] = useState({ password: "", confirmPassword: "" });
  const account = useQuery({
    queryKey: ["account", accountId],
    queryFn: async () => {
      const data = await apiGet<AccountDetail>(`/accounts/${accountId}`);
      setLimits({
        diskLimitMb: data.diskLimitMb?.toString() ?? "",
        domainLimit: data.domainLimit?.toString() ?? "",
        mailboxLimit: data.mailboxLimit?.toString() ?? "",
        databaseLimit: data.databaseLimit?.toString() ?? "",
        deploymentLimit: data.deploymentLimit?.toString() ?? ""
      });
      return data;
    }
  });
  const assignable = useQuery({
    queryKey: ["account-assignable", accountId],
    queryFn: () => apiGet<Assignable>(`/accounts/${accountId}/assignable`)
  });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["account", accountId] }),
    queryClient.invalidateQueries({ queryKey: ["account-assignable", accountId] })
  ]);

  const updateLimits = useMutation({
    mutationFn: () => apiPatch(`/accounts/${accountId}`, {
      diskLimitMb: numberOrNull(limits.diskLimitMb),
      domainLimit: numberOrNull(limits.domainLimit),
      mailboxLimit: numberOrNull(limits.mailboxLimit),
      databaseLimit: numberOrNull(limits.databaseLimit),
      deploymentLimit: numberOrNull(limits.deploymentLimit)
    }),
    onSuccess: async () => {
      setNotice("Package limits updated.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update limits.")
  });
  const assign = useMutation({
    mutationFn: ({ resourceType, resourceId }: { resourceType: string; resourceId: string }) => apiPost(`/accounts/${accountId}/assign`, { resourceType, resourceId }),
    onSuccess: async () => {
      setNotice("Resource assigned.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not assign resource.")
  });
  const unassign = useMutation({
    mutationFn: ({ resourceType, resourceId }: { resourceType: string; resourceId: string }) => apiPost(`/accounts/${accountId}/unassign`, { resourceType, resourceId }),
    onSuccess: async () => {
      setNotice("Resource unassigned.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not unassign resource.")
  });
  const passwordMismatch = Boolean(passwordDraft.password || passwordDraft.confirmPassword) && passwordDraft.password !== passwordDraft.confirmPassword;
  const changePassword = useMutation({
    mutationFn: () => apiPost<{ username: string }>(`/accounts/${accountId}/password`, { password: passwordDraft.password }),
    onSuccess: (result) => {
      setPasswordDraft({ password: "", confirmPassword: "" });
      setNotice(`Password changed for ${result.username}.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not change password.")
  });

  const data = account.data;

  return (
    <section className="space-y-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{data?.username ?? "Account"}</h1>
          <p className="mt-1 text-sm text-panel-muted">{data?.email ?? "No email"} · {data?.homeRoot ?? ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link className="flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" href={`/accounts/${accountId}/terminal`}>
            <SquareTerminal size={15} />
            Terminal
          </Link>
          <button className="flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => refresh()} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
      </div>
      {notice ? <div className="rounded-md border border-panel-line bg-white p-3 text-sm text-slate-700">{notice}</div> : null}

      <div className="grid grid-cols-[360px_1fr] gap-6">
        <div className="space-y-6">
          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Package Limits</div>
            <div className="grid grid-cols-2 gap-3 p-4">
              {Object.entries(limits).map(([key, value]) => (
                <label className="space-y-1 text-xs font-medium text-panel-muted" key={key}>
                  <span>{key.replace("Limit", "").replace("Mb", " MB")}</span>
                  <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setLimits({ ...limits, [key]: event.target.value.replace(/\D/g, "") })} value={value} />
                </label>
              ))}
              <button className="col-span-2 flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white" onClick={() => updateLimits.mutate()} type="button">
                <Save size={15} />
                Save Limits
              </button>
            </div>
          </div>

          <div className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Change Password</div>
            <div className="space-y-3 p-4">
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>New password</span>
                <input
                  className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink"
                  onChange={(event) => setPasswordDraft({ ...passwordDraft, password: event.target.value })}
                  type="password"
                  value={passwordDraft.password}
                />
              </label>
              <label className="block space-y-1 text-xs font-medium text-panel-muted">
                <span>Confirm password</span>
                <input
                  className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink"
                  onChange={(event) => setPasswordDraft({ ...passwordDraft, confirmPassword: event.target.value })}
                  type="password"
                  value={passwordDraft.confirmPassword}
                />
              </label>
              {passwordMismatch ? <div className="text-xs font-medium text-panel-danger">Passwords do not match.</div> : null}
              <button
                className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={passwordDraft.password.length < 10 || passwordMismatch || changePassword.isPending}
                onClick={() => changePassword.mutate()}
                type="button"
              >
                <KeyRound size={15} />
                Change Password
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Usage</div>
          <div className="grid grid-cols-4 gap-3 p-4">
            <Metric label="Domains" value={data?.usage.domains} limit={data?.domainLimit} />
            <Metric label="Mailboxes" value={data?.usage.mailAccounts} limit={data?.mailboxLimit} />
            <Metric label="Deployments" value={data?.usage.deployments} limit={data?.deploymentLimit} />
            <Metric label="Databases" value={data?.usage.databases} limit={data?.databaseLimit} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <ResourcePanel title="Domains" items={data?.domains.map((item) => ({ id: item.id, label: item.name, detail: item.status })) ?? []} onUnassign={(id) => unassign.mutate({ resourceType: "domain", resourceId: id })} />
        <ResourcePanel title="Deployments" items={data?.deployments.map((item) => ({ id: item.id, label: item.name, detail: item.slug })) ?? []} onUnassign={(id) => unassign.mutate({ resourceType: "deployment", resourceId: id })} />
        <ResourcePanel title="Mailboxes" items={data?.mailAccounts.map((item) => ({ id: item.id, label: item.username, detail: item.domainId })) ?? []} onUnassign={(id) => unassign.mutate({ resourceType: "mailAccount", resourceId: id })} />
      </div>

      <div className="rounded-md border border-panel-line bg-white">
        <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Assign Existing Resource</div>
        <div className="grid grid-cols-3 gap-4 p-4">
          <AssignableList title="Domains" items={assignable.data?.domains.map((item) => ({ id: item.id, label: item.name })) ?? []} onAssign={(id) => assign.mutate({ resourceType: "domain", resourceId: id })} />
          <AssignableList title="Deployments" items={assignable.data?.deployments.map((item) => ({ id: item.id, label: item.name })) ?? []} onAssign={(id) => assign.mutate({ resourceType: "deployment", resourceId: id })} />
          <AssignableList title="Mailboxes" items={assignable.data?.mailAccounts.map((item) => ({ id: item.id, label: `${item.username}@${item.domain?.name ?? ""}` })) ?? []} onAssign={(id) => assign.mutate({ resourceType: "mailAccount", resourceId: id })} />
        </div>
      </div>

      <div className="rounded-md border border-panel-line bg-white">
        <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Activity</div>
        <div className="divide-y divide-panel-line">
          {(data?.activity ?? []).map((item) => (
            <div className="px-4 py-3 text-sm" key={item.id}>
              <div className="font-medium">{item.description ?? `${item.action} ${item.resource}`}</div>
              <div className="text-xs text-panel-muted">{new Date(item.createdAt).toLocaleString()}</div>
            </div>
          ))}
          {data && !data.activity.length ? <div className="p-4 text-sm text-panel-muted">No activity yet.</div> : null}
        </div>
      </div>
    </section>
  );
}

function numberOrNull(value: string) {
  return value ? Number(value) : null;
}

function Metric({ label, value, limit }: { label: string; value?: number; limit?: number | null }) {
  return (
    <div className="rounded-md border border-panel-line bg-slate-50 p-3">
      <div className="text-xs text-panel-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value ?? "..."}</div>
      <div className="text-xs text-panel-muted">Limit {limit ?? "unlimited"}</div>
    </div>
  );
}

function ResourcePanel({ title, items, onUnassign }: { title: string; items: Array<{ id: string; label: string; detail: string }>; onUnassign: (id: string) => void }) {
  return (
    <div className="rounded-md border border-panel-line bg-white">
      <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">{title}</div>
      <div className="divide-y divide-panel-line">
        {items.map((item) => (
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm" key={item.id}>
            <div className="min-w-0">
              <div className="truncate font-medium">{item.label}</div>
              <div className="truncate text-xs text-panel-muted">{item.detail}</div>
            </div>
            <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => onUnassign(item.id)} type="button">Unassign</button>
          </div>
        ))}
        {!items.length ? <div className="p-4 text-sm text-panel-muted">Nothing linked.</div> : null}
      </div>
    </div>
  );
}

function AssignableList({ title, items, onAssign }: { title: string; items: Array<{ id: string; label: string }>; onAssign: (id: string) => void }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-panel-muted">{title}</div>
      <div className="space-y-2">
        {items.map((item) => (
          <button className="flex w-full items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-left text-sm hover:bg-slate-50" key={item.id} onClick={() => onAssign(item.id)} type="button">
            <Link2 size={14} />
            <span className="truncate">{item.label}</span>
          </button>
        ))}
        {!items.length ? <div className="rounded-md border border-dashed border-panel-line p-3 text-sm text-panel-muted">No unassigned items.</div> : null}
      </div>
    </div>
  );
}
