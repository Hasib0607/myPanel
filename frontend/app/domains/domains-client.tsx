"use client";

import Link from "next/link";
import { Fragment, FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eye, Globe2, ListPlus, Mail, Network, Plus, Search, Settings2, ShieldCheck, Split, Trash2, X } from "lucide-react";
import { ConfirmModal } from "@/components/confirm-modal";
import { PageHeader } from "@/components/page-header";
import { apiDeleteBody, apiGet, apiPatch, apiPost } from "@/lib/api";

type DomainStatus = "ACTIVE" | "PENDING" | "SUSPENDED";
type DomainHostingMode = "PUBLIC_HTML" | "DEPLOYMENT_PROXY" | "REDIRECT";

type Domain = {
  id: string;
  name: string;
  status: DomainStatus;
  sslEnabled: boolean;
  sslExpiry: string | null;
  forceSsl: boolean;
  hostingMode: DomainHostingMode;
  documentRoot: string;
  redirectUrl: string | null;
  hostingDeploymentId: string | null;
  createdAt: string;
  subdomains: Array<{ id: string; name: string; target: string; sslEnabled: boolean }>;
  _count: {
    subdomains: number;
    dnsRecords: number;
    mailAccounts: number;
  };
};

type Deployment = {
  id: string;
  name: string;
  slug: string;
  port: number;
};

type DeploymentListResponse = {
  items: Deployment[];
  total: number;
};

type HostingDraft = {
  domain: Domain;
  hostingMode: DomainHostingMode;
  documentRoot: string;
  redirectUrl: string;
  hostingDeploymentId: string;
};

type DomainListResponse = {
  items: Domain[];
  total: number;
  page: number;
  pageSize: number;
};

type BulkDomainResult = {
  input: string;
  name: string;
  status: "created" | "skipped" | "failed";
  error?: string;
  publishWarning?: string;
};

type BulkDomainResponse = {
  created: number;
  skipped: number;
  failed: number;
  total: number;
  results: BulkDomainResult[];
};

function statusClass(status: DomainStatus) {
  if (status === "ACTIVE") return "bg-emerald-50 text-emerald-700";
  if (status === "SUSPENDED") return "bg-red-50 text-panel-danger";
  return "bg-amber-50 text-amber-700";
}

function normalizeDomainInput(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0]
    .replace(/\.$/, "");
}

