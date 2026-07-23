"use client";

import Link from "next/link";
import { Fragment, FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronUp, Eye, Globe2, ListPlus, Mail, Network, Plus, Search, Settings2, ShieldCheck, Split, Trash2, X } from "lucide-react";
import { ConfirmModal } from "@/components/confirm-modal";
import { PageHeader } from "@/components/page-header";
import { apiDeleteBody, apiGet, apiPatch, apiPost } from "@/lib/api";

type DomainStatus = "ACTIVE" | "PENDING" | "SUSPENDED";
type DomainHostingMode = "PUBLIC_HTML" | "DEPLOYMENT_PROXY" | "REDIRECT";
const PAGE_SIZE = 50;

type Domain = {
  id: string;
  name: string;
  status: DomainStatus;
  sslEnabled: boolean;
  sslExpiry: string | null;
  liveSslEnabled?: boolean;
  liveSslExpiry?: string | null;
  sslHosts?: Array<{ host: string; sslEnabled?: boolean; covered?: boolean; expiry?: string | null }>;
  forceSsl: boolean;
  hostingMode: DomainHostingMode;
  documentRoot: string;
  redirectUrl: string | null;
  hostingDeploymentId: string | null;
  createdAt: string;
  subdomains: Array<{ id: string; name: string; target: string; sslEnabled: boolean; fqdn?: string; domainId?: string; isDomainAlias?: boolean; dnsRecords?: number }>;
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
  sslQueued?: number;
  sslJobs?: Array<{ domainId: string; domain: string; jobId: string | number | null }>;
  queueCounts?: Record<string, number>;
  results: BulkDomainResult[];
};

type BulkDomainAction = "activate" | "deactivate" | "delete" | "force_ssl" | "issue_ssl";

type BulkDomainActionResponse = {
  ok: boolean;
  action: BulkDomainAction;
  affected: number;
  sslQueued?: number;
  sslJobs?: Array<{ domainId: string; domain: string; jobId: string | number | null }>;
  queueCounts?: Record<string, number>;
};

type SortColumn = "domain" | "status" | "dns" | "mailboxes" | "subdomains" | "hosting" | "ssl";
type SortDirection = "asc" | "desc";

function compareSsl(a: Domain, b: Domain, direction: SortDirection) {
  const rank = (domain: Domain) => {
    const enabled = domain.liveSslEnabled ?? domain.sslEnabled;
    if (enabled) return direction === "asc" ? 1 : 0;
    if (domain.forceSsl) return direction === "asc" ? 0 : 1;
    return 2;
  };
  return rank(a) - rank(b);
}

function sslLabel(domain: Domain) {
  if (domain.liveSslEnabled ?? domain.sslEnabled) return "enabled";
  if (domain.forceSsl) return "pending";
  return "off";
}

function sslHostCovered(host: { sslEnabled?: boolean; covered?: boolean }) {
  return Boolean(host.sslEnabled ?? host.covered);
}

function sslSummary(domain: Domain) {
  const hosts = domain.sslHosts ?? [];
  if (!hosts.length) return sslLabel(domain);
  const covered = hosts.filter(sslHostCovered).length;
  if (covered === hosts.length) return "enabled";
  if (covered > 0) return `${covered}/${hosts.length} valid`;
  if (domain.forceSsl) return "pending";
  return "off";
}

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
  return labels.every((label, index) =>
    label === "*" && index === 0
      ? true
      : /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  );
}

type DomainsClientProps = {
  apiBase?: "/domains" | "/account/domains";
  deploymentApiBase?: "/deployments" | "/account/deployments";
  linkBase?: "/domains" | "/account/domains";
  showBulkAdd?: boolean;
  headerDescription?: string;
};

