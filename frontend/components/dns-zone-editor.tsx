"use client";

import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, Save, Trash2 } from "lucide-react";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA";

type DnsRecord = {
  id: string;
  domainId: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
  priority: number | null;
};

type ZoneExport = {
  domain: string;
  serial: string;
  zone: string;
};

const recordTypes: DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"];

export function DnsZoneEditor({ domainId }: { domainId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    type: "A" as DnsRecordType,
    name: "@",
    value: "",
    ttl: 3600,
    priority: ""
  });
  const [editing, setEditing] = useState<Record<string, Partial<DnsRecord>>>({});
  const [error, setError] = useState("");

  const records = useQuery({
    queryKey: ["dns-records", domainId],
    queryFn: () => apiGet<DnsRecord[]>(`/dns/${domainId}/records`)
  });

  const zone = useQuery({
    queryKey: ["dns-zone", domainId],
    queryFn: () => apiGet<ZoneExport>(`/dns/${domainId}/zone`)
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["dns-records", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["dns-zone", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["domain", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["domain-health", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const create = useMutation({
    mutationFn: () =>
      apiPost<DnsRecord>("/dns/records", {
        domainId,
        type: draft.type,
        name: draft.name,
        value: draft.value,
        ttl: Number(draft.ttl),
        priority: draft.priority === "" ? null : Number(draft.priority)
      }),
    onSuccess: async () => {
      setDraft({ type: "A", name: "@", value: "", ttl: 3600, priority: "" });
      setError("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not create DNS record")
  });

  const update = useMutation({
    mutationFn: (record: DnsRecord) => {
      const patch = editing[record.id] ?? {};
      return apiPatch<DnsRecord>(`/dns/records/${record.id}`, {
        type: patch.type ?? record.type,
        name: patch.name ?? record.name,
        value: patch.value ?? record.value,
        ttl: Number(patch.ttl ?? record.ttl),
        priority: patch.priority === undefined ? record.priority : patch.priority
      });
    },
    onSuccess: async (_record, original) => {
      setEditing((current) => {
        const next = { ...current };
        delete next[original.id];
        return next;
      });
      setError("");
      await invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update DNS record")
  });

  const remove = useMutation({
    mutationFn: (recordId: string) => apiDelete(`/dns/records/${recordId}`),
    onSuccess: invalidate,
    onError: (err) => setError(err instanceof Error ? err.message : "Could not delete DNS record")
  });

  const renderedRecords = useMemo(() => records.data ?? [], [records.data]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }

  function updateEdit(recordId: string, patch: Partial<DnsRecord>) {
    setEditing((current) => ({ ...current, [recordId]: { ...current[recordId], ...patch } }));
  }

  function downloadZone() {
    if (!zone.data) return;
    const blob = new Blob([zone.data.zone], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${zone.data.domain}.zone`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="grid grid-cols-[1fr_440px] gap-6 p-8">
      <div className="space-y-4">
        <form className="grid grid-cols-[110px_1fr_2fr_110px_110px_100px] gap-2 rounded-md border border-panel-line bg-white p-3" onSubmit={submit}>
          <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as DnsRecordType }))} value={draft.type}>
            {recordTypes.map((type) => <option key={type}>{type}</option>)}
          </select>
          <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="@" value={draft.name} />
          <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} placeholder="Record value" value={draft.value} />
          <input className="h-10 rounded-md border border-panel-line px-3 text-sm" min={60} onChange={(event) => setDraft((current) => ({ ...current, ttl: Number(event.target.value) }))} type="number" value={draft.ttl} />
          <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))} placeholder="Priority" value={draft.priority} />
          <button className="flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white" disabled={!draft.value || create.isPending} type="submit">
            <Plus size={16} />
            Add
          </button>
        </form>

        {error ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-panel-danger">{error}</div> : null}

        <div className="rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Records</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr>
                {["Type", "Name", "Value", "TTL", "Priority", "Actions"].map((head) => <th key={head} className="px-4 py-3">{head}</th>)}
              </tr>
            </thead>
            <tbody>
              {renderedRecords.map((record) => {
                const row = { ...record, ...(editing[record.id] ?? {}) };
                return (
                  <tr key={record.id} className="border-t border-panel-line">
                    <td className="px-3 py-2">
                      <select className="h-9 rounded-md border border-panel-line px-2" onChange={(event) => updateEdit(record.id, { type: event.target.value as DnsRecordType })} value={row.type}>
                        {recordTypes.map((type) => <option key={type}>{type}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2"><input className="h-9 w-24 rounded-md border border-panel-line px-2" onChange={(event) => updateEdit(record.id, { name: event.target.value })} value={row.name} /></td>
                    <td className="px-3 py-2"><input className="h-9 w-full min-w-64 rounded-md border border-panel-line px-2" onChange={(event) => updateEdit(record.id, { value: event.target.value })} value={row.value} /></td>
                    <td className="px-3 py-2"><input className="h-9 w-24 rounded-md border border-panel-line px-2" min={60} onChange={(event) => updateEdit(record.id, { ttl: Number(event.target.value) })} type="number" value={row.ttl} /></td>
                    <td className="px-3 py-2">
                      <input
                        className="h-9 w-24 rounded-md border border-panel-line px-2"
                        onChange={(event) => updateEdit(record.id, { priority: event.target.value === "" ? null : Number(event.target.value) })}
                        value={row.priority ?? ""}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50" onClick={() => update.mutate(record)} title="Save" type="button"><Save size={15} /></button>
                        <button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50" onClick={() => remove.mutate(record.id)} title="Delete" type="button"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-md border border-panel-line bg-slate-950">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-sm text-slate-100">
          <span>Raw Zone {zone.data ? `(${zone.data.serial})` : ""}</span>
          <button className="flex h-8 items-center gap-2 rounded-md border border-slate-700 px-3 text-xs hover:bg-slate-900" onClick={downloadZone} type="button">
            <Download size={14} />
            Export
          </button>
        </div>
        <pre className="max-h-[640px] overflow-auto p-4 font-mono text-xs leading-6 text-slate-100">{zone.data?.zone ?? "Loading zone..."}</pre>
      </div>
    </section>
  );
}
