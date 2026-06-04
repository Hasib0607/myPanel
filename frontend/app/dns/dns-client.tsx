"use client";

import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Lock, Plus, Search, Settings, Wrench } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DnsZoneEditor } from "@/components/dns-zone-editor";
import { apiGet } from "@/lib/api";

type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA";

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

const pageSize = 100;

export function DnsClient() {
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null);
  const [initialType, setInitialType] = useState<DnsRecordType>("A");

  const domains = useQuery({
    queryKey: ["domains", "dns-zone-editor", submittedSearch, page],
    queryFn: () => apiGet<DomainListResponse>(`/domains?page=${page}&pageSize=${pageSize}${submittedSearch ? `&search=${encodeURIComponent(submittedSearch)}` : ""}`)
  });

  const total = domains.data?.total ?? 0;
  const items = domains.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);
  const selectedName = useMemo(() => selectedDomain?.name ?? "", [selectedDomain]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedSearch(search.trim());
    setPage(1);
    setSelectedDomain(null);
  }

  function openEditor(domain: Domain, type: DnsRecordType = "A") {
    setSelectedDomain(domain);
    setInitialType(type);
  }

  return (
    <AppShell>
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

        <div className="overflow-hidden border-t-2 border-slate-700">
          <table className="w-full border-collapse text-left text-base">
            <thead>
              <tr className="border-b-2 border-slate-700 bg-white text-slate-700">
                <th className="w-[28%] px-3 py-4 font-semibold text-blue-500">Domain <span className="inline-block align-middle text-blue-500">^</span></th>
                <th className="px-3 py-4 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {domains.isLoading ? (
                <tr><td className="bg-slate-50 px-3 py-6 text-slate-500" colSpan={2}>Loading domains...</td></tr>
              ) : items.length === 0 ? (
                <tr><td className="bg-slate-50 px-3 py-6 text-slate-500" colSpan={2}>No domains found.</td></tr>
              ) : items.map((domain) => (
                <tr key={domain.id} className="border-b border-slate-200 bg-slate-50 even:bg-slate-100">
                  <td className="px-3 py-4 text-slate-800">{domain.name}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-3">
                      <ActionButton onClick={() => openEditor(domain, "A")}><Plus size={17} /> A Record</ActionButton>
                      <ActionButton onClick={() => openEditor(domain, "CNAME")}><Plus size={17} /> CNAME Record</ActionButton>
                      <ActionButton onClick={() => openEditor(domain, "MX")}><Plus size={17} /> MX Record</ActionButton>
                      <ActionButton disabled><Lock size={16} /> DNSSEC</ActionButton>
                      <ActionButton onClick={() => openEditor(domain)}><Wrench size={17} /> Manage</ActionButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedDomain ? (
          <div className="overflow-hidden rounded-md border border-panel-line bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-5 py-4">
              <div>
                <div className="text-lg font-semibold text-panel-ink">Manage DNS records</div>
                <div className="text-sm text-panel-muted">{selectedName}</div>
              </div>
              <button className="h-9 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => setSelectedDomain(null)} type="button">Close editor</button>
            </div>
            <DnsZoneEditor domainId={selectedDomain.id} initialType={initialType} />
          </div>
        ) : null}
      </section>
    </AppShell>
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