export function DomainsClient({
  apiBase = "/domains",
  deploymentApiBase = "/deployments",
  linkBase = "/domains",
  showBulkAdd = true,
  headerDescription = "Manage root domains, subdomains, SSL, and default records for high-volume hosting."
}: DomainsClientProps = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [forceSsl, setForceSsl] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);
  const [hostingDraft, setHostingDraft] = useState<HostingDraft | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkForceSsl, setBulkForceSsl] = useState(true);
  const [bulkIssueSsl, setBulkIssueSsl] = useState(false);
  const [bulkPublish, setBulkPublish] = useState(true);
  const [bulkSkipExisting, setBulkSkipExisting] = useState(true);
  const [bulkResults, setBulkResults] = useState<BulkDomainResponse | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedDomainIds, setSelectedDomainIds] = useState<string[]>([]);
  const [deleteSubdomainTarget, setDeleteSubdomainTarget] = useState<{ domainId: string; subdomainId: string; fqdn: string } | null>(null);
  const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection } | null>(null);
  const normalizedNewDomain = normalizeDomainInput(newDomain);
  const parsedBulkDomains = useMemo(() => {
    const domains = bulkText
      .split(/[\s,;]+/)
      .map((value) => normalizeDomainInput(value))
      .filter(Boolean);
    return [...new Set(domains)];
  }, [bulkText]);

  const queryPath = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("search", search);
    return `${apiBase}?${params.toString()}`;
  }, [apiBase, page, search]);

  const domains = useQuery({
    queryKey: ["domains", apiBase, search, page],
    queryFn: () => apiGet<DomainListResponse>(queryPath)
  });
  const deployments = useQuery({
    queryKey: ["deployments", deploymentApiBase, "domain-hosting"],
    queryFn: () => apiGet<DeploymentListResponse | Deployment[]>(`${deploymentApiBase}?page=1&pageSize=100`)
  });
  const deploymentItems = Array.isArray(deployments.data) ? deployments.data : deployments.data?.items ?? [];
  const visibleDomains = domains.data?.items ?? [];
  const sortedVisibleDomains = useMemo(() => {
    if (!sort) return visibleDomains;
    const items = [...visibleDomains];
    const direction = sort.direction === "asc" ? 1 : -1;
    items.sort((left, right) => {
      let comparison = 0;
      switch (sort.column) {
        case "domain":
          comparison = left.name.localeCompare(right.name);
          break;
        case "status":
          comparison = left.status.localeCompare(right.status);
          break;
        case "dns":
          comparison = left._count.dnsRecords - right._count.dnsRecords;
          break;
        case "mailboxes":
          comparison = left._count.mailAccounts - right._count.mailAccounts;
          break;
        case "subdomains":
          comparison = left._count.subdomains - right._count.subdomains;
          break;
        case "hosting": {
          const hostingValue = (domain: Domain) => {
            if (domain.hostingMode === "DEPLOYMENT_PROXY") {
              const deployment = deploymentItems.find((item) => item.id === domain.hostingDeploymentId);
              return deployment ? `${domain.hostingMode} ${deployment.name}:${deployment.port}` : domain.hostingMode;
            }
            if (domain.hostingMode === "REDIRECT") return `${domain.hostingMode} ${domain.redirectUrl ?? ""}`;
            return `${domain.hostingMode} ${domain.documentRoot}`;
          };
          comparison = hostingValue(left).localeCompare(hostingValue(right));
          break;
        }
        case "ssl":
          return compareSsl(left, right, sort.direction);
      }
      return comparison * direction;
    });
    return items;
  }, [deploymentItems, sort, visibleDomains]);
  const totalDomains = domains.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalDomains / PAGE_SIZE));
  const pageStart = totalDomains === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(page * PAGE_SIZE, totalDomains);
  const visibleDomainIds = visibleDomains.map((domain) => domain.id);
  const visibleSelectedCount = visibleDomainIds.filter((id) => selectedDomainIds.includes(id)).length;
  const allVisibleSelected = visibleDomainIds.length > 0 && visibleSelectedCount === visibleDomainIds.length;
  const selectedCount = selectedDomainIds.length;

  const createDomain = useMutation({
    mutationFn: () => apiPost<Domain>(apiBase, { name: normalizedNewDomain, forceSsl }),
    onSuccess: async (domain) => {
      setNewDomain("");
      setForceSsl(true);
      setError("");
      setNotice(`${domain.name} added with default DNS records.`);
      setSearch("");
      setDraftSearch("");
      setPage(1);
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not add domain")
  });

  const createBulkDomains = useMutation({
    mutationFn: () => apiPost<BulkDomainResponse>(`${apiBase}/bulk`, {
      domains: parsedBulkDomains,
      forceSsl: bulkForceSsl,
      issueSsl: bulkPublish && bulkIssueSsl,
      skipExisting: bulkSkipExisting,
      publish: bulkPublish
    }),
    onSuccess: async (response) => {
      setError("");
      setBulkResults(response);
      const queueText = response.sslQueued
        ? ` ${response.sslQueued} SSL job${response.sslQueued === 1 ? "" : "s"} queued serially; first job starts now, then one job every minute.`
        : "";
      const countText = response.queueCounts
        ? ` Queue: waiting ${response.queueCounts.waiting ?? 0}, delayed ${response.queueCounts.delayed ?? 0}, active ${response.queueCounts.active ?? 0}, failed ${response.queueCounts.failed ?? 0}.`
        : "";
      setNotice(`Bulk add complete: ${response.created} created, ${response.skipped} skipped, ${response.failed} failed.${queueText}${countText}`);
      if (response.failed === 0) setBulkText("");
      setPage(1);
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not add domains")
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: DomainStatus }) => apiPatch(`${apiBase}/${id}/status`, { status }),
    onSuccess: async () => {
      setError("");
      setNotice("Domain status updated.");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not update domain")
  });

  const deleteDomain = useMutation({
    mutationFn: (domain: Domain) => apiDeleteBody(`${apiBase}/${domain.id}`, { confirmName: domain.name }),
    onSuccess: async () => {
      setError("");
      setNotice("Domain deleted.");
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not delete domain")
  });

  const deleteSubdomain = useMutation({
    mutationFn: ({ domainId, subdomainId }: { domainId: string; subdomainId: string }) =>
      apiDeleteBody<{ ok: true; publishWarning?: string }>(`${apiBase}/${domainId}/subdomains/${subdomainId}`, {}),
    onSuccess: async (result) => {
      setError("");
      setNotice(result.publishWarning ? `Subdomain deleted. ${result.publishWarning}` : "Subdomain deleted.");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not delete subdomain")
  });

  const bulkDomainAction = useMutation({
    mutationFn: (action: BulkDomainAction) =>
      apiPost<BulkDomainActionResponse>(`${apiBase}/bulk-action`, {
        domainIds: selectedDomainIds,
        action
      }),
    onSuccess: async (response) => {
      setError("");
      setConfirmBulkDelete(false);
      if (response.action !== "issue_ssl") setSelectedDomainIds([]);
      const actionLabel = response.action === "activate"
        ? "activated"
        : response.action === "deactivate"
          ? "deactivated"
          : response.action === "delete"
            ? "deleted"
            : response.action === "force_ssl"
              ? "updated for Force SSL"
              : "queued for SSL";
      const queueText = response.action === "issue_ssl" && response.sslQueued
        ? ` ${response.sslQueued} SSL job${response.sslQueued === 1 ? "" : "s"} queued serially; first job starts now, then one job every minute.`
        : "";
      const countText = response.queueCounts && response.action === "issue_ssl"
        ? ` Queue: waiting ${response.queueCounts.waiting ?? 0}, delayed ${response.queueCounts.delayed ?? 0}, active ${response.queueCounts.active ?? 0}, failed ${response.queueCounts.failed ?? 0}.`
        : "";
      setNotice(`${response.affected} domain${response.affected === 1 ? "" : "s"} ${actionLabel}.${queueText}${countText}`);
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not run selected domain action")
  });

  const publishDomain = useMutation({
    mutationFn: (domain: Domain) => apiPost(`${apiBase}/${domain.id}/publish`, {}),
    onSuccess: async () => {
      setError("");
      setNotice("DNS zone and website vhost published.");
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not publish domain")
  });

  const updateHosting = useMutation({
    mutationFn: (draft: HostingDraft) => apiPatch(`${apiBase}/${draft.domain.id}`, {
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
      const deployment = deploymentItems.find((item) => item.id === domain.hostingDeploymentId);
      return deployment ? `${deployment.name} :${deployment.port}` : "deployment proxy";
    }
    if (domain.hostingMode === "REDIRECT") return domain.redirectUrl || "redirect";
    return domain.documentRoot || "public_html";
  }

  function toggleSort(column: SortColumn) {
    setSort((current) => {
      if (current?.column === column) {
        return { column, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: "asc" };
    });
  }

  function sortIndicator(column: SortColumn) {
    if (sort?.column !== column) return null;
    return sort.direction === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />;
  }

  function SortableHeader({ column, label }: { column: SortColumn; label: string }) {
    const active = sort?.column === column;
    return (
      <th className="px-4 py-3">
        <button
          className={`inline-flex items-center gap-1 font-semibold uppercase transition-colors ${active ? "text-panel-ink" : "text-panel-muted hover:text-panel-ink"}`}
          onClick={() => toggleSort(column)}
          title={active ? `Sorted ${sort?.direction === "asc" ? "ascending" : "descending"}. Click to reverse.` : `Sort by ${label}`}
          type="button"
        >
          {label}
          {sortIndicator(column)}
        </button>
      </th>
    );
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
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
      setError("Enter a valid root domain like example.com, or a wildcard subdomain like *.example.com.");
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
      setError(`${invalid} is not a valid root domain or wildcard subdomain.`);
      return;
    }
    createBulkDomains.mutate();
  }

  function toggleDomainSelection(domainId: string) {
    setSelectedDomainIds((current) =>
      current.includes(domainId)
        ? current.filter((id) => id !== domainId)
        : [...current, domainId]
    );
  }

  function toggleVisibleSelection() {
    setSelectedDomainIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !visibleDomainIds.includes(id));
      }
      return [...new Set([...current, ...visibleDomainIds])];
    });
  }

  return (
    <>
      <PageHeader
        title="Domains"
        description={headerDescription}
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
            {showBulkAdd ? <button
              className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-4 text-sm font-semibold hover:bg-slate-50"
              onClick={() => {
                setBulkOpen(true);
                setBulkResults(null);
              }}
              type="button"
            >
              <ListPlus size={16} />
              Bulk Add
            </button> : null}
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
            <button className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm hover:bg-slate-50" onClick={() => { setPage(1); setSearch(""); setDraftSearch(""); }} type="button">
              Clear
            </button>
          ) : null}
        </form>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="text-panel-muted">
            {domains.data ? `Showing ${pageStart}-${pageEnd} of ${totalDomains}` : "Loading domains..."}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="h-9 rounded-md border border-panel-line bg-white px-3 font-semibold hover:bg-slate-50 disabled:opacity-50"
              disabled={page <= 1 || domains.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              Previous
            </button>
            <span className="min-w-24 text-center text-panel-muted">Page {page} of {totalPages}</span>
            <button
              className="h-9 rounded-md border border-panel-line bg-white px-3 font-semibold hover:bg-slate-50 disabled:opacity-50"
              disabled={page >= totalPages || domains.isFetching}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              type="button"
            >
              Next
            </button>
          </div>
        </div>

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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-4 py-3 text-sm">
            <div className="flex items-center gap-3">
              <span className="font-semibold">Domain Inventory</span>
              {selectedCount > 0 ? <span className="text-panel-muted">{selectedCount} selected</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedCount > 0 ? (
                <>
                  <button
                    className="h-9 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
                    disabled={bulkDomainAction.isPending}
                    onClick={() => bulkDomainAction.mutate("activate")}
                    type="button"
                  >
                    Active
                  </button>
                  <button
                    className="h-9 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
                    disabled={bulkDomainAction.isPending}
                    onClick={() => bulkDomainAction.mutate("deactivate")}
                    type="button"
                  >
                    Deactive
                  </button>
                  <button
                    className="h-9 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
                    disabled={bulkDomainAction.isPending}
                    onClick={() => bulkDomainAction.mutate("force_ssl")}
                    type="button"
                  >
                    Force SSL
                  </button>
                  <button
                    className="h-9 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
                    disabled={bulkDomainAction.isPending}
                    onClick={() => bulkDomainAction.mutate("issue_ssl")}
                    type="button"
                  >
                    Issue SSL
                  </button>
                  <button
                    className="h-9 rounded-md border border-red-200 px-3 text-sm font-semibold text-panel-danger hover:bg-red-50 disabled:opacity-60"
                    disabled={bulkDomainAction.isPending}
                    onClick={() => setConfirmBulkDelete(true)}
                    type="button"
                  >
                    Delete
                  </button>
                  <button
                    className="h-9 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50"
                    onClick={() => setSelectedDomainIds([])}
                    type="button"
                  >
                    Clear
                  </button>
                </>
              ) : null}
              <span className="text-panel-muted">{domains.data ? `${domains.data.total} total` : "Loading..."}</span>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr>
                <th className="w-12 px-4 py-3">
                  <input
                    aria-label="Select visible domains"
                    checked={allVisibleSelected}
                    disabled={visibleDomainIds.length === 0}
                    onChange={toggleVisibleSelection}
                    type="checkbox"
                  />
                </th>
                <SortableHeader column="domain" label="Domain" />
                <SortableHeader column="status" label="Status" />
                <SortableHeader column="dns" label="DNS" />
                <SortableHeader column="mailboxes" label="Mailboxes" />
                <SortableHeader column="subdomains" label="Subdomains" />
                <SortableHeader column="hosting" label="Hosting" />
                <SortableHeader column="ssl" label="SSL" />
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedVisibleDomains.map((domain) => (
                <Fragment key={domain.id}>
                  <tr className="border-t border-panel-line">
                    <td className="px-4 py-3">
                      <input
                        aria-label={`Select ${domain.name}`}
                        checked={selectedDomainIds.includes(domain.id)}
                        onChange={() => toggleDomainSelection(domain.id)}
                        type="checkbox"
                      />
                    </td>
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
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <div className="text-xs font-semibold text-slate-700">{sslSummary(domain)}</div>
                        {domain.sslHosts?.length ? (
                          <div className="flex max-w-52 flex-wrap gap-1">
                            {domain.sslHosts.map((host) => {
                              const covered = sslHostCovered(host);
                              return (
                                <span
                                  className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${covered ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}
                                  key={host.host}
                                  title={host.host}
                                >
                                  {host.host.startsWith("www.") ? "www" : "apex"} {covered ? "valid" : "pending"}
                                </span>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`${linkBase}/${domain.id}/overview`} title="View domain">
                          <Eye size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`${linkBase}/${domain.id}/dns`} title="DNS records">
                          <Network size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`${linkBase}/${domain.id}/subdomains`} title="Subdomains">
                          <Split size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`${linkBase}/${domain.id}/ssl`} title="SSL">
                          <ShieldCheck size={15} />
                        </Link>
                        <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-100" href={`${linkBase}/${domain.id}/mail/accounts`} title="Mail accounts">
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
                      <td className="px-4 py-3" />
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 pl-4">
                          <Split className="text-panel-muted" size={15} />
                          <span className="font-medium">{subdomain.fqdn ?? `${subdomain.name}.${domain.name}`}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3"><span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-panel-muted">SUBDOMAIN</span></td>
                      <td className="px-4 py-3">{subdomain.dnsRecords ?? 1}</td>
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
                          <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white hover:bg-slate-100" href={subdomain.isDomainAlias && subdomain.domainId ? `${linkBase}/${subdomain.domainId}/overview` : `${linkBase}/${domain.id}/subdomains`} title="Manage subdomains">
                            <Split size={15} />
                          </Link>
                          <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white hover:bg-slate-100" href={`${linkBase}/${subdomain.isDomainAlias && subdomain.domainId ? subdomain.domainId : domain.id}/dns`} title="DNS records">
                            <Network size={15} />
                          </Link>
                          <Link className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white hover:bg-slate-100" href={subdomain.isDomainAlias && subdomain.domainId ? `${linkBase}/${subdomain.domainId}/ssl` : `${linkBase}/${domain.id}/subdomains/${subdomain.id}/ssl`} title="SSL">
                            <ShieldCheck size={15} />
                          </Link>
                          {subdomain.isDomainAlias ? null : (
                            <button
                              className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line bg-white text-panel-danger hover:bg-red-50 disabled:opacity-60"
                              disabled={deleteSubdomain.isPending}
                              onClick={() => {
                                const subdomainDomainId = subdomain.domainId ?? domain.id;
                                const subdomainFqdn = subdomain.fqdn ?? `${subdomain.name}.${domain.name}`;
                                setDeleteSubdomainTarget({
                                  domainId: subdomainDomainId,
                                  subdomainId: subdomain.id,
                                  fqdn: subdomainFqdn
                                });
                              }}
                              title="Delete subdomain"
                              type="button"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              {domains.data?.items.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-panel-muted" colSpan={9}>
                    No domains found
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-panel-line px-4 py-3 text-sm">
            <span className="text-panel-muted">
              {domains.data ? `Showing ${pageStart}-${pageEnd} of ${totalDomains}` : "Loading domains..."}
            </span>
            <div className="flex items-center gap-2">
              <button
                className="h-9 rounded-md border border-panel-line px-3 font-semibold hover:bg-slate-50 disabled:opacity-50"
                disabled={page <= 1 || domains.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                type="button"
              >
                Previous
              </button>
              <span className="min-w-24 text-center text-panel-muted">Page {page} of {totalPages}</span>
              <button
                className="h-9 rounded-md border border-panel-line px-3 font-semibold hover:bg-slate-50 disabled:opacity-50"
                disabled={page >= totalPages || domains.isFetching}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                type="button"
              >
                Next
              </button>
            </div>
          </div>
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
                <div className="grid gap-3 md:grid-cols-4">
                  <label className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm">
                    <input checked={bulkForceSsl} onChange={(event) => setBulkForceSsl(event.target.checked)} type="checkbox" />
                    Force SSL
                  </label>
                  <label className="flex items-center gap-2 rounded-md border border-panel-line px-3 py-2 text-sm">
                    <input checked={bulkIssueSsl} disabled={!bulkPublish} onChange={(event) => setBulkIssueSsl(event.target.checked)} type="checkbox" />
                    Issue real SSL
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
                      <span className="text-panel-muted">{bulkResults.created} created, {bulkResults.skipped} skipped, {bulkResults.failed} failed{bulkResults.sslQueued ? `, ${bulkResults.sslQueued} SSL queued` : ""}</span>
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
                    {deploymentItems.map((deployment) => (
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
        confirmLabel="Delete subdomain"
        message={`Delete subdomain ${deleteSubdomainTarget?.fqdn ?? ""}?`}
        onClose={() => setDeleteSubdomainTarget(null)}
        onConfirm={() => {
          if (!deleteSubdomainTarget) return;
          setNotice("");
          deleteSubdomain.mutate(
            { domainId: deleteSubdomainTarget.domainId, subdomainId: deleteSubdomainTarget.subdomainId },
            { onSettled: () => setDeleteSubdomainTarget(null) }
          );
        }}
        open={Boolean(deleteSubdomainTarget)}
        pending={deleteSubdomain.isPending}
        title="Delete subdomain?"
      />
      <ConfirmModal
        confirmLabel="Delete selected"
        message={`This removes ${selectedCount} selected domain${selectedCount === 1 ? "" : "s"} with their DNS records, mail accounts, subdomains, and deployment metadata.`}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={() => {
          setNotice("");
          bulkDomainAction.mutate("delete");
        }}
        open={confirmBulkDelete}
        pending={bulkDomainAction.isPending}
        title="Delete selected domains?"
      />
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
