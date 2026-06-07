"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Clipboard, Cpu, Database, Eye, EyeOff, FolderGit2, GitBranch, Github, HardDrive, History, KeyRound, List, MemoryStick, Network, Pencil, Play, Plus, Rocket, Save, Search, Settings2, ShieldCheck, Square, ToggleLeft, ToggleRight, Trash2, Wand2, X } from "lucide-react";
import { ApiError, apiDelete, apiDeleteBody, apiGet, apiGetText, apiPatch, apiPost, apiPut } from "@/lib/api";
import type { Deployment, DeploymentDomainBinding, DeploymentEnvVar, DeploymentFramework, DeploymentListResponse, DeploymentMetrics, DeploymentRelease, DetectionResponse, PreflightResponse, QueueResponse, DeploymentSourceProvider } from "./deployment-types";
import { frameworkOptions, sourceOptions } from "./deployment-types";
import { ResultNotice, actionIcon, formatDate, healthBadge, queryString, statusBadge } from "./deployment-ui";

type GithubRepo = { id?: string; owner: string; name: string; fullName: string; private: boolean; defaultBranch: string; updatedAt?: string };
type GithubRepoResponse = { connected: boolean; dryRun: boolean; items: GithubRepo[]; note?: string };
type GithubDetectResponse = DetectionResponse & { repository: string; dryRun: boolean };
type Domain = { id: string; name: string; subdomains?: Array<{ id: string; name: string; fqdn?: string; domainId?: string; isDomainAlias?: boolean }> };
type DomainOption = { id: string; name: string };
type DomainListResponse = { items: Domain[] };
type DatabaseEngine = "POSTGRESQL" | "MYSQL";
type DatabaseOverview = {
  engines: Array<{
    engine: DatabaseEngine;
    installed: boolean;
    databases: Array<{ name: string; owner: string | null }>;
    users: Array<{ name: string; host: string | null }>;
  }>;
};
type AccountInfo = { account?: { homeRoot?: string }; fileRoot?: string; homeRoot?: string };
type LogType = "build" | "running";
type RuntimeInstallTarget = { actionKey: string; tool: string; label: string; command: string; reason: string; executables: string[] };
type RuntimeReview = { required: string[]; installed: string[]; missing: string[]; installable: RuntimeInstallTarget[]; blocked: string[]; needsApproval: boolean; phpVersion?: string | null };
type RuntimeModalState = {
  deployment: Deployment;
  action: "deploy" | "start" | "restart";
  review: RuntimeReview;
  selected: Record<string, boolean>;
};
type RuntimeReviewError = {
  runtimeReview?: RuntimeReview;
  install?: {
    failed?: Array<{ tool?: string; error?: string }>;
  } | null;
};

type Draft = {
  name: string;
  slug: string;
  domainId: string;
  sourceProvider: DeploymentSourceProvider;
  framework: DeploymentFramework;
  gitUrl: string;
  githubOwner: string;
  githubRepo: string;
  branch: string;
  rootPath: string;
  rootDirectory: string;
  port: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  envText: string;
  dbType: "" | "POSTGRESQL" | "MYSQL";
  dbName: string;
  dbUser: string;
  autoDeployEnabled: boolean;
};

const initialDraft: Draft = {
  name: "",
  slug: "",
  domainId: "",
  sourceProvider: "GITHUB",
  framework: "NEXTJS",
  gitUrl: "",
  githubOwner: "",
  githubRepo: "",
  branch: "main",
  rootPath: "/var/www/deployments/new-app",
  rootDirectory: ".",
  port: "",
  installCommand: "npm install",
  buildCommand: "npm run build",
  startCommand: "npm run start",
  outputDirectory: ".next",
  envText: "NODE_ENV=production",
  dbType: "",
  dbName: "",
  dbUser: "",
  autoDeployEnabled: true
};

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function deploymentRootForRepo(repoName: string, rootBase = "/var/www/deployments") {
  return `${rootBase.replace(/\/+$/, "")}/${slugify(repoName)}`;
}

function parseEnv(text: string) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index).trim(), normalizeEnvValue(line.slice(index + 1))];
  }));
}

type BulkEnvItem = { key: string; value: string; isSecret: boolean };

function normalizeEnvValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseBulkEnvItems(text: string, isSecret = false): BulkEnvItem[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{")) {
    const parsed = Function(`"use strict"; return (${trimmed});`)() as Record<string, unknown>;
    return Object.entries(parsed).map(([key, value]) => ({
      key: key.trim().toUpperCase(),
      value: normalizeEnvValue(value == null ? "" : String(value)),
      isSecret
    })).filter((item) => item.key);
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return {
        key: line.slice(0, index).trim().toUpperCase(),
        value: normalizeEnvValue(line.slice(index + 1)),
        isSecret
      };
    })
    .filter((item) => item.key);
}

function formPayload(draft: Draft) {
  return {
    name: draft.name,
    slug: draft.slug || slugify(draft.name),
    domainId: draft.domainId || null,
    sourceProvider: draft.sourceProvider,
    framework: draft.framework,
    gitUrl: draft.gitUrl || null,
    repoUrl: draft.githubOwner && draft.githubRepo ? `https://github.com/${draft.githubOwner}/${draft.githubRepo}` : null,
    githubOwner: draft.githubOwner || null,
    githubRepo: draft.githubRepo || null,
    branch: draft.branch || "main",
    rootPath: draft.rootPath,
    rootDirectory: draft.rootDirectory || ".",
    port: Number(draft.port),
    installCommand: draft.installCommand || null,
    buildCommand: draft.buildCommand || null,
    startCommand: draft.startCommand || null,
    outputDirectory: draft.outputDirectory || null,
    dbType: draft.dbType || null,
    dbName: draft.dbName || null,
    dbUser: draft.dbUser || null,
    envVars: parseEnv(draft.envText),
    autoDeployEnabled: draft.autoDeployEnabled,
    persistentPaths: []
  };
}

function draftFromDeployment(deployment: Deployment): Draft {
  return {
    name: deployment.name,
    slug: deployment.slug,
    domainId: deployment.domainId ?? "",
    sourceProvider: deployment.sourceProvider,
    framework: deployment.framework,
    gitUrl: deployment.gitUrl ?? "",
    githubOwner: deployment.githubOwner ?? "",
    githubRepo: deployment.githubRepo ?? "",
    branch: deployment.branch,
    rootPath: deployment.rootPath,
    rootDirectory: deployment.rootDirectory,
    port: String(deployment.port),
    installCommand: deployment.installCommand ?? "",
    buildCommand: deployment.buildCommand ?? "",
    startCommand: deployment.startCommand ?? "",
    outputDirectory: deployment.outputDirectory ?? "",
    envText: Object.entries((deployment.env ?? []).reduce<Record<string, string>>((acc, item) => {
      if (!item.isSecret && item.value !== null) acc[item.key] = item.value;
      return acc;
    }, {})).map(([key, value]) => `${key}=${value}`).join("\n") || "NODE_ENV=production",
    dbType: deployment.dbType ?? "",
    dbName: deployment.dbName ?? "",
    dbUser: deployment.dbUser ?? "",
    autoDeployEnabled: deployment.autoDeployEnabled
  };
}

function domainOptions(domains: Domain[]): DomainOption[] {
  return domains.flatMap((domain) => [
    { id: domain.id, name: domain.name },
    ...(domain.subdomains ?? []).map((subdomain) => ({
      id: subdomain.isDomainAlias && subdomain.domainId ? subdomain.domainId : `subdomain:${subdomain.id}`,
      name: subdomain.fqdn ?? `${subdomain.name}.${domain.name}`
    }))
  ]).sort((a, b) => a.name.localeCompare(b.name));
}

function okNotice(message: string) {
  return !/could|error|failed|invalid/i.test(message);
}

async function writeClipboardText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is not available in this browser context.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Could not copy automatically. Select the log text and copy manually.");
  }
}

