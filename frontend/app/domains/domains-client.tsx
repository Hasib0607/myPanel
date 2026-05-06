"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eye, Plus, Search, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { apiDeleteBody, apiGet, apiPatch, apiPost } from "@/lib/api";

type DomainStatus = "ACTIVE" | "PENDING" | "SUSPENDED";

type Domain = {
  id: string;
  name: string;
  status: DomainStatus;
  sslEnabled: boolean;
  sslExpiry: string | null;
  forceSsl: boolean;
  createdAt: string;
  _count: {
    subdomains: number;
    dnsRecords: number;
    mailAccounts: number;
  };
};

type DomainListResponse = {
  items: Domain[];
  total: number;
  page: number;
  pageSize: number;
};

function statusClass(status: DomainStatus) {
  if (status === "ACTIVE") return "bg-emerald-50 text-emerald-700";
  if (status === "SUSPENDED") return "bg-red-50 text-panel-danger";
  return "bg-amber-50 text-amber-700";
}

export function DomainsClient() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [forceSsl, setForceSsl] = useState(true);
  const [error, setError] = useState("");

  const queryPath = useMemo(() => {
    const params = new URLSearchParams({ page: "1", pageSize: "50" });
    if (search) params.set("search", search);
    return `/domains?${params.toString()}`;
  }, [search]);

  const domains = useQuery({
    queryKey: ["domains", search],
    queryFn: () => apiGet<DomainListResponse>(queryPath)
  });

  const createDomain = useMutation({
    mutationFn: () => apiPost<Domain>("/domains", { name: newDomain, forceSsl }),
    onSuccess: async () => {
      setNewDomain("");
      setForceSsl(true);
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not add domain")
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DomainStatus }) => apiPatch(`/domains/${id}/status`, { status }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }
  });

  const deleteDomain = useMutation({
    mutationFn: (domain: Domain) => apiDeleteBody(`/domains/${domain.id}`, { confirmName: domain.name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not delete domain")
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  function submitNewDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createDomain.mutate();
  }

  return (
    <>
      <PageHeader
        title="Domains"
        description="Manage root domains, subdomains, SSL, and default records for high-volume hosting."
        action={
          <form className="flex items-center gap-2" onSubmit={submitNewDomain}>
            <input
              className="h-10 w-64 rounded-md border border-panel-line px-3 text-sm"
              onChange={(event) => setNewDomain(event.target.value)}
              placeholder="example.com"
              value={newDomain}
            />
            <label className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm">
              <input checked={forceSsl} onChange={(event) => setForceSsl(event.target.checked)} type="checkbox" />
              Force SSL
            </label>
            <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={!newDomain || createDomain.isPending} type="submit">
              <Plus size={16} />
              Add
            </button>
          </form>
        }
      />
      <section className="p-8">
        <form className="mb-4 flex gap-3" onSubmit={submitSearch}>
          <div className="relative">
            <Search className="absolute left-3 top-3 text-panel-muted" size={16} />
            <input
              className="h-10 w-80 rounded-md border border-panel-line pl-9 pr-3 text-sm"
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Search 2,000+ domains"
              value={draftSearch}
            />
          </div>
          <button className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50" type="submit">
            Search
          </button>
          {search ? (
            <button className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm hover:bg-slate-50" onClick={() => { setSearch(""); setDraftSearch(""); }} type="button">
              Clear
            </button>
          ) : null}
        </form>

        {error || domains.isError ? (
          <div className="mb-4 flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-panel-danger">
            <AlertTriangle size={18} />
            {error || (domains.error instanceof Error ? domains.error.message : "Could not load domains")}
          </div>
        ) : null}

        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center justify-between border-b border-panel-line px-4 py-3 text-sm">
            <span className="font-semibold">Domain Inventory</span>
            <span className="text-panel-muted">{domains.data ? `${domains.data.total} total` : "Loading..."}</span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">DNS</th>
                <th className="px-4 py-3">Mailboxes</th>
                <th className="px-4 py-3">Subdomains</th>
                <th className="px-4 py-3">SSL</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(domains.data?.items ?? []).map((domain) => (
                <tr key={domain.id} className="border-t border-panel-line">
                  <td className="px-4 py-3 font-medium">{domain.name}</td>
                  <td className="px-4 py-3">
                    <select
                      className={`h-8 rounded-md border border-transparent px-2 text-xs font-semibold ${statusClass(domain.status)}`}
                      onChange={(event) => updateStatus.mutate({ id: domain.id, status: event.target.value as DomainStatus })}
                      value={domain.status}
                    >
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="PENDING">PENDING</option>
                      <option value="SUSPENDED">SUSPENDED</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">{domain._count.dnsRecords}</td>
                  <td className="px-4 py-3">{domain._count.mailAccounts}</td>
                  <td className="px-4 py-3">{domain._count.subdomains}</td>
                  <td className="px-4 py-3">{domain.sslEnabled ? "enabled" : domain.forceSsl ? "pending" : "off"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`/domains/${domain.id}/overview`} title="View domain">
                        <Eye size={15} />
                      </Link>
                      <button
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50"
                        onClick={() => {
                          if (window.confirm(`Delete ${domain.name}? This removes its DNS, mail accounts, and deployment metadata.`)) {
                            deleteDomain.mutate(domain);
                          }
                        }}
                        title="Delete domain"
                        type="button"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {domains.data?.items.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-panel-muted" colSpan={7}>
                    No domains found
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