function validDomainInput(value: string) {
  const labels = value.split(".");
  if (labels.length < 2 || value.length > 253) return false;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1] ?? "")) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function DomainsClient() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [forceSsl, setForceSsl] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hostingDraft, setHostingDraft] = useState<HostingDraft | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkForceSsl, setBulkForceSsl] = useState(true);
  const [bulkPublish, setBulkPublish] = useState(true);
  const [bulkSkipExisting, setBulkSkipExisting] = useState(true);
  const [bulkResults, setBulkResults] = useState<BulkDomainResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const normalizedNewDomain = normalizeDomainInput(newDomain);
  const parsedBulkDomains = useMemo(() => {
    const domains = bulkText
      .split(/[\s,;]+/)
      .map((value) => normalizeDomainInput(value))
      .filter(Boolean);
    return [...new Set(domains)];
  }, [bulkText]);

  const queryPath = useMemo(() => {
    const params = new URLSearchParams({ page: "1", pageSize: "50" });
    if (search) params.set("search", search);
    return `/domains?${params.toString()}`;
  }, [search]);

  const domains = useQuery({
    queryKey: ["domains", search],
    queryFn: () => apiGet<DomainListResponse>(queryPath)
  });

  const deployments = useQuery({
    queryKey: ["deployments", "domain-hosting"],
    queryFn: () => apiGet<DeploymentListResponse>("/deployments?page=1&pageSize=100")
  });

  const createDomain = useMutation({
    mutationFn: () => apiPost<Domain>("/domains", { name: normalizedNewDomain, forceSsl }),
    onSuccess: async (domain) => {
      setNewDomain("");
      setForceSsl(true);
      setError("");
      setNotice(`${domain.name} added with default DNS records.`);
      setSearch("");
      setDraftSearch("");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not add domain")
  });

  const createBulkDomains = useMutation({
    mutationFn: () => apiPost<BulkDomainResponse>("/domains/bulk", {
      domains: parsedBulkDomains,
      forceSsl: bulkForceSsl,
      skipExisting: bulkSkipExisting,
      publish: bulkPublish
    }),
    onSuccess: async (response) => {
      setError("");
      setBulkResults(response);
      setNotice(`Bulk add complete: ${response.created} created, ${response.skipped} skipped, ${response.failed} failed.`);
      if (response.failed === 0) setBulkText("");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not add domains")
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DomainStatus }) => apiPatch(`/domains/${id}/status`, { status }),
    onSuccess: async () => {
      setError("");
      setNotice("Domain status updated.");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update domain")
  });

  const deleteDomain = useMutation({
    mutationFn: (domain: Domain) => apiDeleteBody(`/domains/${domain.id}`, { confirmName: domain.name }),
    onSuccess: async () => {
      setError("");
      setNotice("Domain deleted.");
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not delete domain")
  });

  const publishDomain = useMutation({
    mutationFn: (domain: Domain) => apiPost(`/domains/${domain.id}/publish`, {}),
    onSuccess: async () => {
      setError("");
      setNotice("DNS zone and website vhost published.");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not publish domain")
  });

  const updateHosting = useMutation({
    mutationFn: (draft: HostingDraft) => apiPatch(`/domains/${draft.domain.id}`, {
      hostingMode: draft.hostingMode,
      documentRoot: draft.documentRoot.trim() || "public_html",
      redirectUrl: draft.hostingMode === "REDIRECT" ? draft.redirectUrl.trim() : null,
      hostingDeploymentId: draft.hostingMode === "DEPLOYMENT_PROXY" ? draft.hostingDeploymentId : null
    }),
    onSuccess: async () => {
      setError("");
      setNotice("Domain hosting updated and published.");
      setHostingDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update hosting")
  });

  function openHosting(domain: Domain) {
    setNotice("");
    setError("");
    setHostingDraft({
      domain,
      hostingMode: domain.hostingMode,
      documentRoot: domain.documentRoot || "public_html",
      redirectUrl: domain.redirectUrl ?? "",
      hostingDeploymentId: domain.hostingDeploymentId ?? ""
    });
  }

  function hostingLabel(domain: Domain) {
    if (domain.hostingMode === "DEPLOYMENT_PROXY") {
      const deployment = deployments.data?.items.find((item) => item.id === domain.hostingDeploymentId);
      return deployment ? `${deployment.name} :${deployment.port}` : "deployment proxy";
    }
    if (domain.hostingMode === "REDIRECT") return domain.redirectUrl || "redirect";
    return domain.documentRoot || "public_html";
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  function submitNewDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!normalizedNewDomain) {
      setError("Type a domain first, for example example.com.");
      return;
    }
    if (!validDomainInput(normalizedNewDomain)) {
      setError("Enter a valid root domain, like example.com.");
      return;
    }
    createDomain.mutate();
  }

  function submitBulkDomains(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBulkResults(null);
    if (parsedBulkDomains.length === 0) {
      setError("Paste at least one domain first.");
      return;
    }
    const invalid = parsedBulkDomains.find((domain) => !validDomainInput(domain));
    if (invalid) {
      setError(`${invalid} is not a valid root domain.`);
      return;
    }
    createBulkDomains.mutate();
  }

  return (
    <>
      <PageHeader
        title="Domains"
        description="Manage root domains, subdomains, SSL, and default records for high-volume hosting."
        action={
          <div className="flex items-center gap-2">
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
              <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={createDomain.isPending} type="submit">
                <Plus size={16} />
                {createDomain.isPending ? "Adding" : "Add"}
              </button>
            </form>
            <button
              className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-4 text-sm font-semibold hover:bg-slate-50"
              onClick={() => {
                setBulkOpen(true);
                setBulkResults(null);
              }}
              type="button"
            >
              <ListPlus size={16} />
              Bulk Add
            </button>
          </div>
        }
      />
      <section className="p-6 xl:p-8">
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

        {notice ? (
          <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {notice}
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
                <th className="px-4 py-3">Hosting</th>
                <th className="px-4 py-3">SSL</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(domains.data?.items ?? []).map((domain) => (
                <Fragment key={domain.id}>
                  <tr className="border-t border-panel-line">
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
                    <td className="px-4 py-3">
                      <div className="max-w-48">
                        <div className="text-xs font-semibold text-slate-700">{domain.hostingMode.replace("_", " ")}</div>
                        <div className="truncate text-xs text-panel-muted">{hostingLabel(domain)}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3">{domain.sslEnabled ? "enabled" : domain.forceSsl ? "pending" : "off"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`/domains/${domain.id}/overview`} title="View domain">
                          <Eye size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`/domains/${domain.id}/dns`} title="DNS records">
                          <Network size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`/domains/${domain.id}/subdomains`} title="Subdomains">
                          <Split size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`/domains/${domain.id}/ssl`} title="SSL">
                          <ShieldCheck size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`/domains/${domain.id}/mail/accounts`} title="Mail accounts">
                          <Mail size={15} />
                        </Link>
                        <button
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100"
                          onClick={() => openHosting(domain)}
                          title="Hosting settings"
                          type="button"
                        >
                          <Settings2 size={15} />
                        </button>
                        <button
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100 disabled:opacity-60"
                          disabled={publishDomain.isPending}
                          onClick={() => {
                            setNotice("");
                            publishDomain.mutate(domain);
                          }}
                          title="Publish DNS and website"
                          type="button"
                        >
                          <Globe2 size={15} />
                        </button>
                        <button
                          className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50 disabled:opacity-60"
                          disabled={deleteDomain.isPending}
                          onClick={() => setDeleteTarget(domain)}
                          title="Delete domain"
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {domain.subdomains.map((subdomain) => (
                    <tr key={subdomain.id} className="border-t border-panel-line bg-slate-50/60">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 pl-4">
                          <Split className="text-panel-muted" size={15} />
                          <span className="font-medium">{subdomain.name}.{domain.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3"><span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-panel-muted">SUBDOMAIN</span></td>
                      <td className="px-4 py-3">1</td>
                      <td className="px-4 py-3">-</td>
                      <td className="px-4 py-3">-</td>
                      <td className="px-4 py-3">
                        <div className="max-w-48">
                          <div className="text-xs font-semibold text-slate-700">DNS TARGET</div>
                          <div className="truncate text-xs text-panel-muted">{subdomain.target}</div>
                        </div>
                      </td>
                      <td className="px-4 py-3">{subdomain.sslEnabled ? "enabled" : "pending"}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white hover:bg-slate-100" href={`/domains/${domain.id}/subdomains`} title="Manage subdomains">
                            <Split size={15} />
                          </Link>
                          <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white hover:bg-slate-100" href={`/domains/${domain.id}/dns`} title="DNS records">
                            <Network size={15} />
                          </Link>
                          <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white hover:bg-slate-100" href={`/domains/${domain.id}/subdomains/${subdomain.id}/ssl`} title="SSL">
                            <ShieldCheck size={15} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              {domains.data?.items.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-panel-muted" colSpan={8}>
                    No domains found
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      {bulkOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-3xl rounded-md border border-panel-line bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-panel-text">Bulk Add Domains</h2>
                <p className="text-sm text-panel-muted">{parsedBulkDomains.length} domain{parsedBulkDomains.length === 1 ? "" : "s"} ready</p>
              </div>
              <button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50" onClick={() => setBulkOpen(false)} type="button">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={submitBulkDomains}>
              <div className="space-y-4 p-5">
                <label className="block text-sm font-semibold text-panel-muted">
                  Domains
                  <textarea
                    className="mt-2 min-h-48 w-full rounded-md border border-panel-line px-3 py-2 font-mono text-sm text-panel-text"
                    onChange={(event) => setBulkText(event.target.value)}
                    placeholder={"example.com\nexample.net\nexample.org"}
                    value={bulkText}
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm">
                    <input checked={bulkForceSsl} onChange={(event) => setBulkForceSsl(event.target.checked)} type="checkbox" />
                    Force SSL
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm">
                    <input checked={bulkPublish} onChange={(event) => setBulkPublish(event.target.checked)} type="checkbox" />
                    Publish DNS/vhost
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm">
                    <input checked={bulkSkipExisting} onChange={(event) => setBulkSkipExisting(event.target.checked)} type="checkbox" />
                    Skip existing
                  </label>
                </div>
                {bulkResults ? (
                  <div className="rounded-md border border-panel-line">
                    <div className="flex items-center justify-between border-b border-panel-line px-4 py-3 text-sm">
                      <span className="font-semibold">Import results</span>
                      <span className="text-panel-muted">{bulkResults.created} created, {bulkResults.skipped} skipped, {bulkResults.failed} failed</span>
                    </div>
                    <div className="max-h-56 overflow-auto">
                      {bulkResults.results.map((result) => (
                        <div key={`${result.name}-${result.status}`} className="grid grid-cols-[1fr_auto] gap-3 border-t border-panel-line px-4 py-2 text-sm first:border-t-0">
                          <div>
                            <div className="font-medium text-panel-text">{result.name}</div>
                            {result.error || result.publishWarning ? (
                              <div className="text-xs text-panel-muted">{result.error || result.publishWarning}</div>
                            ) : null}
                          </div>
                          <span className={`h-7 rounded-md px-2 py-1 text-xs font-semibold ${
                            result.status === "created"
                              ? "bg-emerald-50 text-emerald-700"
                              : result.status === "failed"
                                ? "bg-red-50 text-panel-danger"
                                : "bg-slate-100 text-panel-muted"
                          }`}>
                            {result.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 border-t border-panel-line px-5 py-4">
                <button className="h-10 rounded-md border border-panel-line px-4 text-sm font-semibold hover:bg-slate-50" onClick={() => setBulkOpen(false)} type="button">
                  Close
                </button>
                <button
                  className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={createBulkDomains.isPending}
                  type="submit"
                >
                  <ListPlus size={16} />
                  {createBulkDomains.isPending ? "Adding" : "Add Domains"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      {hostingDraft ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="w-full max-w-2xl rounded-md border border-panel-line bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold text-panel-text">{hostingDraft.domain.name}</h2>
                <p className="text-sm text-panel-muted">Hosting settings</p>
              </div>
              <button className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50" onClick={() => setHostingDraft(null)} type="button">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <label className="block text-sm font-semibold text-panel-muted">
                Mode
                <select
                  className="mt-2 h-11 w-full rounded-md border border-panel-line px-3 text-panel-text"
                  onChange={(event) => setHostingDraft((draft) => draft ? { ...draft, hostingMode: event.target.value as DomainHostingMode } : draft)}
                  value={hostingDraft.hostingMode}
                >
                  <option value="PUBLIC_HTML">Public HTML</option>
                  <option value="DEPLOYMENT_PROXY">Deployment proxy</option>
                  <option value="REDIRECT">Redirect</option>
                </select>
              </label>

              {hostingDraft.hostingMode === "PUBLIC_HTML" ? (
                <label className="block text-sm font-semibold text-panel-muted">
                  Document root
                  <input
                    className="mt-2 h-11 w-full rounded-md border border-panel-line px-3 text-panel-text"
                    onChange={(event) => setHostingDraft((draft) => draft ? { ...draft, documentRoot: event.target.value } : draft)}
                    placeholder="public_html"
                    value={hostingDraft.documentRoot}
                  />
                </label>
              ) : null}

              {hostingDraft.hostingMode === "DEPLOYMENT_PROXY" ? (
                <label className="block text-sm font-semibold text-panel-muted">
                  Deployment
                  <select
                    className="mt-2 h-11 w-full rounded-md border border-panel-line px-3 text-panel-text"
                    onChange={(event) => setHostingDraft((draft) => draft ? { ...draft, hostingDeploymentId: event.target.value } : draft)}
                    value={hostingDraft.hostingDeploymentId}
                  >
                    <option value="">Select deployment</option>
                    {(deployments.data?.items ?? []).map((deployment) => (
                      <option key={deployment.id} value={deployment.id}>{deployment.name} :{deployment.port}</option>
                    ))}
                  </select>
                </label>
              ) : null}

              {hostingDraft.hostingMode === "REDIRECT" ? (
                <label className="block text-sm font-semibold text-panel-muted">
                  Redirect URL
                  <input
                    className="mt-2 h-11 w-full rounded-md border border-panel-line px-3 text-panel-text"
                    onChange={(event) => setHostingDraft((draft) => draft ? { ...draft, redirectUrl: event.target.value } : draft)}
                    placeholder="https://example.com"
                    value={hostingDraft.redirectUrl}
                  />
                </label>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-panel-line px-5 py-4">
              <button className="h-10 rounded-md border border-panel-line px-4 text-sm font-semibold hover:bg-slate-50" onClick={() => setHostingDraft(null)} type="button">
                Cancel
              </button>
              <button
                className="h-10 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={updateHosting.isPending}
                onClick={() => updateHosting.mutate(hostingDraft)}
                type="button"
              >
                {updateHosting.isPending ? "Saving" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmModal
        confirmLabel="Delete domain"
        message={`This removes ${deleteTarget?.name ?? "this domain"} with its DNS records, mail accounts, subdomains, and deployment metadata.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          setNotice("");
          deleteDomain.mutate(deleteTarget);
        }}
        open={Boolean(deleteTarget)}
        pending={deleteDomain.isPending}
        title="Delete domain?"
      />
    </>
  );
}