export function DeploymentsClient({
  apiBase = "/deployments",
  domainsApiBase = "/domains",
  databasesApiBase = "/databases",
  githubApiBase = "/deployments/github",
  showPanelUpdate = true,
  enableGithub = true
}: {
  apiBase?: "/deployments" | "/account/deployments";
  domainsApiBase?: "/domains" | "/account/domains";
  databasesApiBase?: "/databases" | "/account/databases";
  githubApiBase?: string;
  showPanelUpdate?: boolean;
  enableGithub?: boolean;
} = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "domains" | "history" | "env" | "settings">("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [editingOpen, setEditingOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [editDraft, setEditDraft] = useState<Draft>(initialDraft);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);
  const [githubToken, setGithubToken] = useState("");
  const [githubUsername, setGithubUsername] = useState("");
  const [domainsToAdd, setDomainsToAdd] = useState<string[]>([]);
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [envSecret, setEnvSecret] = useState(false);
  const [bulkEnvText, setBulkEnvText] = useState("");
  const [bulkEnvSecret, setBulkEnvSecret] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [logTitle, setLogTitle] = useState("");
  const [logType, setLogType] = useState<LogType>("build");
  const [notice, setNotice] = useState("");
  const [revealedEnvValues, setRevealedEnvValues] = useState<Record<string, string>>({});
  const [runtimeModal, setRuntimeModal] = useState<RuntimeModalState | null>(null);

  const deployments = useQuery({
    queryKey: ["deployments", apiBase, search, statusFilter, sourceFilter],
    queryFn: () => apiGet<DeploymentListResponse>(`${apiBase}?${queryString({ search, status: statusFilter, sourceProvider: sourceFilter, page: 1, pageSize: 50 })}`),
    refetchInterval: 8000
  });
  const domains = useQuery({ queryKey: ["domains", domainsApiBase, "deployment-create"], queryFn: () => apiGet<DomainListResponse>(`${domainsApiBase}?page=1&pageSize=100`) });
  const databaseOverview = useQuery({ queryKey: ["databases-overview", databasesApiBase, "deployment-create"], queryFn: () => apiGet<DatabaseOverview>(databasesApiBase) });
  const accountInfo = useQuery({
    enabled: apiBase === "/account/deployments",
    queryKey: ["account-info", "deployments"],
    queryFn: () => apiGet<AccountInfo>("/account")
  });
  const nextPort = useQuery({ queryKey: ["deployments-next-port", apiBase], queryFn: () => apiGet<{ port: number }>(`${apiBase}/ports/next`) });
  const repos = useQuery({ enabled: enableGithub && repoPickerOpen, queryKey: ["deployments-github-repos", githubApiBase, repoSearch], queryFn: () => apiGet<GithubRepoResponse>(`${githubApiBase}/repos?${queryString({ search: repoSearch })}`) });
  const githubConnection = useQuery({ enabled: enableGithub && repoPickerOpen, queryKey: ["deployments-github-connection", githubApiBase], queryFn: () => apiGet<{ connected: boolean; username: string | null; scopes: string[] }>(`${githubApiBase}/connection`) });

  const selected = useMemo(() => (deployments.data?.items ?? []).find((item) => item.id === selectedId) ?? deployments.data?.items?.[0] ?? null, [deployments.data?.items, selectedId]);
  const releases = useQuery({
    enabled: Boolean(selected?.slug),
    queryKey: ["deployment-releases", apiBase, selected?.slug],
    queryFn: () => apiGet<DeploymentRelease[]>(`${apiBase}/${selected!.slug}/releases`),
    refetchInterval: activeTab === "history" ? 5000 : false
  });

  useEffect(() => {
    if (!selectedId && deployments.data?.items?.[0]) setSelectedId(deployments.data.items[0].id);
  }, [deployments.data?.items, selectedId]);

  useEffect(() => {
    if (!draft.port && nextPort.data?.port) setDraft((current) => ({ ...current, port: String(nextPort.data.port) }));
  }, [draft.port, nextPort.data?.port]);

  useEffect(() => {
    setDomainsToAdd([]);
  }, [selected?.id]);

  const accountRoot = accountInfo.data?.fileRoot ?? accountInfo.data?.account?.homeRoot ?? accountInfo.data?.homeRoot;
  const rootBase = apiBase === "/account/deployments" && accountRoot
    ? `${accountRoot.replace(/\/+$/, "")}/deployments`
    : "/var/www/deployments";

  useEffect(() => {
    if (apiBase !== "/account/deployments" || !accountRoot) return;
    setDraft((current) => current.rootPath.startsWith("/var/www/deployments/")
      ? { ...current, rootPath: deploymentRootForRepo(current.slug || current.name || "new-app", rootBase) }
      : current);
  }, [accountRoot, apiBase, rootBase]);

  const invalidateDeployments = async () => {
    await queryClient.invalidateQueries({ queryKey: ["deployments"] });
    await queryClient.invalidateQueries({ queryKey: ["deployments-next-port"] });
    if (selected?.slug) {
      await queryClient.invalidateQueries({ queryKey: ["deployment", selected.slug] });
      await queryClient.invalidateQueries({ queryKey: ["deployment-env", selected.slug] });
      await queryClient.invalidateQueries({ queryKey: ["deployment-releases", selected.slug] });
    }
  };

  const createDeployment = useMutation({
    mutationFn: () => apiPost<Deployment>(apiBase, formPayload(draft)),
    onSuccess: async (deployment) => {
      setNotice(`${deployment.name} created.`);
      setSelectedId(deployment.id);
      setCreateOpen(false);
      setDraft({ ...initialDraft, port: String((nextPort.data?.port ?? deployment.port) + 1) });
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create deployment")
  });

  const updateDeployment = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a project first");
      return apiPatch<Deployment>(`${apiBase}/${selected.slug}`, formPayload(editDraft));
    },
    onSuccess: async (deployment) => {
      setNotice(`${deployment.name} updated.`);
      setEditingOpen(false);
      setSelectedId(deployment.id);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update deployment")
  });

  const detect = useMutation({
    mutationFn: (target: "create" | "edit") => apiPost<DetectionResponse>(`${apiBase}/detect`, { rootPath: target === "create" ? draft.rootPath : editDraft.rootPath }),
    onSuccess: (result, target) => {
      const apply = (current: Draft) => ({ ...current, framework: result.detected, installCommand: result.suggestions.installCommand ?? "", buildCommand: result.suggestions.buildCommand ?? "", startCommand: result.suggestions.startCommand ?? "", outputDirectory: result.suggestions.outputDirectory ?? "" });
      if (target === "create") setDraft(apply);
      else setEditDraft(apply);
      setNotice(`${result.detected} detected: ${result.reason}`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Framework detection failed")
  });

  const action = useMutation({
    mutationFn: ({ deployment, name, approvedRuntimeTools = [] }: { deployment: Deployment; name: "deploy" | "start" | "stop" | "restart"; approvedRuntimeTools?: string[] }) => apiPost<QueueResponse>(`${apiBase}/${deployment.slug}/${name}`, { approvedRuntimeTools }),
    onSuccess: async (result, variables) => {
      setRuntimeModal(null);
      const queued = result.queue?.queued;
      const reason = result.queue?.reason ?? result.reason;
      const dryRun = result.queue?.dryRun ?? result.dryRun;
      const suffix = dryRun ? " (dry-run)" : "";

      if (queued === false) {
        setNotice(`${variables.name} recorded for ${variables.deployment.name}${suffix}: ${reason ?? "worker queue unavailable"}`);
      } else {
        setNotice(`${variables.name} requested for ${variables.deployment.name}${suffix}.`);
      }

      await invalidateDeployments();
      if (variables.name === "deploy") setActiveTab("overview");
    },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.status === 409) {
        const data = error.data as RuntimeReviewError | null;
        if (data?.runtimeReview) {
          const failed = data.install?.failed?.map((item) => item.tool).filter(Boolean).join(", ");
          const remaining = data.runtimeReview.missing.join(", ");
          setNotice(failed
            ? `Install did not finish for: ${failed}. Remaining missing tools: ${remaining || "unknown"}.`
            : `Deployment was not queued because required tools are still missing: ${remaining || "unknown"}. Click deploy again to review.`);
          return;
        }
      }
      setNotice(error instanceof Error ? error.message : "Action failed");
    }
  });

  const startDeploymentAction = async (deployment: Deployment, name: "deploy" | "start" | "stop" | "restart") => {
    if (name === "stop") {
      action.mutate({ deployment, name });
      return;
    }
    setNotice("Checking required server runtime packages...");
    try {
      const review = await apiGet<RuntimeReview>(`${apiBase}/${deployment.slug}/runtime-review`);
      if (!review.missing.length) {
        action.mutate({ deployment, name });
        return;
      }
      setRuntimeModal({
        deployment,
        action: name,
        review,
        selected: Object.fromEntries(review.installable.map((item) => [item.tool, true]))
      });
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not check runtime packages.");
    }
  };

  const continueRuntimeInstall = (modal: RuntimeModalState) => {
    const approvedRuntimeTools = Object.entries(modal.selected).filter(([, enabled]) => enabled).map(([tool]) => tool);
    setRuntimeModal(null);
    setNotice(`Installing selected packages for ${modal.deployment.name}, then starting ${modal.action}...`);
    action.mutate({
      deployment: modal.deployment,
      name: modal.action,
      approvedRuntimeTools
    });
  };

  const guardianFix = useMutation({
    mutationFn: (deployment: Deployment) => apiPost<any>(`${apiBase}/${deployment.slug}/doctor/repair`, { action: "auto" }),
    onSuccess: async (result, deployment) => {
      if (result?.approvalRequired) {
        setNotice(`Guardian prepared approval fixes for ${deployment.name}. Open project overview to approve risky actions.`);
      } else {
        setNotice(`Guardian fix requested for ${deployment.name}.`);
      }
      await invalidateDeployments();
      if (deployment.slug) await queryClient.invalidateQueries({ queryKey: ["deployment-doctor", deployment.slug] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Guardian fix failed")
  });

  const panelUpdate = useMutation({
    mutationFn: () => apiPost<{ pid?: number | null; queued?: boolean; message?: string }>("/guardian/panel-update/rebuild", {}),
    onSuccess: (result) => {
      const suffix = result?.pid ? ` PID ${result.pid}` : "";
      setNotice(`Panel update queued${suffix}. API/worker/sysagent will restart if the update script is configured.`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Panel update failed")
  });

  const toggleAutoDeploy = useMutation({
    mutationFn: (deployment: Deployment) => apiPatch<Deployment>(`${apiBase}/${deployment.slug}`, { autoDeployEnabled: !deployment.autoDeployEnabled }),
    onSuccess: async (deployment) => {
      setNotice(deployment.autoDeployEnabled ? `Auto deploy webhook configured for ${deployment.name}.` : `Auto deploy disabled for ${deployment.name}.`);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update auto deploy")
  });

  const rollbackRelease = useMutation({
    mutationFn: ({ deployment, releaseId }: { deployment: Deployment; releaseId: string }) => apiPost<QueueResponse>(`${apiBase}/${deployment.slug}/rollback`, { releaseId }),
    onSuccess: async (_result, variables) => {
      setNotice(`Rollback queued for ${variables.deployment.name}.`);
      setActiveTab("history");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not jump to release")
  });

  const openLogs = useMutation({
    mutationFn: async ({ deployment, type }: { deployment: Deployment; type: LogType }) => {
      const text = await apiGetText(`${apiBase}/${deployment.slug}/logs/export?${queryString({ type, limit: 500 })}`);
      return { deployment, text, type };
    },
    onSuccess: ({ deployment, text, type }) => {
      setLogTitle(`${deployment.name} ${type === "build" ? "build log" : "running log"}`);
      setLogType(type);
      setLogText(text);
      setLogModalOpen(true);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not load logs")
  });

  async function copyLogText() {
    try {
      await writeClipboardText(logText);
      setNotice("Logs copied. You can paste/share them now.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not copy logs");
      throw error;
    }
  }

  const saveGithubToken = useMutation({
    mutationFn: () => apiPut(`${githubApiBase}/connection`, { username: githubUsername || null, token: githubToken, scopes: [] }),
    onSuccess: async () => {
      setGithubToken("");
      setNotice("GitHub token connected. Repository list refreshed.");
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-connection"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-repos"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not connect GitHub token")
  });

  const selectGithubRepo = useMutation({
    mutationFn: async (repo: GithubRepo) => {
      const detection = await apiGet<GithubDetectResponse>(`${githubApiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/detect?${queryString({ branch: repo.defaultBranch, rootDirectory: draft.rootDirectory || "." })}`);
      const repoDraft = { ...draft, name: repo.name, slug: slugify(repo.name), githubOwner: repo.owner, githubRepo: repo.name, gitUrl: `https://github.com/${repo.fullName}.git`, branch: repo.defaultBranch, rootPath: deploymentRootForRepo(repo.name, rootBase), sourceProvider: "GITHUB" as const, framework: detection.detected, installCommand: detection.suggestions.installCommand ?? "", buildCommand: detection.suggestions.buildCommand ?? "", startCommand: detection.suggestions.startCommand ?? "", outputDirectory: detection.suggestions.outputDirectory ?? "", autoDeployEnabled: true };
      return { repoDraft, detection };
    },
    onSuccess: ({ repoDraft, detection }) => {
      if (editingOpen) {
        setEditDraft((current) => ({ ...current, ...repoDraft }));
      } else {
        setDraft((current) => ({ ...current, ...repoDraft }));
      }
      setSelectedRepo({ owner: repoDraft.githubOwner, name: repoDraft.githubRepo, fullName: `${repoDraft.githubOwner}/${repoDraft.githubRepo}`, private: false, defaultBranch: repoDraft.branch });
      setNotice(`Selected ${repoDraft.githubOwner}/${repoDraft.githubRepo}. ${detection.detected} detected. Review options and click ${editingOpen ? "Save changes" : "Create"}.`);
      setRepoPickerOpen(false);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not select repository")
  });

  const addDomain = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("Select a project first");
      const selectedIds = [...new Set(domainsToAdd)].filter(Boolean);
      if (selectedIds.length === 0) throw new Error("Select at least one domain");
      const results: DeploymentDomainBinding[] = [];
      for (const [index, domainId] of selectedIds.entries()) {
        results.push(await apiPost<DeploymentDomainBinding>(`${apiBase}/${selected.slug}/domains`, { domainId, primary: !selected.domainId && index === 0 }));
      }
      return results;
    },
    onSuccess: async () => {
      const count = domainsToAdd.length;
      setDomainsToAdd([]);
      setNotice(`${count} domain${count === 1 ? "" : "s"} added to project.`);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not add domain")
  });

  const setPrimaryDomain = useMutation({
    mutationFn: (binding: DeploymentDomainBinding) => apiPatch(`${apiBase}/${selected?.slug}/domains/${binding.domainId}/primary`, {}),
    onSuccess: async () => {
      setNotice("Primary domain updated.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update primary domain")
  });

  const removeDomain = useMutation({
    mutationFn: (binding: DeploymentDomainBinding) => apiDelete(`${apiBase}/${selected?.slug}/domains/${binding.domainId}`),
    onSuccess: async () => {
      setNotice("Domain removed.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not remove domain")
  });

  const saveEnv = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a project first");
      const key = envKey.trim().toUpperCase();
      if (!key) throw new Error("Enter an environment key");
      return apiPut<DeploymentEnvVar>(`${apiBase}/${selected.slug}/env/${encodeURIComponent(key)}`, { value: normalizeEnvValue(envValue), isSecret: envSecret });
    },
    onSuccess: async () => {
      setNotice(`${envKey.trim().toUpperCase()} saved.`);
      setEnvKey("");
      setEnvValue("");
      setEnvSecret(false);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save env")
  });

  const revealEnv = useMutation({
    mutationFn: async (key: string) => apiGet<{ key: string; value: string; isSecret: boolean }>(`${apiBase}/${selected!.slug}/env/${encodeURIComponent(key)}/reveal`),
    onSuccess: (result) => setRevealedEnvValues((current) => ({ ...current, [result.key]: result.value })),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not reveal env value")
  });
  const hideEnv = (key: string) => {
    setRevealedEnvValues((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const saveEnvLine = useMutation({
    mutationFn: ({ item, value }: { item: DeploymentEnvVar; value: string }) =>
      apiPut<DeploymentEnvVar>(`${apiBase}/${selected!.slug}/env/${encodeURIComponent(item.key)}`, { value: normalizeEnvValue(value), isSecret: item.isSecret }),
    onSuccess: async (item) => {
      setNotice(`${item.key} updated.`);
      setRevealedEnvValues((current) => {
        const next = { ...current };
        delete next[item.key];
        return next;
      });
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update env")
  });

  const removeEnv = useMutation({
    mutationFn: (key: string) => apiDelete(`${apiBase}/${selected?.slug}/env/${encodeURIComponent(key)}`),
    onSuccess: async () => {
      setNotice("Environment variable removed.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not remove env")
  });

  const removeBulkEnv = useMutation({
    mutationFn: async (keys: string[]) => {
      if (!selected) throw new Error("Select a project first");
      return apiPost<{ ok: true; removed: string[] }>(`${apiBase}/${selected.slug}/env/bulk-delete`, { keys });
    },
    onSuccess: async (result) => {
      setNotice(`${result.removed.length} environment variable(s) removed.`);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not remove selected env vars")
  });

  const clearDatabaseEnvOverrides = useMutation({
    mutationFn: () => apiPost<{ ok: true; removed: string[] }>(`${apiBase}/${selected!.slug}/env/clear-database-overrides`, {}),
    onSuccess: async (result) => {
      setNotice(
        result.removed.length
          ? `Removed ${result.removed.join(", ")}. Redeploy so the panel-managed database password is applied.`
          : "No manual database env overrides were stored in the panel."
      );
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not clear database env overrides")
  });

  const saveBulkEnv = useMutation({
    mutationFn: (textOverride?: string) => {
      if (!selected) throw new Error("Select a project first");
      const env = parseBulkEnvItems(textOverride ?? bulkEnvText, bulkEnvSecret);
      if (!env.length) throw new Error("Paste a JS object or KEY=value lines first");
      return apiPost<{ ok: true; items: DeploymentEnvVar[] }>(`${apiBase}/${selected.slug}/env/bulk`, { env });
    },
    onSuccess: async (result) => {
      setNotice(`${result.items.length} environment variables imported.`);
      setBulkEnvText("");
      setBulkEnvSecret(false);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import env block")
  });

  const deleteProject = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a project first");
      return apiDeleteBody(`${apiBase}/${selected.slug}`, { confirmSlug: deleteText });
    },
    onSuccess: async () => {
      setNotice("Project deleted.");
      setDeleteText("");
      setSelectedId(null);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete project")
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  function openEdit() {
    if (!selected) return;
    setEditDraft(draftFromDeployment(selected));
    setEditingOpen(true);
  }

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "domains", label: "Domains" },
    { key: "history", label: "Deploy History" },
    { key: "env", label: "Environment" },
    { key: "settings", label: "Settings" }
  ] as const;

  return (
    <section className="flex h-[calc(100vh-81px)] flex-col overflow-hidden bg-slate-50">
      <div className="flex items-center justify-end border-b border-panel-line bg-white px-6 py-3">
        <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" onClick={() => setCreateOpen(true)} type="button"><Plus size={16} />Create Project</button>
      </div>

      <div className="flex min-h-0 flex-1 gap-6 p-6">
        <aside className="flex w-[420px] min-h-0 flex-col rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line p-4">
            {notice ? <ResultNotice message={notice} ok={okNotice(notice)} /> : null}
            <form className="relative mt-3" onSubmit={submitSearch}>
              <Search className="absolute left-3 top-2.5 text-panel-muted" size={15} />
              <input className="h-9 w-full rounded-md border border-panel-line pl-9 pr-3 text-sm" onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search projects" value={draftSearch} />
            </form>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                <option value="">All status</option>
                {["QUEUED", "RUNNING", "STOPPED", "DEPLOYING", "BUILDING", "FAILED"].map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setSourceFilter(event.target.value)} value={sourceFilter}>
                <option value="">All sources</option>
                {sourceOptions.map((source) => <option key={source} value={source}>{source.replace("_", " ")}</option>)}
              </select>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {(deployments.data?.items ?? []).map((deployment) => <ProjectCard active={selected?.id === deployment.id} deployment={deployment} key={deployment.id} onSelect={() => { setSelectedId(deployment.id); setActiveTab("overview"); }} />)}
            {(deployments.data?.items ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No projects yet.</div> : null}
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden rounded-md border border-panel-line bg-white">
          {selected ? (
            <div className="flex h-full flex-col">
              <div className="border-b border-panel-line p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-xl font-semibold text-panel-ink">{selected.name}</h2>
                      {statusBadge(selected.status)}
                      {healthBadge(selected.healthStatus)}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-panel-muted">
                      <span>{selected.framework}</span>
                      <span>:{selected.port}</span>
                      <span className="truncate">{selected.rootPath}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {(["deploy", "start", "stop", "restart"] as const).map((name) => (
                      <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={action.isPending} key={name} onClick={() => startDeploymentAction(selected, name)} type="button">
                        {name === "deploy" ? <Play size={15} /> : name === "stop" ? <Square size={15} /> : actionIcon(name)}{name}
                      </button>
                    ))}
                    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={openLogs.isPending} onClick={() => openLogs.mutate({ deployment: selected, type: "build" })} type="button"><Clipboard size={15} />Build log</button>
                    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={openLogs.isPending} onClick={() => openLogs.mutate({ deployment: selected, type: "running" })} type="button"><Clipboard size={15} />Running log</button>
                    <button className="flex h-9 items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 text-sm font-semibold text-sky-700 hover:bg-sky-100 disabled:opacity-50" disabled={guardianFix.isPending} onClick={() => guardianFix.mutate(selected)} type="button"><ShieldCheck size={15} />Guardian fix</button>
                    {showPanelUpdate ? <button className="flex h-9 items-center gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 text-sm font-semibold text-violet-700 hover:bg-violet-100 disabled:opacity-50" disabled={panelUpdate.isPending} onClick={() => panelUpdate.mutate()} type="button"><Rocket size={15} />Update panel</button> : null}
                    <button
                      className={`flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium disabled:opacity-50 ${selected.autoDeployEnabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-panel-line text-panel-muted hover:bg-slate-50"}`}
                      disabled={toggleAutoDeploy.isPending}
                      onClick={() => toggleAutoDeploy.mutate(selected)}
                      type="button"
                    >
                      {selected.autoDeployEnabled ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                      Auto deploy {selected.autoDeployEnabled ? "on" : "enable"}
                    </button>
                    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={openEdit} type="button"><Pencil size={15} />Edit</button>
                  </div>
                </div>
                <div className="mt-5 flex gap-1">
                  {tabs.map((tab) => <button className={`h-9 rounded-md px-3 text-sm font-medium ${activeTab === tab.key ? "bg-slate-900 text-white" : "text-panel-muted hover:bg-slate-50 hover:text-panel-ink"}`} key={tab.key} onClick={() => setActiveTab(tab.key)} type="button">{tab.label}</button>)}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-5">
                {activeTab === "overview" ? <OverviewPanel deployment={selected} /> : null}
                {activeTab === "domains" ? <DomainsPanel deployment={selected} domains={domainOptions(domains.data?.items ?? [])} domainsToAdd={domainsToAdd} setDomainsToAdd={setDomainsToAdd} addDomain={() => addDomain.mutate()} addingDomain={addDomain.isPending} setPrimary={(binding) => setPrimaryDomain.mutate(binding)} removeDomain={(binding) => removeDomain.mutate(binding)} /> : null}
                {activeTab === "history" ? <HistoryPanel deployment={selected} releases={releases.data ?? selected.releases ?? []} loading={releases.isLoading} onRefresh={() => releases.refetch()} onJump={(release) => rollbackRelease.mutate({ deployment: selected, releaseId: release.id })} jumping={rollbackRelease.isPending} /> : null}
                {activeTab === "env" ? <EnvPanel deployment={selected} envKey={envKey} envValue={envValue} envSecret={envSecret} bulkEnvText={bulkEnvText} bulkEnvSecret={bulkEnvSecret} revealedValues={revealedEnvValues} revealingKey={revealEnv.variables} savingLineKey={saveEnvLine.variables?.item.key} setEnvKey={setEnvKey} setEnvValue={setEnvValue} setEnvSecret={setEnvSecret} setBulkEnvText={setBulkEnvText} setBulkEnvSecret={setBulkEnvSecret} saveEnv={(onSuccess) => saveEnv.mutate(undefined, { onSuccess })} saveBulkEnv={(onSuccess) => saveBulkEnv.mutate(undefined, { onSuccess })} saveRawEnv={(text, onSuccess) => saveBulkEnv.mutate(text, { onSuccess })} savingEnv={saveEnv.isPending} savingBulkEnv={saveBulkEnv.isPending} revealEnv={(key) => revealEnv.mutate(key)} hideEnv={hideEnv} saveEnvLine={(item, value) => saveEnvLine.mutate({ item, value })} removeEnv={(key) => removeEnv.mutate(key)} removeBulkEnv={(keys) => removeBulkEnv.mutate(keys)} removingBulkEnv={removeBulkEnv.isPending} clearDatabaseEnvOverrides={() => clearDatabaseEnvOverrides.mutate()} clearingDatabaseEnvOverrides={clearDatabaseEnvOverrides.isPending} /> : null}
                {activeTab === "settings" ? <SettingsPanel deployment={selected} deleteText={deleteText} setDeleteText={setDeleteText} onEdit={openEdit} onDelete={() => deleteProject.mutate()} deleting={deleteProject.isPending} /> : null}
              </div>
            </div>
          ) : <div className="p-10 text-center text-sm text-panel-muted">Select or create a project.</div>}
        </main>
      </div>

      {createOpen ? <ProjectModal title="Create Project" draft={draft} setDraft={setDraft} domains={domainOptions(domains.data?.items ?? [])} databaseOverview={databaseOverview.data} notice={notice} onClose={() => setCreateOpen(false)} onDetect={() => detect.mutate("create")} onSubmit={() => createDeployment.mutate()} submitLabel="Create" busy={createDeployment.isPending} openGithub={() => enableGithub ? setRepoPickerOpen(true) : undefined} enableGithub={enableGithub} /> : null}
      {editingOpen ? <ProjectModal title="Edit Project" draft={editDraft} setDraft={setEditDraft} domains={domainOptions(domains.data?.items ?? [])} databaseOverview={databaseOverview.data} notice={notice} onClose={() => setEditingOpen(false)} onDetect={() => detect.mutate("edit")} onSubmit={() => updateDeployment.mutate()} submitLabel="Save changes" busy={updateDeployment.isPending} openGithub={() => enableGithub ? setRepoPickerOpen(true) : undefined} enableGithub={enableGithub} /> : null}
      {enableGithub && repoPickerOpen ? <GithubModal repos={repos.data} loading={repos.isLoading} repoSearch={repoSearch} setRepoSearch={setRepoSearch} connection={githubConnection.data} githubToken={githubToken} setGithubToken={setGithubToken} githubUsername={githubUsername} setGithubUsername={setGithubUsername} saveToken={() => saveGithubToken.mutate()} savingToken={saveGithubToken.isPending} onClose={() => setRepoPickerOpen(false)} onDeploy={(repo) => selectGithubRepo.mutate(repo)} deploying={selectGithubRepo.isPending} /> : null}
      {logModalOpen ? <LogsModal title={logTitle} type={logType} text={logText} onCopy={copyLogText} onClose={() => setLogModalOpen(false)} /> : null}
      {runtimeModal ? (
        <RuntimeInstallModal
          busy={action.isPending}
          modal={runtimeModal}
          onChange={setRuntimeModal}
          onClose={() => setRuntimeModal(null)}
          onContinue={() => continueRuntimeInstall(runtimeModal)}
        />
      ) : null}
    </section>
  );
}

function ProjectCard({ deployment, active, onSelect }: { deployment: Deployment; active: boolean; onSelect: () => void }) {
  const latest = deployment.releases?.[0];
  const domains = deployment.domainBindings?.map((binding) => {
    const name = deploymentBindingName(binding);
    return name ? { id: binding.id, name } : null;
  }).filter((item): item is { id: string; name: string } => Boolean(item)) ?? [];
  const fallbackDomain = deployment.domain?.name ? [{ id: deployment.domain.id, name: deployment.domain.name }] : [];
  const linkedDomains = domains.length ? domains : fallbackDomain;
  return (
    <div className={`mb-3 w-full cursor-pointer rounded-md border p-4 text-left transition ${active ? "border-panel-accent bg-teal-50" : "border-panel-line bg-white hover:bg-slate-50"}`} onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(); }} role="button" tabIndex={0}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-panel-ink">{deployment.name}</div>
          <div className="mt-1 flex items-center gap-2 text-xs text-panel-muted">{deployment.sourceProvider === "GITHUB" ? <Github size={13} /> : <FolderGit2 size={13} />} {deployment.branch}</div>
        </div>
        {statusBadge(deployment.status)}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <span className="rounded bg-slate-100 px-2 py-1 font-semibold">{deployment.framework}</span>
        <span className="rounded bg-slate-100 px-2 py-1">:{deployment.port}</span>
        <span className="rounded bg-slate-100 px-2 py-1">{latest?.status ?? "No release"}</span>
      </div>
      <div className="mt-3 truncate text-xs text-panel-muted">
        {linkedDomains.length ? linkedDomains.map((domain, index) => (
          <span key={domain.id}>
            {index > 0 ? ", " : null}
            <a className="font-medium text-panel-accent underline-offset-2 hover:underline" href={`https://${domain.name}`} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank">{domain.name}</a>
          </span>
        )) : deployment.rootPath}
      </div>
    </div>
  );
}

function deploymentBindingName(binding: DeploymentDomainBinding) {
  return binding.subdomain ? `${binding.subdomain.name}.${binding.subdomain.domain.name}` : binding.domain?.name ?? "";
}

function ProjectModal({ title, draft, setDraft, domains, databaseOverview, notice, onClose, onDetect, onSubmit, submitLabel, busy, openGithub, enableGithub = true }: { title: string; draft: Draft; setDraft: (draft: Draft) => void; domains: DomainOption[]; databaseOverview?: DatabaseOverview; notice?: string; onClose: () => void; onDetect: () => void; onSubmit: () => void; submitLabel: string; busy?: boolean; openGithub: () => void; enableGithub?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-panel-line p-4"><div className="text-sm font-semibold">{title}</div><button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button"><X size={16} /></button></div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {notice ? <ResultNotice message={notice} ok={okNotice(notice)} /> : null}
          <div className="grid grid-cols-4 gap-2">{sourceOptions.map((source) => <button className={`h-9 rounded-md border text-xs font-semibold ${draft.sourceProvider === source ? "border-panel-accent bg-teal-50 text-panel-accent" : "border-panel-line"}`} key={source} onClick={() => { setDraft({ ...draft, sourceProvider: source }); if (source === "GITHUB") openGithub(); }} type="button">{source.replace("_", " ")}</button>)}</div>
          {enableGithub && draft.sourceProvider === "GITHUB" ? <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50" onClick={openGithub} type="button"><Github size={15} />Choose GitHub project</button> : null}
          <DeploymentFormFields value={draft} onChange={setDraft} domains={domains} databaseOverview={databaseOverview} />
        </div>
        <div className="flex justify-between border-t border-panel-line p-4"><button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm" onClick={onDetect} type="button"><Wand2 size={15} />Detect</button><div className="flex gap-2"><button className="h-9 rounded-md border border-panel-line px-3 text-sm" onClick={onClose} type="button">Cancel</button><button className="h-9 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.name || !draft.rootPath || !draft.port || busy} onClick={onSubmit} type="button">{submitLabel}</button></div></div>
      </div>
    </div>
  );
}

function DeploymentFormFields({ value, onChange, domains, databaseOverview }: { value: Draft; onChange: (next: Draft) => void; domains: DomainOption[]; databaseOverview?: DatabaseOverview }) {
  const selectedDatabaseEngine = databaseOverview?.engines.find((engine) => engine.engine === value.dbType);
  const selectedDatabaseRecord = selectedDatabaseEngine?.databases.find((database) => database.name === value.dbName);
  const databaseUsers = selectedDatabaseEngine?.users ?? [];
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3"><Input label="Project name" value={value.name} onChange={(name) => onChange({ ...value, name, slug: value.slug || slugify(name) })} /><Input label="Slug" value={value.slug} onChange={(slug) => onChange({ ...value, slug })} /></div>
    <label className="space-y-1 text-xs font-medium text-panel-muted">Primary domain<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, domainId: event.target.value })} value={value.domainId}><option value="">No domain</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
    <div className="grid grid-cols-2 gap-3"><Input label="Git URL" value={value.gitUrl} onChange={(gitUrl) => onChange({ ...value, gitUrl })} /><Input label="Branch" value={value.branch} onChange={(branch) => onChange({ ...value, branch })} /></div>
    <Input label="App root path" value={value.rootPath} onChange={(rootPath) => onChange({ ...value, rootPath })} />
    <div className="grid grid-cols-3 gap-3"><label className="space-y-1 text-xs font-medium text-panel-muted">Framework<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, framework: event.target.value as DeploymentFramework })} value={value.framework}>{frameworkOptions.map((framework) => <option key={framework} value={framework}>{framework}</option>)}</select></label><Input label="Port (auto)" readOnly value={value.port} onChange={(port) => onChange({ ...value, port })} /><label className="space-y-1 text-xs font-medium text-panel-muted">Database<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, dbType: event.target.value as Draft["dbType"], dbName: "", dbUser: "" })} value={value.dbType}><option value="">None</option><option value="POSTGRESQL">PostgreSQL</option><option value="MYSQL">MySQL</option></select></label></div>
    {value.dbType ? <div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-xs font-medium text-panel-muted">Existing database<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => { const nextName = event.target.value; const nextRecord = selectedDatabaseEngine?.databases.find((database) => database.name === nextName); onChange({ ...value, dbName: nextName, dbUser: value.dbUser || nextRecord?.owner || "" }); }} value={value.dbName}><option value="">Select existing database</option>{(selectedDatabaseEngine?.databases ?? []).map((database) => <option key={database.name} value={database.name}>{database.name}</option>)}</select></label><label className="space-y-1 text-xs font-medium text-panel-muted">Database user<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, dbUser: event.target.value })} value={value.dbUser}><option value="">{selectedDatabaseRecord?.owner ? "Use detected owner" : "Select database user"}</option>{databaseUsers.map((user) => <option key={`${user.name}:${user.host ?? "local"}`} value={user.name}>{user.name}{user.host ? ` @ ${user.host}` : ""}</option>)}</select></label></div> : null}
    {value.dbType ? <div className="grid grid-cols-2 gap-3"><Input label="Database name" value={value.dbName} onChange={(dbName) => onChange({ ...value, dbName })} /><Input label="Database user" value={value.dbUser} onChange={(dbUser) => onChange({ ...value, dbUser })} /></div> : null}
    <label className="flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium text-panel-ink"><input checked={value.autoDeployEnabled} onChange={(event) => onChange({ ...value, autoDeployEnabled: event.target.checked })} type="checkbox" /> Auto deploy on GitHub push</label>
    {(["installCommand", "buildCommand", "startCommand", "outputDirectory"] as const).map((field) => <input className="h-9 w-full rounded-md border border-panel-line px-3 font-mono text-xs" key={field} onChange={(event) => onChange({ ...value, [field]: event.target.value })} placeholder={field} value={value[field]} />)}
    <textarea className="h-28 w-full rounded-md border border-panel-line p-3 font-mono text-xs" onChange={(event) => onChange({ ...value, envText: event.target.value })} value={value.envText} />
  </div>;
}

function Input({ label, value, onChange, readOnly }: { label: string; value: string; onChange: (value: string) => void; readOnly?: boolean }) {
  return <label className="space-y-1 text-xs font-medium text-panel-muted">{label}<input className={`h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink ${readOnly ? "bg-slate-50 text-panel-muted" : ""}`} onChange={(event) => onChange(event.target.value)} readOnly={readOnly} value={value} /></label>;
}

function OverviewPanel({ deployment }: { deployment: Deployment }) {
  const latest = deployment.releases?.[0];
  const metrics = useQuery({
    queryKey: ["deployment-metrics", deployment.id],
    queryFn: () => apiGet<DeploymentMetrics>(`/deployments/${deployment.id}/metrics`),
    refetchInterval: 15000
  });
  const data = metrics.data;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        <Metric label="Source" value={deployment.sourceProvider} />
        <Metric label="Branch" value={deployment.branch} />
        <Metric label="Latest release" value={latest?.status ?? "No release"} />
        <Metric label="Updated" value={formatDate(deployment.updatedAt)} />
      </div>
      <div className="grid gap-3 lg:grid-cols-4">
        <UsageMetric icon={<MemoryStick size={16} />} label="RAM" value={metrics.isLoading ? "Loading..." : formatBytes(data?.process.memoryBytes ?? 0)} detail={`${data?.process.processCount ?? 0} processes`} />
        <UsageMetric icon={<Cpu size={16} />} label="CPU" value={`${(data?.process.cpuPercent ?? 0).toFixed(1)}%`} detail="live process usage" />
        <UsageMetric icon={<HardDrive size={16} />} label="Storage" value={formatBytes(data?.storage.bytes ?? 0)} detail={data?.storage.rootPath ?? deployment.rootPath} />
        <UsageMetric icon={<Database size={16} />} label="DB storage" value={formatBytes(data?.database.sizeBytes ?? 0)} detail={data?.database.name ?? "No database"} />
        <UsageMetric icon={<ArrowDownToLine size={16} />} label="Incoming traffic" value={formatBytes(data?.traffic.incomingBytes ?? 0)} detail="last 24h" />
        <UsageMetric icon={<ArrowUpFromLine size={16} />} label="Outgoing traffic" value={formatBytes(data?.traffic.outgoingBytes ?? 0)} detail={`${data?.traffic.requests ?? 0} requests`} />
        <UsageMetric icon={<Network size={16} />} label="Bandwidth" value={formatBytes(data?.traffic.bandwidthBytes ?? 0)} detail={data?.traffic.note ?? "last 24h"} />
        <UsageMetric icon={<Activity size={16} />} label="Metrics" value={data?.ok === false ? "Unavailable" : "Live"} detail={data?.generatedAt ? formatDate(data.generatedAt) : "-"} />
      </div>
      <ResourceHistory metrics={data} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-panel-line p-4"><div className="text-xs uppercase text-panel-muted">{label}</div><div className="mt-3 truncate text-sm font-semibold">{value}</div></div>;
}

function UsageMetric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-panel-line bg-white p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-panel-muted">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-3 truncate text-xl font-semibold text-panel-ink">{value}</div>
      <div className="mt-1 truncate text-xs text-panel-muted" title={typeof detail === "string" ? detail : undefined}>{detail}</div>
    </div>
  );
}

function ResourceHistory({ metrics }: { metrics?: DeploymentMetrics }) {
  const history = metrics?.history ?? [];
  return (
    <div className="rounded-md border border-panel-line bg-white">
      <div className="flex items-center justify-between border-b border-panel-line p-4">
        <div className="text-sm font-semibold">Last 24h Resource Usage</div>
        <span className="text-xs text-panel-muted">{history.length} samples</span>
      </div>
      <div className="grid gap-0 lg:grid-cols-2">
        <UsageTrend title="RAM" unit="bytes" values={history.map((sample) => ({ timestamp: sample.timestamp, value: sample.memoryBytes }))} />
        <UsageTrend title="CPU" unit="percent" values={history.map((sample) => ({ timestamp: sample.timestamp, value: sample.cpuPercent }))} />
      </div>
    </div>
  );
}

function UsageTrend({ title, unit, values }: { title: string; unit: "bytes" | "percent"; values: Array<{ timestamp: string; value: number }> }) {
  const recent = values.slice(-96);
  const current = recent.at(-1)?.value ?? 0;
  const peak = recent.reduce((max, item) => Math.max(max, item.value), 0);
  const average = recent.length ? recent.reduce((total, item) => total + item.value, 0) / recent.length : 0;
  const scale = Math.max(peak, unit === "percent" ? 100 : 1);
  return (
    <div className="min-w-0 border-b border-panel-line p-4 last:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase text-panel-muted">{title}</div>
        <div className="text-xs text-panel-muted">last 24h</div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <TrendStat label="Now" value={formatMetricValue(current, unit)} />
        <TrendStat label="Peak" value={formatMetricValue(peak, unit)} />
        <TrendStat label="Avg" value={formatMetricValue(average, unit)} />
      </div>
      <div className="mt-4 flex h-24 items-end gap-1 overflow-hidden rounded-md border border-panel-line bg-slate-50 px-2 py-2">
        {recent.length ? recent.map((item, index) => (
          <div
            className="min-w-[3px] flex-1 rounded-t bg-panel-accent"
            key={`${item.timestamp}-${index}`}
            style={{ height: `${Math.max(4, Math.min(100, (item.value / scale) * 100))}%` }}
            title={`${formatDate(item.timestamp)}: ${formatMetricValue(item.value, unit)}`}
          />
        )) : <div className="flex h-full w-full items-center justify-center text-xs text-panel-muted">Resource samples will appear after the next refresh.</div>}
      </div>
    </div>
  );
}

function TrendStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-2">
      <div className="text-[10px] uppercase text-panel-muted">{label}</div>
      <div className="mt-1 truncate font-semibold text-panel-ink">{value}</div>
    </div>
  );
}

function formatMetricValue(value: number, unit: "bytes" | "percent") {
  if (unit === "bytes") return formatBytes(value);
  return `${Number.isFinite(value) ? value.toFixed(1) : "0.0"}%`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function DomainsPanel({ deployment, domains, domainsToAdd, setDomainsToAdd, addDomain, addingDomain, setPrimary, removeDomain }: { deployment: Deployment; domains: DomainOption[]; domainsToAdd: string[]; setDomainsToAdd: (ids: string[]) => void; addDomain: () => void; addingDomain?: boolean; setPrimary: (binding: DeploymentDomainBinding) => void; removeDomain: (binding: DeploymentDomainBinding) => void }) {
  const boundIds = new Set(
    (deployment.domainBindings ?? [])
      .flatMap((binding) => [binding.domainId, binding.subdomainId ? `subdomain:${binding.subdomainId}` : null])
      .filter(Boolean) as string[]
  );
  const availableDomains = domains.filter((domain) => !boundIds.has(domain.id));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <DomainMultiSelect options={availableDomains} selectedIds={domainsToAdd} onChange={setDomainsToAdd} />
        <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={domainsToAdd.length === 0 || addingDomain} onClick={addDomain} type="button">
          <Plus size={15} />
          Add {domainsToAdd.length > 1 ? `${domainsToAdd.length} domains` : "domain"}
        </button>
      </div>
      <div className="overflow-hidden rounded-md border border-panel-line">
        {(deployment.domainBindings ?? []).map((binding) => (
          <div className="flex items-center justify-between border-b border-panel-line p-3 last:border-b-0" key={binding.id}>
            <div>
              <div className="font-semibold">{deploymentBindingName(binding)}</div>
              <div className="text-xs text-panel-muted">{binding.role}</div>
            </div>
            <div className="flex gap-2">
              <button className="h-8 rounded-md border border-panel-line px-2 text-xs" disabled={binding.role === "primary"} onClick={() => setPrimary(binding)} type="button">Make primary</button>
              <button className="h-8 rounded-md border border-panel-line px-2 text-xs text-panel-danger" onClick={() => removeDomain(binding)} type="button">Remove</button>
            </div>
          </div>
        ))}
        {(deployment.domainBindings ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No domains attached.</div> : null}
      </div>
    </div>
  );
}

function DomainMultiSelect({ options, selectedIds, onChange }: { options: DomainOption[]; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = new Set(selectedIds);
  const filteredOptions = options.filter((option) => option.name.toLowerCase().includes(search.trim().toLowerCase()));
  const allFilteredSelected = filteredOptions.length > 0 && filteredOptions.every((option) => selected.has(option.id));
  const buttonLabel = selectedIds.length === 0
    ? "Select domains"
    : selectedIds.length === 1
      ? options.find((option) => option.id === selectedIds[0])?.name ?? "1 selected"
      : `${selectedIds.length} domains selected`;

  useEffect(() => {
    function closeOnOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, []);

  function toggle(id: string) {
    onChange(selected.has(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]);
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      const filteredIds = new Set(filteredOptions.map((option) => option.id));
      onChange(selectedIds.filter((id) => !filteredIds.has(id)));
      return;
    }
    onChange([...new Set([...selectedIds, ...filteredOptions.map((option) => option.id)])]);
  }

  return (
    <div className="relative min-w-80" ref={rootRef}>
      <button className="flex h-10 w-full items-center justify-between rounded-md border border-panel-line bg-white px-3 text-left text-sm hover:bg-slate-50" onClick={() => setOpen((current) => !current)} type="button">
        <span className={selectedIds.length ? "truncate font-medium text-panel-ink" : "truncate text-panel-muted"}>{buttonLabel}</span>
        <span className="text-xs text-panel-muted">{options.length}</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-12 z-30 w-[26rem] overflow-hidden rounded-md border border-panel-line bg-white shadow-xl">
          <div className="border-b border-panel-line p-2">
            <div className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-2">
              <Search size={15} className="text-panel-muted" />
              <input className="h-full min-w-0 flex-1 text-sm outline-none" onChange={(event) => setSearch(event.target.value)} placeholder="Search domains" value={search} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button className="h-8 rounded-md border border-panel-line px-2 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={filteredOptions.length === 0} onClick={toggleAllFiltered} type="button">{allFilteredSelected ? "Clear shown" : "Select all"}</button>
              <button className="h-8 rounded-md border border-panel-line px-2 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={selectedIds.length === 0} onClick={() => onChange([])} type="button">Clear all</button>
            </div>
          </div>
          <div className="max-h-80 overflow-auto p-1">
            {filteredOptions.map((option) => {
              const checked = selected.has(option.id);
              return (
                <button className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-slate-50 ${checked ? "bg-emerald-50 text-emerald-800" : "text-panel-ink"}`} key={option.id} onClick={() => toggle(option.id)} type="button">
                  {checked ? <CheckCircle2 size={16} /> : <Square size={16} className="text-panel-muted" />}
                  <span className="truncate">{option.name}</span>
                </button>
              );
            })}
            {filteredOptions.length === 0 ? <div className="px-3 py-8 text-center text-sm text-panel-muted">No domains found.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function HistoryPanel({ deployment, releases, loading, jumping, onRefresh, onJump }: { deployment: Deployment; releases: DeploymentRelease[]; loading?: boolean; jumping?: boolean; onRefresh: () => void; onJump: (release: DeploymentRelease) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border border-panel-line bg-slate-50 p-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold"><History size={16} />Deploy History</div>
          <div className="mt-1 text-xs text-panel-muted">Project wise releases for {deployment.name}. Jump queues rollback to the selected older deploy.</div>
        </div>
        <button className="h-9 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50" onClick={onRefresh} type="button">Refresh</button>
      </div>
      <div className="overflow-hidden rounded-md border border-panel-line">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-panel-muted">
            <tr>
              <th className="px-4 py-3">Release</th>
              <th className="px-4 py-3">Commit</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Finished</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr className="border-t border-panel-line" key={release.id}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">{statusBadge(release.status)}<span className="font-mono text-xs text-panel-muted">{release.id.slice(-8)}</span></div>
                  {release.commitAuthor ? <div className="mt-1 text-xs text-panel-muted">{release.commitAuthor}</div> : null}
                </td>
                <td className="max-w-md px-4 py-3">
                  <div className="font-mono text-xs font-semibold">{release.commitSha ? release.commitSha.slice(0, 12) : "-"}</div>
                  {release.commitMessage ? <div className="mt-1 truncate text-xs text-panel-muted">{release.commitMessage}</div> : null}
                </td>
                <td className="px-4 py-3 text-xs text-panel-muted">{formatDate(release.startedAt ?? release.createdAt)}</td>
                <td className="px-4 py-3 text-xs text-panel-muted">{formatDate(release.finishedAt)}</td>
                <td className="px-4 py-3 text-xs text-panel-muted">{release.durationMs ? `${Math.round(release.durationMs / 1000)}s` : "-"}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end">
                    <button className="h-8 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={jumping || release.status !== "SUCCEEDED"} onClick={() => onJump(release)} type="button">
                      Jump
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading ? <div className="p-8 text-center text-sm text-panel-muted">Loading history...</div> : null}
        {!loading && releases.length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No deploy history yet.</div> : null}
      </div>
    </div>
  );
}

function EnvPanel({
  deployment,
  envKey,
  envValue,
  envSecret,
  bulkEnvText,
  bulkEnvSecret,
  revealedValues,
  revealingKey,
  savingLineKey,
  setEnvKey,
  setEnvValue,
  setEnvSecret,
  setBulkEnvText,
  setBulkEnvSecret,
  saveEnv,
  saveBulkEnv,
  saveRawEnv,
  revealEnv,
  hideEnv,
  saveEnvLine,
  savingEnv,
  savingBulkEnv,
  removeEnv,
  removeBulkEnv,
  removingBulkEnv,
  clearDatabaseEnvOverrides,
  clearingDatabaseEnvOverrides
}: {
  deployment: Deployment;
  envKey: string;
  envValue: string;
  envSecret: boolean;
  bulkEnvText: string;
  bulkEnvSecret: boolean;
  revealedValues: Record<string, string>;
  revealingKey?: string;
  savingLineKey?: string;
  setEnvKey: (value: string) => void;
  setEnvValue: (value: string) => void;
  setEnvSecret: (value: boolean) => void;
  setBulkEnvText: (value: string) => void;
  setBulkEnvSecret: (value: boolean) => void;
  saveEnv: (onSuccess?: () => void) => void;
  saveBulkEnv: (onSuccess?: () => void) => void;
  saveRawEnv: (text: string, onSuccess?: () => void) => void;
  revealEnv: (key: string) => void;
  hideEnv: (key: string) => void;
  saveEnvLine: (item: DeploymentEnvVar, value: string) => void;
  savingEnv?: boolean;
  savingBulkEnv?: boolean;
  removeEnv: (key: string) => void;
  removeBulkEnv: (keys: string[]) => void;
  removingBulkEnv?: boolean;
  clearDatabaseEnvOverrides: () => void;
  clearingDatabaseEnvOverrides?: boolean;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const envCount = (deployment.env ?? []).length;

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <button
          className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-4 text-sm font-semibold text-panel-ink hover:bg-slate-50"
          onClick={() => setListOpen(true)}
          type="button"
        >
          <List size={16} />
          List
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-panel-muted">{envCount}</span>
        </button>
        <button
          className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white"
          onClick={() => setAddOpen(true)}
          type="button"
        >
          <Plus size={16} />
          Env add
        </button>
      </div>

      {listOpen ? (
        <EnvListModal
          deployment={deployment}
          clearingDatabaseEnvOverrides={clearingDatabaseEnvOverrides}
          clearDatabaseEnvOverrides={clearDatabaseEnvOverrides}
          onClose={() => setListOpen(false)}
          revealedValues={revealedValues}
          revealingKey={revealingKey}
          removeEnv={removeEnv}
          removeBulkEnv={removeBulkEnv}
          removingBulkEnv={removingBulkEnv}
          saveRawEnv={saveRawEnv}
          savingBulkEnv={savingBulkEnv}
          saveEnvLine={saveEnvLine}
          savingLineKey={savingLineKey}
          hideEnv={hideEnv}
          revealEnv={revealEnv}
        />
      ) : null}

      {addOpen ? (
        <EnvAddModal
          bulkEnvSecret={bulkEnvSecret}
          bulkEnvText={bulkEnvText}
          envKey={envKey}
          envSecret={envSecret}
          envValue={envValue}
          onClose={() => setAddOpen(false)}
          saveBulkEnv={saveBulkEnv}
          saveEnv={saveEnv}
          savingBulkEnv={savingBulkEnv}
          savingEnv={savingEnv}
          setBulkEnvSecret={setBulkEnvSecret}
          setBulkEnvText={setBulkEnvText}
          setEnvKey={setEnvKey}
          setEnvSecret={setEnvSecret}
          setEnvValue={setEnvValue}
        />
      ) : null}
    </>
  );
}

function EnvListModal({
  deployment,
  onClose,
  removeEnv,
  removeBulkEnv,
  removingBulkEnv,
  saveRawEnv,
  savingBulkEnv,
  revealEnv,
  hideEnv,
  saveEnvLine,
  revealedValues,
  revealingKey,
  savingLineKey,
  clearDatabaseEnvOverrides,
  clearingDatabaseEnvOverrides
}: {
  deployment: Deployment;
  onClose: () => void;
  removeEnv: (key: string) => void;
  removeBulkEnv: (keys: string[]) => void;
  removingBulkEnv?: boolean;
  saveRawEnv: (text: string, onSuccess?: () => void) => void;
  savingBulkEnv?: boolean;
  revealEnv: (key: string) => void;
  hideEnv: (key: string) => void;
  saveEnvLine: (item: DeploymentEnvVar, value: string) => void;
  revealedValues: Record<string, string>;
  revealingKey?: string;
  savingLineKey?: string;
  clearDatabaseEnvOverrides: () => void;
  clearingDatabaseEnvOverrides?: boolean;
}) {
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"form" | "raw">("form");
  const [rawText, setRawText] = useState("");
  const [rawDirty, setRawDirty] = useState(false);
  const envItems = deployment.env ?? [];
  const hiddenSecretMarker = "__HIDDEN_SECRET_VALUE__";
  const envValueFor = (item: DeploymentEnvVar) => draftValues[item.key] ?? revealedValues[item.key] ?? item.value ?? "";
  const rawValueFor = (item: DeploymentEnvVar) => item.isSecret && revealedValues[item.key] === undefined && item.value === null ? hiddenSecretMarker : envValueFor(item);
  const envToText = (items: DeploymentEnvVar[]) => items.map((item) => `${item.key}=${rawValueFor(item)}`).join("\n");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredEnvItems = normalizedQuery
    ? envItems.filter((item) => item.key.toLowerCase().includes(normalizedQuery) || envValueFor(item).toLowerCase().includes(normalizedQuery))
    : envItems;
  const hasDatabaseOverrides = envItems.some(
    (item) => item.key === "DB_PASSWORD" || item.key === "DATABASE_URL"
  );
  const allSelected = filteredEnvItems.length > 0 && filteredEnvItems.every((item) => selectedKeys.has(item.key));
  const someSelected = selectedKeys.size > 0;

  useEffect(() => {
    setSelectedKeys(new Set());
  }, [deployment.id, envItems.length]);

  useEffect(() => {
    if (!rawDirty) setRawText(envToText(envItems));
  }, [deployment.id, envItems, revealedValues, rawDirty]);

  const toggleKey = (key: string, checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const item of filteredEnvItems) {
        if (checked) next.add(item.key);
        else next.delete(item.key);
      }
      return next;
    });
  };

  const deleteSelected = () => {
    const keys = [...selectedKeys];
    if (!keys.length) return;
    const message = keys.length === 1
      ? `Delete environment variable ${keys[0]}?`
      : `Delete ${keys.length} environment variables?`;
    if (!window.confirm(message)) return;
    removeBulkEnv(keys);
  };

  const saveRawText = () => {
    if (rawText.includes(hiddenSecretMarker)) {
      window.alert("Raw text contains hidden secret placeholders. Reveal those secret values first, or save them individually in form view.");
      return;
    }
    saveRawEnv(rawText, () => setRawDirty(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-panel-ink">
            <List size={17} />
            Environment variables
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-panel-muted" size={14} />
              <input
                className="h-8 w-56 rounded-md border border-panel-line pl-8 pr-2 text-xs"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search env"
                value={query}
              />
            </div>
            <button
              className="inline-flex h-8 items-center gap-1 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50"
              onClick={() => {
                if (viewMode === "form") {
                  setRawText(envToText(envItems));
                  setRawDirty(false);
                  setViewMode("raw");
                } else {
                  setViewMode("form");
                }
              }}
              type="button"
            >
              {viewMode === "form" ? "Text view" : "Form view"}
            </button>
            {envItems.length > 0 ? (
              <>
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-panel-muted">
                  <input
                    aria-label="Select all environment variables"
                    checked={allSelected}
                    className="h-4 w-4 rounded border-panel-line"
                    onChange={(event) => toggleAll(event.target.checked)}
                    type="checkbox"
                  />
                  Select all
                </label>
                <button
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-panel-line px-3 text-xs font-semibold text-panel-danger hover:bg-red-50 disabled:opacity-50"
                  disabled={!someSelected || removingBulkEnv}
                  onClick={deleteSelected}
                  type="button"
                >
                  <Trash2 size={13} />
                  {removingBulkEnv ? "Deleting..." : `Delete selected (${selectedKeys.size})`}
                </button>
              </>
            ) : null}
            <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {deployment.dbType && hasDatabaseOverrides ? (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="text-xs leading-5 text-amber-900">
                Clear manual <span className="font-mono">DB_PASSWORD</span> / <span className="font-mono">DATABASE_URL</span>, then redeploy.
              </p>
              <button
                className="mt-3 h-8 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold disabled:opacity-60"
                disabled={clearingDatabaseEnvOverrides}
                onClick={clearDatabaseEnvOverrides}
                type="button"
              >
                {clearingDatabaseEnvOverrides ? "Clearing..." : "Clear database env overrides"}
              </button>
            </div>
          ) : null}
          {viewMode === "raw" ? (
            <div className="space-y-3">
              <textarea
                className="min-h-[420px] w-full rounded-md border border-panel-line p-3 font-mono text-sm text-panel-ink"
                onChange={(event) => {
                  setRawDirty(true);
                  setRawText(event.target.value);
                }}
                value={rawText}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-panel-muted">Edit as KEY=value lines. Hidden secret placeholders cannot be saved.</div>
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
                  disabled={savingBulkEnv || !rawText.trim()}
                  onClick={saveRawText}
                  type="button"
                >
                  <Save size={14} />
                  {savingBulkEnv ? "Saving..." : "Save text env"}
                </button>
              </div>
            </div>
          ) : (
          <div className="overflow-hidden rounded-md border border-panel-line">
            {filteredEnvItems.map((item) => {
              const revealed = revealedValues[item.key] !== undefined;
              return (
              <div className={`flex items-start gap-3 border-b border-panel-line p-3 last:border-b-0 ${selectedKeys.has(item.key) ? "bg-emerald-50/50" : ""}`} key={item.key}>
                <div className="pt-1">
                  <input
                    aria-label={`Select ${item.key}`}
                    checked={selectedKeys.has(item.key)}
                    className="h-4 w-4 rounded border-panel-line"
                    onChange={(event) => toggleKey(item.key, event.target.checked)}
                    type="checkbox"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-semibold">{item.key}</div>
                  <input
                    className="mt-2 h-9 w-full rounded-md border border-panel-line px-3 font-mono text-xs text-panel-ink"
                    onChange={(event) => setDraftValues((current) => ({ ...current, [item.key]: event.target.value }))}
                    placeholder={item.isSecret ? item.secretRef ?? "[secret]" : "value"}
                    type={item.isSecret && revealedValues[item.key] === undefined ? "password" : "text"}
                    value={envValueFor(item)}
                  />
                </div>
                <button
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-panel-line px-2 text-xs hover:bg-slate-50 disabled:opacity-50"
                  disabled={revealingKey === item.key || !item.isSecret}
                  onClick={() => item.isSecret && revealed ? hideEnv(item.key) : revealEnv(item.key)}
                  type="button"
                >
                  {item.isSecret && revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  {revealingKey === item.key ? "..." : item.isSecret && revealed ? "Hide" : item.isSecret ? "View" : "Visible"}
                </button>
                <button
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-panel-line px-2 text-xs hover:bg-slate-50 disabled:opacity-50"
                  disabled={savingLineKey === item.key}
                  onClick={() => saveEnvLine(item, envValueFor(item))}
                  type="button"
                >
                  <Save size={13} />
                  Save
                </button>
                <button
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-panel-line px-2 text-xs text-panel-danger hover:bg-red-50"
                  onClick={() => removeEnv(item.key)}
                  type="button"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              </div>
            );})}
            {filteredEnvItems.length === 0 ? (
              <div className="p-8 text-center text-sm text-panel-muted">{envItems.length === 0 ? "No environment variables." : "No environment variables match your search."}</div>
            ) : null}
          </div>
          )}
        </div>
        <div className="flex justify-end border-t border-panel-line p-4">
          <button className="h-9 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function EnvAddModal({
  envKey,
  envValue,
  envSecret,
  bulkEnvText,
  bulkEnvSecret,
  setEnvKey,
  setEnvValue,
  setEnvSecret,
  setBulkEnvText,
  setBulkEnvSecret,
  saveEnv,
  saveBulkEnv,
  savingEnv,
  savingBulkEnv,
  onClose
}: {
  envKey: string;
  envValue: string;
  envSecret: boolean;
  bulkEnvText: string;
  bulkEnvSecret: boolean;
  setEnvKey: (value: string) => void;
  setEnvValue: (value: string) => void;
  setEnvSecret: (value: boolean) => void;
  setBulkEnvText: (value: string) => void;
  setBulkEnvSecret: (value: boolean) => void;
  saveEnv: (onSuccess?: () => void) => void;
  saveBulkEnv: (onSuccess?: () => void) => void;
  savingEnv?: boolean;
  savingBulkEnv?: boolean;
  onClose: () => void;
}) {
  let bulkCount = 0;
  try {
    bulkCount = parseBulkEnvItems(bulkEnvText, bulkEnvSecret).length;
  } catch {
    bulkCount = 0;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-md border border-panel-line bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-panel-line p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-panel-ink">
            <KeyRound size={17} />
            Env add
          </div>
          <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="space-y-3">
            <input
              className="h-9 w-full rounded-md border border-panel-line px-3 font-mono text-sm"
              onChange={(event) => setEnvKey(event.target.value.toUpperCase())}
              placeholder="KEY"
              value={envKey}
            />
            <textarea
              className="h-28 w-full rounded-md border border-panel-line p-3 font-mono text-sm"
              onChange={(event) => setEnvValue(event.target.value)}
              placeholder="value"
              value={envValue}
            />
            <label className="flex items-center gap-2 text-sm text-panel-muted">
              <input checked={envSecret} onChange={(event) => setEnvSecret(event.target.checked)} type="checkbox" />
              Store as secret
            </label>
            <button
              className="h-10 w-full rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60"
              disabled={!envKey.trim() || savingEnv}
              onClick={() => saveEnv(onClose)}
              type="button"
            >
              {savingEnv ? "Saving..." : "Save variable"}
            </button>
          </div>
          <div className="mt-6 border-t border-panel-line pt-4">
            <div className="mb-3 text-xs font-semibold uppercase text-panel-muted">Bulk import</div>
            <textarea
              className="h-36 w-full rounded-md border border-panel-line p-3 font-mono text-xs"
              onChange={(event) => setBulkEnvText(event.target.value)}
              placeholder={`APP_NAME=eBitans\nAPP_ENV=production`}
              value={bulkEnvText}
            />
            <label className="mt-3 flex items-center gap-2 text-sm text-panel-muted">
              <input checked={bulkEnvSecret} onChange={(event) => setBulkEnvSecret(event.target.checked)} type="checkbox" />
              Store all as secret
            </label>
            <button
              className="mt-3 h-10 w-full rounded-md border border-panel-line text-sm font-semibold disabled:opacity-60"
              disabled={!bulkCount || savingBulkEnv}
              onClick={() => saveBulkEnv(onClose)}
              type="button"
            >
              {savingBulkEnv ? "Importing..." : `Import ${bulkCount || ""} variables`.trim()}
            </button>
          </div>
        </div>
        <div className="flex justify-end border-t border-panel-line p-4">
          <button className="h-9 rounded-md border border-panel-line px-4 text-sm font-medium hover:bg-slate-50" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPanel({ deployment, deleteText, setDeleteText, onEdit, onDelete, deleting }: { deployment: Deployment; deleteText: string; setDeleteText: (value: string) => void; onEdit: () => void; onDelete: () => void; deleting?: boolean }) {
  return <div className="space-y-5"><div className="rounded-md border border-panel-line p-4"><div className="flex items-center gap-2 text-sm font-semibold"><Settings2 size={16} />Project settings</div><button className="mt-4 flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm" onClick={onEdit} type="button"><Pencil size={15} />Edit all settings</button></div><div className="rounded-md border border-red-200 bg-red-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-red-800"><Trash2 size={16} />Delete project</div><p className="mt-1 text-sm text-red-700">Type <strong>{deployment.slug}</strong> to permanently delete this project metadata.</p><div className="mt-4 flex gap-2"><input className="h-9 rounded-md border border-red-200 bg-white px-3 text-sm" onChange={(event) => setDeleteText(event.target.value)} value={deleteText} /><button className="h-9 rounded-md bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={deleteText !== deployment.slug || deleting} onClick={onDelete} type="button">Delete</button></div></div></div>;
}

function GithubModal({ repos, loading, repoSearch, setRepoSearch, connection, githubToken, setGithubToken, githubUsername, setGithubUsername, saveToken, savingToken, onClose, onDeploy, deploying }: { repos?: GithubRepoResponse; loading: boolean; repoSearch: string; setRepoSearch: (value: string) => void; connection?: { connected: boolean; username: string | null }; githubToken: string; setGithubToken: (value: string) => void; githubUsername: string; setGithubUsername: (value: string) => void; saveToken: () => void; savingToken?: boolean; onClose: () => void; onDeploy: (repo: GithubRepo) => void; deploying?: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6"><div className="flex max-h-[82vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl"><div className="flex items-center justify-between border-b border-panel-line p-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><Github size={17} />GitHub Projects</div><div className="mt-1 text-xs text-panel-muted">Select a repository to auto-detect and deploy.</div></div><button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button"><X size={16} /></button></div><div className="border-b border-panel-line p-4"><div className="relative"><Search className="absolute left-3 top-2.5 text-panel-muted" size={15} /><input className="h-9 w-full rounded-md border border-panel-line pl-9 pr-3 text-sm" onChange={(event) => setRepoSearch(event.target.value)} placeholder="Search GitHub repositories" value={repoSearch} /></div>{!connection?.connected ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3"><div className="text-xs font-semibold text-amber-900">Connect GitHub token</div><div className="mt-3 grid grid-cols-[1fr_2fr_auto] gap-2"><input className="h-9 rounded-md border border-amber-200 bg-white px-3 text-sm" onChange={(event) => setGithubUsername(event.target.value)} placeholder="username" value={githubUsername} /><input className="h-9 rounded-md border border-amber-200 bg-white px-3 text-sm" onChange={(event) => setGithubToken(event.target.value)} placeholder="github_pat_..." type="password" value={githubToken} /><button className="h-9 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!githubToken || savingToken} onClick={saveToken} type="button">Connect</button></div></div> : <div className="mt-2 text-xs text-emerald-700">Connected{connection.username ? ` as ${connection.username}` : ""}.</div>}{repos?.dryRun ? <div className="mt-2 text-xs text-amber-700">GitHub token is not connected; showing dry-run placeholder repositories.</div> : null}</div><div className="min-h-0 flex-1 overflow-auto p-2">{loading ? <div className="p-8 text-center text-sm text-panel-muted">Loading repositories...</div> : null}{(repos?.items ?? []).map((repo) => <button className="flex w-full items-center justify-between gap-4 rounded-md px-3 py-3 text-left hover:bg-slate-50 disabled:opacity-60" disabled={deploying} key={repo.fullName} onClick={() => onDeploy(repo)} type="button"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-panel-ink">{repo.fullName}</span><span className="mt-1 block text-xs text-panel-muted">{repo.private ? "private" : "public"} · {repo.defaultBranch}</span></span><span className="flex h-8 shrink-0 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white"><Play size={13} />deploy</span></button>)}{!loading && (repos?.items ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No repositories found.</div> : null}</div></div></div>;
}

function RuntimeInstallModal({
  modal,
  busy,
  onChange,
  onClose,
  onContinue
}: {
  modal: RuntimeModalState;
  busy: boolean;
  onChange: (modal: RuntimeModalState) => void;
  onClose: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white shadow-xl">
        <div className="border-b border-panel-line p-5">
          <h2 className="text-xl font-bold text-panel-ink">Review required server packages</h2>
          <p className="mt-1 text-sm text-panel-muted">
            {modal.deployment.name} is missing runtime tools before {modal.action}. Select the packages you approve, then continue.
          </p>
          {modal.review.phpVersion ? <p className="mt-2 text-xs font-medium text-panel-muted">Current server PHP: {modal.review.phpVersion}</p> : null}
        </div>
        <div className="space-y-3 p-5">
          {modal.review.installable.map((item) => (
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-panel-line p-4 hover:bg-slate-50" key={item.tool}>
              <div>
                <div className="font-semibold text-panel-ink">{item.label}</div>
                <div className="mt-1 text-sm text-panel-muted">{item.reason}</div>
                <div className="mt-2 font-mono text-xs text-panel-muted">{item.command}</div>
              </div>
              <input
                checked={modal.selected[item.tool] ?? false}
                className="mt-1 h-5 w-5"
                onChange={(event) => onChange({ ...modal, selected: { ...modal.selected, [item.tool]: event.target.checked } })}
                type="checkbox"
              />
            </label>
          ))}
          {modal.review.blocked.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Not auto-installable: {modal.review.blocked.join(", ")}. Deployment remains blocked until these tools are installed.
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-panel-line p-5">
          <button className="rounded-md border border-panel-line px-4 py-2 text-sm font-medium hover:bg-slate-50" onClick={onClose} type="button">Cancel</button>
          <button
            className="rounded-md bg-panel-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy || !Object.values(modal.selected).some(Boolean)}
            onClick={onContinue}
            type="button"
          >
            {busy ? "Installing..." : "Install selected and continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LogsModal({ title, type, text, onCopy, onClose }: { title: string; type: LogType; text: string; onCopy: () => Promise<void> | void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const logEl = logRef.current;
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [text]);

  async function handleCopy() {
    try {
      await onCopy();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <div className="flex h-[78vh] w-full max-w-5xl flex-col rounded-md border border-panel-line bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-panel-line p-4">
          <div>
            <div className="text-sm font-semibold text-panel-ink">{title}</div>
            <div className="mt-1 text-xs text-panel-muted">{type === "running" ? "Runtime stdout, stderr, and Laravel log tail from the server." : "Build and deployment event log for sharing and debugging."}</div>
          </div>
          <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button"><X size={16} /></button>
        </div>
        <pre ref={logRef} className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">{text || "No logs yet."}</pre>
        <div className="flex justify-end gap-2 border-t border-panel-line p-4">
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={handleCopy} type="button"><Clipboard size={15} />{copied ? "Copied" : "Copy logs"}</button>
          <button className="h-9 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white" onClick={onClose} type="button">Close</button>
        </div>
      </div>
    </div>
  );
}
