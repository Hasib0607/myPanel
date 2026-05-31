"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Package, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";

type HostingPackage = {
  id: string;
  name: string;
  description: string | null;
  diskLimitMb: number | null;
  domainLimit: number | null;
  mailboxLimit: number | null;
  databaseLimit: number | null;
  deploymentLimit: number | null;
  isDefault: boolean;
  _count?: { accounts: number };
};

const initialDraft = {
  name: "",
  description: "",
  diskLimitMb: "10240",
  domainLimit: "5",
  mailboxLimit: "10",
  databaseLimit: "3",
  deploymentLimit: "5",
  isDefault: false
};

export function PackagesClient() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initialDraft);
  const [notice, setNotice] = useState("");
  const packages = useQuery({
    queryKey: ["packages"],
    queryFn: () => apiGet<{ items: HostingPackage[] }>("/packages")
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["packages"] });
  const createPackage = useMutation({
    mutationFn: () => apiPost<HostingPackage>("/packages", payload(draft)),
    onSuccess: async () => {
      setDraft(initialDraft);
      setNotice("Package created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create package.")
  });
  const deletePackage = useMutation({
    mutationFn: (id: string) => apiDelete(`/packages/${id}`),
    onSuccess: async () => {
      setNotice("Package deleted.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete package.")
  });

  return (
    <section className="grid grid-cols-[360px_1fr] gap-6 p-8">
      <div className="rounded-md border border-panel-line bg-white">
        <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Create Package</div>
        <div className="space-y-3 p-4">
          <Input label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <Input label="Description" value={draft.description} onChange={(description) => setDraft({ ...draft, description })} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Disk MB" value={draft.diskLimitMb} onChange={(diskLimitMb) => setDraft({ ...draft, diskLimitMb: digitsOnly(diskLimitMb) })} />
            <Input label="Domains" value={draft.domainLimit} onChange={(domainLimit) => setDraft({ ...draft, domainLimit: digitsOnly(domainLimit) })} />
            <Input label="Mailboxes" value={draft.mailboxLimit} onChange={(mailboxLimit) => setDraft({ ...draft, mailboxLimit: digitsOnly(mailboxLimit) })} />
            <Input label="Databases" value={draft.databaseLimit} onChange={(databaseLimit) => setDraft({ ...draft, databaseLimit: digitsOnly(databaseLimit) })} />
            <Input label="Deployments" value={draft.deploymentLimit} onChange={(deploymentLimit) => setDraft({ ...draft, deploymentLimit: digitsOnly(deploymentLimit) })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} type="checkbox" />
            Default package
          </label>
          <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.name || createPackage.isPending} onClick={() => createPackage.mutate()} type="button">
            <Plus size={15} />
            Create Package
          </button>
          {notice ? <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-sm text-slate-700">{notice}</div> : null}
        </div>
      </div>

      <div className="rounded-md border border-panel-line bg-white">
        <div className="flex items-center justify-between border-b border-panel-line px-4 py-3">
          <div className="text-sm font-semibold">Hosting Packages</div>
          <button className="rounded-md border border-panel-line p-2 hover:bg-slate-50" onClick={() => refresh()} type="button" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
        <div className="divide-y divide-panel-line">
          {(packages.data?.items ?? []).map((item) => (
            <div className="grid grid-cols-[1fr_auto] gap-4 px-4 py-3" key={item.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Package size={16} />
                  <span className="font-semibold">{item.name}</span>
                  {item.isDefault ? <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">default</span> : null}
                </div>
                <div className="mt-1 text-sm text-panel-muted">{item.description || "No description"}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-panel-muted">
                  <span>{item.diskLimitMb ?? "unlimited"} MB</span>
                  <span>{item.domainLimit ?? "unlimited"} domains</span>
                  <span>{item.mailboxLimit ?? "unlimited"} mailboxes</span>
                  <span>{item.databaseLimit ?? "unlimited"} DBs</span>
                  <span>{item.deploymentLimit ?? "unlimited"} deployments</span>
                  <span>{item._count?.accounts ?? 0} accounts</span>
                </div>
              </div>
              <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deletePackage.mutate(item.id)} type="button" title="Delete">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {packages.isLoading ? <div className="p-8 text-sm text-panel-muted">Loading packages...</div> : null}
          {!packages.isLoading && !(packages.data?.items ?? []).length ? <div className="p-8 text-sm text-panel-muted">No packages created yet.</div> : null}
        </div>
      </div>
    </section>
  );
}

function payload(draft: typeof initialDraft) {
  return {
    name: draft.name,
    description: draft.description || null,
    diskLimitMb: numberOrNull(draft.diskLimitMb),
    domainLimit: numberOrNull(draft.domainLimit),
    mailboxLimit: numberOrNull(draft.mailboxLimit),
    databaseLimit: numberOrNull(draft.databaseLimit),
    deploymentLimit: numberOrNull(draft.deploymentLimit),
    isDefault: draft.isDefault
  };
}

function numberOrNull(value: string) {
  return value ? Number(value) : null;
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1 text-xs font-medium text-panel-muted">
      <span>{label}</span>
      <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}
