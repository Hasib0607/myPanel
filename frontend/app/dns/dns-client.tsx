"use client";

import Link from "next/link";
import { type FormEvent, type ReactNode, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Lock, Plus, Search, Settings, Wrench } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { apiGet, apiPost } from "@/lib/api";

type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA";
const dnsTypes: DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"];

type Domain = {
  id: string;
  name: string;
};

type DomainListResponse = {
  items: Domain[];
  total: number;
  page: number;
  pageSize: number;
};

type BulkZoneAction = "add" | "edit" | "delete";

type BulkZoneActionResponse = {
  ok: boolean;
  action: BulkZoneAction;
  affected: number;
};

type BulkZoneDraft = {
  action: BulkZoneAction;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: string;
  priority: string;
  matchType: DnsRecordType;
  matchName: string;
};

const pageSize = 100;

export function DnsClient() {
  return (
    <AppShell>
      <DnsZonePageContent />
    </AppShell>
  );
}

export function DnsZonePageContent({
  domainsApiBase = "/domains",
  manageBase = "/domains",
  bulkZoneActionPath = "/dns/bulk-zone-action"
}: {
  domainsApiBase?: string;
  manageBase?: string;
  bulkZoneActionPath?: string;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedDomainIds, setSelectedDomainIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [bulkDraft, setBulkDraft] = useState<BulkZoneDraft>({
    action: "add",
    type: "A",
    name: "@",
    value: "",
    ttl: "3600",
    priority: "",
    matchType: "A",
    matchName: "@"
  });

  const domains = useQuery({
    queryKey: [domainsApiBase, "dns-zone-editor", submittedSearch, page],
    queryFn: () => apiGet<DomainListResponse>(`${domainsApiBase}?page=${page}&pageSize=${pageSize}${submittedSearch ? `&search=${encodeURIComponent(submittedSearch)}` : ""}`)
  });

  const total = domains.data?.total ?? 0;
  const items = domains.data?.items ?? [];
  const visibleDomainIds = items.map((domain) => domain.id);
  const visibleSelectedCount = visibleDomainIds.filter((id) => selectedDomainIds.includes(id)).length;
  const allVisibleSelected = visibleDomainIds.length > 0 && visibleSelectedCount === visibleDomainIds.length;
  const selectedCount = selectedDomainIds.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedSearch(search.trim());
    setPage(1);
  }

  const bulkZoneAction = useMutation({
    mutationFn: () => {
      const ttl = Number(bulkDraft.ttl || 3600);
      const priority = bulkDraft.priority.trim() ? Number(bulkDraft.priority) : null;
      const record = {
        type: bulkDraft.type,
        name: bulkDraft.name.trim() || "@",
        value: bulkDraft.value.trim(),
        ttl,
        priority
      };
      const match = {
        type: bulkDraft.matchType,
        name: bulkDraft.matchName.trim() || "@"
      };
      const patch = {
        type: bulkDraft.type,
        name: bulkDraft.name.trim() || "@",
        value: bulkDraft.value.trim(),
        ttl,
        priority
      };

      return apiPost<BulkZoneActionResponse>(bulkZoneActionPath, {
        domainIds: selectedDomainIds,
        action: bulkDraft.action,
        ...(bulkDraft.action === "add" ? { record } : {}),
        ...(bulkDraft.action === "edit" ? { match, patch } : {}),
        ...(bulkDraft.action === "delete" ? { match } : {})
      });
    },
    onSuccess: async (response) => {
      setError("");
      setNotice(`${response.affected} DNS record${response.affected === 1 ? "" : "s"} ${response.action === "add" ? "added" : response.action === "edit" ? "updated" : "deleted"} across selected zone${selectedCount === 1 ? "" : "s"}.`);
      setSelectedDomainIds([]);
      setBulkDraft((draft) => ({ ...draft, value: "", priority: "" }));
      await queryClient.invalidateQueries({ queryKey: [domainsApiBase, "dns-zone-editor"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not apply bulk DNS action")
  });

  function toggleDomainSelection(domainId: string) {
    setSelectedDomainIds((current) =>
      current.includes(domainId)
        ? current.filter((id) => id !== domainId)
        : [...current, domainId]
    );
  }

  function toggleVisibleSelection() {
    setSelectedDomainIds((current) => {
      if (allVisibleSelected) return current.filter((id) => !visibleDomainIds.includes(id));
      return [...new Set([...current, ...visibleDomainIds])];
    });
  }

  function submitBulkZoneAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    setError("");
    if (selectedDomainIds.length === 0) {
      setError("Select at least one zone first.");
      return;
    }
    if ((bulkDraft.action === "add" || bulkDraft.action === "edit") && !bulkDraft.value.trim()) {
      setError("Record value is required.");
      return;
    }
    bulkZoneAction.mutate();
  }

  return (
    <section className="space-y-8 p-8">
        <div>
          <h1 className="text-4xl font-light text-slate-800">Zone Editor</h1>
          <div className="mt-1 text-sm text-slate-600">Domains</div>
          <p className="mt-8 max-w-5xl text-base text-slate-700">
            DNS converts domain names into computer-readable IP addresses. Use this feature to manage DNS zones. For more information, read the{" "}
            <a className="text-blue-500 underline" href="https://docs.cpanel.net/cpanel/domains/zone-editor/" rel="noreferrer" target="_blank">documentation</a>.
          </p>
        </div>

        <div>
          <h2 className="text-3xl font-semibold text-slate-800">Domains</h2>
          <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
            <form className="flex w-full max-w-xl" onSubmit={submitSearch}>
              <input
                className="h-11 min-w-0 flex-1 border border-blue-400 px-4 text-base outline-none ring-1 ring-blue-100 focus:ring-2 focus:ring-blue-200"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Filter by domain"
                value={search}
              />
              <button className="flex h-11 w-14 items-center justify-center border border-l-0 border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200" type="submit">
                <Search size={21} />
              </button>
            </form>

            <div className="flex flex-col items-end gap-3 text-sm text-slate-700">
              <div className="flex rounded-sm border border-slate-300 bg-white">
                <PagerButton disabled={page <= 1 || domains.isFetching} label="First" onClick={() => setPage(1)}><ChevronsLeft size={17} /></PagerButton>
                <PagerButton disabled={page <= 1 || domains.isFetching} label="Previous" onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={17} /></PagerButton>
                <PagerButton disabled={page >= totalPages || domains.isFetching} label="Next" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={17} /></PagerButton>
                <PagerButton disabled={page >= totalPages || domains.isFetching} label="Last" onClick={() => setPage(totalPages)}><ChevronsRight size={17} /></PagerButton>
              </div>
              <div>Displaying {firstItem} to {lastItem} out of {total} items</div>
              <button className="flex h-10 items-center gap-2 rounded-sm border border-slate-300 bg-slate-100 px-4 text-slate-700 shadow-sm hover:bg-slate-200" type="button">
                <Settings size={16} />
                <span className="text-xs">v</span>
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : null}
        {notice ? (
          <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>
        ) : null}

        {selectedCount > 0 ? (
          <form className="grid gap-3 rounded-sm border border-slate-300 bg-white p-4 xl:grid-cols-[auto_auto_auto_auto_auto_auto]" onSubmit={submitBulkZoneAction}>
            <div className="flex items-center text-sm font-semibold text-slate-700">{selectedCount} selected</div>
            <select
              className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
              onChange={(event) => setBulkDraft((draft) => ({ ...draft, action: event.target.value as BulkZoneAction }))}
              value={bulkDraft.action}
            >
              <option value="add">Bulk add zone</option>
              <option value="edit">Bulk edit zone</option>
              <option value="delete">Bulk delete zone</option>
            </select>
            {bulkDraft.action !== "add" ? (
              <>
                <select
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, matchType: event.target.value as DnsRecordType }))}
                  value={bulkDraft.matchType}
                >
                  {dnsTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <input
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, matchName: event.target.value }))}
                  placeholder="Match name"
                  value={bulkDraft.matchName}
                />
              </>
            ) : null}
            {bulkDraft.action !== "delete" ? (
              <>
                <select
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, type: event.target.value as DnsRecordType }))}
                  value={bulkDraft.type}
                >
                  {dnsTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <input
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, name: event.target.value }))}
                  placeholder="Name"
                  value={bulkDraft.name}
                />
                <input
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, value: event.target.value }))}
                  placeholder="Record value"
                  value={bulkDraft.value}
                />
                <input
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, ttl: event.target.value }))}
                  placeholder="TTL"
                  type="number"
                  value={bulkDraft.ttl}
                />
                <input
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                  onChange={(event) => setBulkDraft((draft) => ({ ...draft, priority: event.target.value }))}
                  placeholder="Priority"
                  type="number"
                  value={bulkDraft.priority}
                />
              </>
            ) : null}
            <button className="h-10 rounded-sm bg-blue-500 px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={bulkZoneAction.isPending} type="submit">
              Apply
            </button>
            <button className="h-10 rounded-sm border border-slate-300 px-4 text-sm" onClick={() => setSelectedDomainIds([])} type="button">
              Clear
            </button>
          </form>
        ) : null}

        <div className="overflow-hidden border-t-2 border-slate-700">
          <table className="w-full border-collapse text-left text-base">
            <thead>
              <tr className="border-b-2 border-slate-700 bg-white text-slate-700">
                <th className="w-12 px-3 py-4">
                  <input
                    aria-label="Select visible zones"
                    checked={allVisibleSelected}
                    disabled={visibleDomainIds.length === 0}
                    onChange={toggleVisibleSelection}
                    type="checkbox"
                  />
                </th>
                <th className="w-[28%] px-3 py-4 font-semibold text-blue-500">Domain <span className="inline-block align-middle text-blue-500">^</span></th>
                <th className="px-3 py-4 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {domains.isLoading ? (
                <tr><td className="bg-slate-50 px-3 py-6 text-slate-500" colSpan={3}>Loading domains...</td></tr>
              ) : items.length === 0 ? (
                <tr><td className="bg-slate-50 px-3 py-6 text-slate-500" colSpan={3}>No domains found.</td></tr>
              ) : items.map((domain) => (
                <tr key={domain.id} className="border-b border-slate-200 bg-slate-50 even:bg-slate-100">
                  <td className="px-3 py-4">
                    <input
                      aria-label={`Select ${domain.name}`}
                      checked={selectedDomainIds.includes(domain.id)}
                      onChange={() => toggleDomainSelection(domain.id)}
                      type="checkbox"
                    />
                  </td>
                  <td className="px-3 py-4 text-slate-800">{domain.name}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-3">
                      <ActionLink href={`${manageBase}/${domain.id}/dns?type=A`}><Plus size={17} /> A Record</ActionLink>
                      <ActionLink href={`${manageBase}/${domain.id}/dns?type=CNAME`}><Plus size={17} /> CNAME Record</ActionLink>
                      <ActionLink href={`${manageBase}/${domain.id}/dns?type=MX`}><Plus size={17} /> MX Record</ActionLink>
                      <ActionButton disabled><Lock size={16} /> DNSSEC</ActionButton>
                      <ActionLink href={`${manageBase}/${domain.id}/dns`}><Wrench size={17} /> Manage</ActionLink>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </section>
  );
}

function ActionLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <Link
      className="inline-flex h-10 items-center gap-1.5 rounded-sm border-2 border-blue-500 bg-white px-3 text-sm font-semibold text-blue-500 hover:bg-blue-50"
      href={href}
    >
      {children}
    </Link>
  );
}

function ActionButton({ children, disabled = false, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      className="inline-flex h-10 items-center gap-1.5 rounded-sm border-2 border-blue-500 bg-white px-3 text-sm font-semibold text-blue-500 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function PagerButton({ children, disabled, label, onClick }: { children: ReactNode; disabled: boolean; label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      className="flex h-11 w-12 items-center justify-center border-r border-slate-300 text-blue-500 last:border-r-0 hover:bg-slate-50 disabled:text-slate-400"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
