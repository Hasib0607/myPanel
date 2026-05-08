"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clipboard, FolderGit2, GitBranch, Github, KeyRound, Pencil, Play, Plus, Search, Settings2, Square, Trash2, Wand2, X } from "lucide-react";
import { apiDelete, apiDeleteBody, apiGet, apiGetText, apiPatch, apiPost, apiPut } from "@/lib/api";
import type { Deployment, DeploymentDomainBinding, DeploymentEnvVar, DeploymentFramework, DeploymentListResponse, DetectionResponse, PreflightResponse, QueueResponse, DeploymentSourceProvider } from "./deployment-types";
import { frameworkOptions, sourceOptions } from "./deployment-types";
import { ResultNotice, actionIcon, formatDate, healthBadge, queryString, statusBadge } from "./deployment-ui";

type GithubRepo = { id?: string; owner: string; name: string; fullName: string; private: boolean; defaultBranch: string; updatedAt?: string };
type GithubRepoResponse = { connected: boolean; dryRun: boolean; items: GithubRepo[]; note?: string };
type GithubDetectResponse = DetectionResponse & { repository: string; dryRun: boolean };
type Domain = { id: string; name: string };
type DomainListResponse = { items: Domain[] };
type LogType = "build" | "running";

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
  autoDeployEnabled: true
};

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function deploymentRootForRepo(repoName: string) {
  return `/var/www/deployments/${slugify(repoName)}`;
}

function parseEnv(text: string) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index).trim(), line.slice(index + 1)];
  }));
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
    autoDeployEnabled: deployment.autoDeployEnabled
  };
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

export function DeploymentsClient() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"overview" | "domains" | "env" | "settings">("overview");
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
  const [domainToAdd, setDomainToAdd] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [envSecret, setEnvSecret] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [logTitle, setLogTitle] = useState("");
  const [notice, setNotice] = useState("");

  const deployments = useQuery({
    queryKey: ["deployments", search, statusFilter, sourceFilter],
    queryFn: () => apiGet<DeploymentListResponse>(`/deployments?${queryString({ search, status: statusFilter, sourceProvider: sourceFilter, page: 1, pageSize: 50 })}`),
    refetchInterval: 8000
  });
  const domains = useQuery({ queryKey: ["domains", "deployment-create"], queryFn: () => apiGet<DomainListResponse>("/domains?page=1&pageSize=100") });
  const nextPort = useQuery({ queryKey: ["deployments-next-port"], queryFn: () => apiGet<{ port: number }>("/deployments/ports/next") });
  const repos = useQuery({ enabled: repoPickerOpen, queryKey: ["deployments-github-repos", repoSearch], queryFn: () => apiGet<GithubRepoResponse>(`/deployments/github/repos?${queryString({ search: repoSearch })}`) });
  const githubConnection = useQuery({ enabled: repoPickerOpen, queryKey: ["deployments-github-connection"], queryFn: () => apiGet<{ connected: boolean; username: string | null; scopes: string[] }>("/deployments/github/connection") });

  const selected = useMemo(() => (deployments.data?.items ?? []).find((item) => item.id === selectedId) ?? deployments.data?.items?.[0] ?? null, [deployments.data?.items, selectedId]);

  useEffect(() => {
    if (!selectedId && deployments.data?.items?.[0]) setSelectedId(deployments.data.items[0].id);
  }, [deployments.data?.items, selectedId]);

  useEffect(() => {
    if (!draft.port && nextPort.data?.port) setDraft((current) => ({ ...current, port: String(nextPort.data.port) }));
  }, [draft.port, nextPort.data?.port]);

  const invalidateDeployments = async () => {
    await queryClient.invalidateQueries({ queryKey: ["deployments"] });
    await queryClient.invalidateQueries({ queryKey: ["deployments-next-port"] });
  };

  const createDeployment = useMutation({
    mutationFn: () => apiPost<Deployment>("/deployments", formPayload(draft)),
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
      return apiPatch<Deployment>(`/deployments/${selected.slug}`, formPayload(editDraft));
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
    mutationFn: (target: "create" | "edit") => apiPost<DetectionResponse>("/deployments/detect", { rootPath: target === "create" ? draft.rootPath : editDraft.rootPath }),
    onSuccess: (result, target) => {
      const apply = (current: Draft) => ({ ...current, framework: result.detected, installCommand: result.suggestions.installCommand ?? "", buildCommand: result.suggestions.buildCommand ?? "", startCommand: result.suggestions.startCommand ?? "", outputDirectory: result.suggestions.outputDirectory ?? "" });
      if (target === "create") setDraft(apply);
      else setEditDraft(apply);
      setNotice(`${result.detected} detected: ${result.reason}`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Framework detection failed")
  });

  const action = useMutation({
    mutationFn: ({ deployment, name }: { deployment: Deployment; name: "deploy" | "start" | "stop" | "restart" }) => apiPost<QueueResponse>(`/deployments/${deployment.slug}/${name}`, {}),
    onSuccess: async (result, variables) => {
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
    onError: (error) => setNotice(error instanceof Error ? error.message : "Action failed")
  });

  const openLogs = useMutation({
    mutationFn: async ({ deployment, type }: { deployment: Deployment; type: LogType }) => {
      const text = await apiGetText(`/deployments/${deployment.slug}/logs/export?${queryString({ type, limit: 500 })}`);
      return { deployment, text, type };
    },
    onSuccess: ({ deployment, text, type }) => {
      setLogTitle(`${deployment.name} ${type === "build" ? "build log" : "running log"}`);
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
    mutationFn: () => apiPut("/deployments/github/connection", { username: githubUsername || null, token: githubToken, scopes: [] }),
    onSuccess: async () => {
      setGithubToken("");
      setNotice("GitHub token connected. Repository list refreshed.");
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-connection"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-repos"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not connect GitHub token")
  });

  const importAndDeployGithub = useMutation({
    mutationFn: async (repo: GithubRepo) => {
      const detection = await apiGet<GithubDetectResponse>(`/deployments/github/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/detect?${queryString({ branch: repo.defaultBranch, rootDirectory: draft.rootDirectory || "." })}`);
      const repoDraft = { ...draft, name: repo.name, slug: slugify(repo.name), githubOwner: repo.owner, githubRepo: repo.name, gitUrl: `https://github.com/${repo.fullName}.git`, branch: repo.defaultBranch, rootPath: deploymentRootForRepo(repo.name), sourceProvider: "GITHUB" as const, framework: detection.detected, installCommand: detection.suggestions.installCommand ?? "", buildCommand: detection.suggestions.buildCommand ?? "", startCommand: detection.suggestions.startCommand ?? "", outputDirectory: detection.suggestions.outputDirectory ?? "", autoDeployEnabled: true };
      const deployment = await apiPost<Deployment>("/deployments/github/import", { ...formPayload(repoDraft), githubOwner: repo.owner, githubRepo: repo.name });
      await apiPost<QueueResponse>(`/deployments/${deployment.slug}/deploy`);
      return { deployment, detection };
    },
    onSuccess: async ({ deployment, detection }) => {
      setNotice(`${deployment.name} imported, ${detection.detected} detected, and deploy queued.`);
      setCreateOpen(false);
      setRepoPickerOpen(false);
      setSelectedId(deployment.id);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import repository")
  });

  const addDomain = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a project first");
      return apiPost<DeploymentDomainBinding>(`/deployments/${selected.slug}/domains`, { domainId: domainToAdd, primary: !selected.domainId });
    },
    onSuccess: async () => {
      setDomainToAdd("");
      setNotice("Domain added to project.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not add domain")
  });

  const setPrimaryDomain = useMutation({
    mutationFn: (binding: DeploymentDomainBinding) => apiPatch(`/deployments/${selected?.slug}/domains/${binding.domainId}/primary`, {}),
    onSuccess: async () => {
      setNotice("Primary domain updated.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update primary domain")
  });

  const removeDomain = useMutation({
    mutationFn: (binding: DeploymentDomainBinding) => apiDelete(`/deployments/${selected?.slug}/domains/${binding.domainId}`),
    onSuccess: async () => {
      setNotice("Domain removed.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not remove domain")
  });

  const saveEnv = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a project first");
      return apiPut<DeploymentEnvVar>(`/deployments/${selected.slug}/env/${encodeURIComponent(envKey)}`, { value: envValue, isSecret: envSecret });
    },
    onSuccess: async () => {
      setNotice(`${envKey} saved.`);
      setEnvKey("");
      setEnvValue("");
      setEnvSecret(false);
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save env")
  });

  const removeEnv = useMutation({
    mutationFn: (key: string) => apiDelete(`/deployments/${selected?.slug}/env/${encodeURIComponent(key)}`),
    onSuccess: async () => {
      setNotice("Environment variable removed.");
      await invalidateDeployments();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not remove env")
  });

  const deleteProject = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error("Select a project first");
      return apiDeleteBody(`/deployments/${selected.slug}`, { confirmSlug: deleteText });
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
    { key: "env", label: "Environment" },
    { key: "settings", label: "Settings" }
  ] as const;

  return (
    <section className="flex h-[calc(100vh-81px)] flex-col overflow-hidden bg-slate-50">
      <div className="border-b border-panel-line bg-white px-8 py-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-panel-ink">Deployments</h1>
            <p className="mt-1 text-sm text-panel-muted">Import, deploy, operate, and tune projects from one cockpit.</p>
          </div>
          <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white" onClick={() => setCreateOpen(true)} type="button"><Plus size={16} />Create Project</button>
        </div>
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
                      <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={action.isPending} key={name} onClick={() => action.mutate({ deployment: selected, name })} type="button">
                        {name === "deploy" ? <Play size={15} /> : name === "stop" ? <Square size={15} /> : actionIcon(name)}{name}
                      </button>
                    ))}
                    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={openLogs.isPending} onClick={() => openLogs.mutate({ deployment: selected, type: "build" })} type="button"><Clipboard size={15} />Build log</button>
                    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50 disabled:opacity-50" disabled={openLogs.isPending} onClick={() => openLogs.mutate({ deployment: selected, type: "running" })} type="button"><Clipboard size={15} />Running log</button>
                    <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={openEdit} type="button"><Pencil size={15} />Edit</button>
                  </div>
                </div>
                <div className="mt-5 flex gap-1">
                  {tabs.map((tab) => <button className={`h-9 rounded-md px-3 text-sm font-medium ${activeTab === tab.key ? "bg-slate-900 text-white" : "text-panel-muted hover:bg-slate-50 hover:text-panel-ink"}`} key={tab.key} onClick={() => setActiveTab(tab.key)} type="button">{tab.label}</button>)}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto p-5">
                {activeTab === "overview" ? <OverviewPanel deployment={selected} /> : null}
                {activeTab === "domains" ? <DomainsPanel deployment={selected} domains={domains.data?.items ?? []} domainToAdd={domainToAdd} setDomainToAdd={setDomainToAdd} addDomain={() => addDomain.mutate()} setPrimary={(binding) => setPrimaryDomain.mutate(binding)} removeDomain={(binding) => removeDomain.mutate(binding)} /> : null}
                {activeTab === "env" ? <EnvPanel deployment={selected} envKey={envKey} envValue={envValue} envSecret={envSecret} setEnvKey={setEnvKey} setEnvValue={setEnvValue} setEnvSecret={setEnvSecret} saveEnv={() => saveEnv.mutate()} removeEnv={(key) => removeEnv.mutate(key)} /> : null}
                {activeTab === "settings" ? <SettingsPanel deployment={selected} deleteText={deleteText} setDeleteText={setDeleteText} onEdit={openEdit} onDelete={() => deleteProject.mutate()} deleting={deleteProject.isPending} /> : null}
              </div>
            </div>
          ) : <div className="p-10 text-center text-sm text-panel-muted">Select or create a project.</div>}
        </main>
      </div>

      {createOpen ? <ProjectModal title="Create Project" draft={draft} setDraft={setDraft} domains={domains.data?.items ?? []} onClose={() => setCreateOpen(false)} onDetect={() => detect.mutate("create")} onSubmit={() => createDeployment.mutate()} submitLabel="Create" busy={createDeployment.isPending} openGithub={() => setRepoPickerOpen(true)} /> : null}
      {editingOpen ? <ProjectModal title="Edit Project" draft={editDraft} setDraft={setEditDraft} domains={domains.data?.items ?? []} onClose={() => setEditingOpen(false)} onDetect={() => detect.mutate("edit")} onSubmit={() => updateDeployment.mutate()} submitLabel="Save changes" busy={updateDeployment.isPending} openGithub={() => setRepoPickerOpen(true)} /> : null}
      {repoPickerOpen ? <GithubModal repos={repos.data} loading={repos.isLoading} repoSearch={repoSearch} setRepoSearch={setRepoSearch} connection={githubConnection.data} githubToken={githubToken} setGithubToken={setGithubToken} githubUsername={githubUsername} setGithubUsername={setGithubUsername} saveToken={() => saveGithubToken.mutate()} savingToken={saveGithubToken.isPending} onClose={() => setRepoPickerOpen(false)} onDeploy={(repo) => importAndDeployGithub.mutate(repo)} deploying={importAndDeployGithub.isPending} /> : null}
      {logModalOpen ? <LogsModal title={logTitle} text={logText} onCopy={copyLogText} onClose={() => setLogModalOpen(false)} /> : null}
    </section>
  );
}

function ProjectCard({ deployment, active, onSelect }: { deployment: Deployment; active: boolean; onSelect: () => void }) {
  const latest = deployment.releases?.[0];
  return (
    <button className={`mb-3 w-full rounded-md border p-4 text-left transition ${active ? "border-panel-accent bg-teal-50" : "border-panel-line bg-white hover:bg-slate-50"}`} onClick={onSelect} type="button">
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
      <div className="mt-3 truncate text-xs text-panel-muted">{deployment.domainBindings?.map((item) => item.domain.name).join(", ") || deployment.domain?.name || deployment.rootPath}</div>
    </button>
  );
}

function ProjectModal({ title, draft, setDraft, domains, onClose, onDetect, onSubmit, submitLabel, busy, openGithub }: { title: string; draft: Draft; setDraft: (draft: Draft) => void; domains: Domain[]; onClose: () => void; onDetect: () => void; onSubmit: () => void; submitLabel: string; busy?: boolean; openGithub: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-panel-line p-4"><div className="text-sm font-semibold">{title}</div><button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button"><X size={16} /></button></div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          <div className="grid grid-cols-4 gap-2">{sourceOptions.map((source) => <button className={`h-9 rounded-md border text-xs font-semibold ${draft.sourceProvider === source ? "border-panel-accent bg-teal-50 text-panel-accent" : "border-panel-line"}`} key={source} onClick={() => { setDraft({ ...draft, sourceProvider: source }); if (source === "GITHUB") openGithub(); }} type="button">{source.replace("_", " ")}</button>)}</div>
          {draft.sourceProvider === "GITHUB" ? <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50" onClick={openGithub} type="button"><Github size={15} />Choose GitHub project</button> : null}
          <DeploymentFormFields value={draft} onChange={setDraft} domains={domains} />
        </div>
        <div className="flex justify-between border-t border-panel-line p-4"><button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm" onClick={onDetect} type="button"><Wand2 size={15} />Detect</button><div className="flex gap-2"><button className="h-9 rounded-md border border-panel-line px-3 text-sm" onClick={onClose} type="button">Cancel</button><button className="h-9 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.name || !draft.rootPath || !draft.port || busy} onClick={onSubmit} type="button">{submitLabel}</button></div></div>
      </div>
    </div>
  );
}

function DeploymentFormFields({ value, onChange, domains }: { value: Draft; onChange: (next: Draft) => void; domains: Domain[] }) {
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3"><Input label="Project name" value={value.name} onChange={(name) => onChange({ ...value, name, slug: value.slug || slugify(name) })} /><Input label="Slug" value={value.slug} onChange={(slug) => onChange({ ...value, slug })} /></div>
    <label className="space-y-1 text-xs font-medium text-panel-muted">Primary domain<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, domainId: event.target.value })} value={value.domainId}><option value="">No domain</option>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
    <div className="grid grid-cols-2 gap-3"><Input label="Git URL" value={value.gitUrl} onChange={(gitUrl) => onChange({ ...value, gitUrl })} /><Input label="Branch" value={value.branch} onChange={(branch) => onChange({ ...value, branch })} /></div>
    <Input label="App root path" value={value.rootPath} onChange={(rootPath) => onChange({ ...value, rootPath })} />
    <div className="grid grid-cols-3 gap-3"><label className="space-y-1 text-xs font-medium text-panel-muted">Framework<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, framework: event.target.value as DeploymentFramework })} value={value.framework}>{frameworkOptions.map((framework) => <option key={framework} value={framework}>{framework}</option>)}</select></label><Input label="Port (auto)" readOnly value={value.port} onChange={(port) => onChange({ ...value, port })} /><label className="space-y-1 text-xs font-medium text-panel-muted">Database<select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => onChange({ ...value, dbType: event.target.value as Draft["dbType"] })} value={value.dbType}><option value="">None</option><option value="POSTGRESQL">PostgreSQL</option><option value="MYSQL">MySQL</option></select></label></div>
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
  return <div className="grid grid-cols-4 gap-4"><Metric label="Source" value={deployment.sourceProvider} /><Metric label="Branch" value={deployment.branch} /><Metric label="Latest release" value={latest?.status ?? "No release"} /><Metric label="Updated" value={formatDate(deployment.updatedAt)} /></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-panel-line p-4"><div className="text-xs uppercase text-panel-muted">{label}</div><div className="mt-3 truncate text-sm font-semibold">{value}</div></div>;
}

function DomainsPanel({ deployment, domains, domainToAdd, setDomainToAdd, addDomain, setPrimary, removeDomain }: { deployment: Deployment; domains: Domain[]; domainToAdd: string; setDomainToAdd: (id: string) => void; addDomain: () => void; setPrimary: (binding: DeploymentDomainBinding) => void; removeDomain: (binding: DeploymentDomainBinding) => void }) {
  const boundIds = new Set((deployment.domainBindings ?? []).map((binding) => binding.domainId));
  return <div className="space-y-4"><div className="flex gap-2"><select className="h-10 min-w-72 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDomainToAdd(event.target.value)} value={domainToAdd}><option value="">Select domain</option>{domains.filter((domain) => !boundIds.has(domain.id)).map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select><button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!domainToAdd} onClick={addDomain} type="button"><Plus size={15} />Add domain</button></div><div className="overflow-hidden rounded-md border border-panel-line">{(deployment.domainBindings ?? []).map((binding) => <div className="flex items-center justify-between border-b border-panel-line p-3 last:border-b-0" key={binding.id}><div><div className="font-semibold">{binding.domain.name}</div><div className="text-xs text-panel-muted">{binding.role}</div></div><div className="flex gap-2"><button className="h-8 rounded-md border border-panel-line px-2 text-xs" disabled={binding.role === "primary"} onClick={() => setPrimary(binding)} type="button">Make primary</button><button className="h-8 rounded-md border border-panel-line px-2 text-xs text-panel-danger" onClick={() => removeDomain(binding)} type="button">Remove</button></div></div>)}{(deployment.domainBindings ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No domains attached.</div> : null}</div></div>;
}

function EnvPanel({ deployment, envKey, envValue, envSecret, setEnvKey, setEnvValue, setEnvSecret, saveEnv, removeEnv }: { deployment: Deployment; envKey: string; envValue: string; envSecret: boolean; setEnvKey: (value: string) => void; setEnvValue: (value: string) => void; setEnvSecret: (value: boolean) => void; saveEnv: () => void; removeEnv: (key: string) => void }) {
  return <div className="grid grid-cols-[1fr_360px] gap-5"><div className="overflow-hidden rounded-md border border-panel-line">{(deployment.env ?? []).map((item) => <div className="flex items-center justify-between border-b border-panel-line p-3 last:border-b-0" key={item.key}><div><div className="font-mono text-sm font-semibold">{item.key}</div><div className="mt-1 max-w-xl truncate font-mono text-xs text-panel-muted">{item.isSecret ? item.secretRef ?? "[secret]" : item.value}</div></div><button className="h-8 rounded-md border border-panel-line px-2 text-xs text-panel-danger" onClick={() => removeEnv(item.key)} type="button"><Trash2 size={13} /></button></div>)}{(deployment.env ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No environment variables.</div> : null}</div><div className="rounded-md border border-panel-line p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold"><KeyRound size={16} />Add env</div><div className="space-y-3"><input className="h-9 w-full rounded-md border border-panel-line px-3 font-mono text-sm" onChange={(event) => setEnvKey(event.target.value.toUpperCase())} placeholder="KEY" value={envKey} /><textarea className="h-28 w-full rounded-md border border-panel-line p-3 font-mono text-sm" onChange={(event) => setEnvValue(event.target.value)} placeholder="value" value={envValue} /><label className="flex items-center gap-2 text-sm text-panel-muted"><input checked={envSecret} onChange={(event) => setEnvSecret(event.target.checked)} type="checkbox" /> Store as secret</label><button className="h-10 w-full rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!envKey} onClick={saveEnv} type="button">Save variable</button></div></div></div>;
}

function SettingsPanel({ deployment, deleteText, setDeleteText, onEdit, onDelete, deleting }: { deployment: Deployment; deleteText: string; setDeleteText: (value: string) => void; onEdit: () => void; onDelete: () => void; deleting?: boolean }) {
  return <div className="space-y-5"><div className="rounded-md border border-panel-line p-4"><div className="flex items-center gap-2 text-sm font-semibold"><Settings2 size={16} />Project settings</div><button className="mt-4 flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm" onClick={onEdit} type="button"><Pencil size={15} />Edit all settings</button></div><div className="rounded-md border border-red-200 bg-red-50 p-4"><div className="flex items-center gap-2 text-sm font-semibold text-red-800"><Trash2 size={16} />Delete project</div><p className="mt-1 text-sm text-red-700">Type <strong>{deployment.slug}</strong> to permanently delete this project metadata.</p><div className="mt-4 flex gap-2"><input className="h-9 rounded-md border border-red-200 bg-white px-3 text-sm" onChange={(event) => setDeleteText(event.target.value)} value={deleteText} /><button className="h-9 rounded-md bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={deleteText !== deployment.slug || deleting} onClick={onDelete} type="button">Delete</button></div></div></div>;
}

function GithubModal({ repos, loading, repoSearch, setRepoSearch, connection, githubToken, setGithubToken, githubUsername, setGithubUsername, saveToken, savingToken, onClose, onDeploy, deploying }: { repos?: GithubRepoResponse; loading: boolean; repoSearch: string; setRepoSearch: (value: string) => void; connection?: { connected: boolean; username: string | null }; githubToken: string; setGithubToken: (value: string) => void; githubUsername: string; setGithubUsername: (value: string) => void; saveToken: () => void; savingToken?: boolean; onClose: () => void; onDeploy: (repo: GithubRepo) => void; deploying?: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6"><div className="flex max-h-[82vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl"><div className="flex items-center justify-between border-b border-panel-line p-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><Github size={17} />GitHub Projects</div><div className="mt-1 text-xs text-panel-muted">Select a repository to auto-detect and deploy.</div></div><button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button"><X size={16} /></button></div><div className="border-b border-panel-line p-4"><div className="relative"><Search className="absolute left-3 top-2.5 text-panel-muted" size={15} /><input className="h-9 w-full rounded-md border border-panel-line pl-9 pr-3 text-sm" onChange={(event) => setRepoSearch(event.target.value)} placeholder="Search GitHub repositories" value={repoSearch} /></div>{!connection?.connected ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3"><div className="text-xs font-semibold text-amber-900">Connect GitHub token</div><div className="mt-3 grid grid-cols-[1fr_2fr_auto] gap-2"><input className="h-9 rounded-md border border-amber-200 bg-white px-3 text-sm" onChange={(event) => setGithubUsername(event.target.value)} placeholder="username" value={githubUsername} /><input className="h-9 rounded-md border border-amber-200 bg-white px-3 text-sm" onChange={(event) => setGithubToken(event.target.value)} placeholder="github_pat_..." type="password" value={githubToken} /><button className="h-9 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!githubToken || savingToken} onClick={saveToken} type="button">Connect</button></div></div> : <div className="mt-2 text-xs text-emerald-700">Connected{connection.username ? ` as ${connection.username}` : ""}.</div>}{repos?.dryRun ? <div className="mt-2 text-xs text-amber-700">GitHub token is not connected; showing dry-run placeholder repositories.</div> : null}</div><div className="min-h-0 flex-1 overflow-auto p-2">{loading ? <div className="p-8 text-center text-sm text-panel-muted">Loading repositories...</div> : null}{(repos?.items ?? []).map((repo) => <button className="flex w-full items-center justify-between gap-4 rounded-md px-3 py-3 text-left hover:bg-slate-50 disabled:opacity-60" disabled={deploying} key={repo.fullName} onClick={() => onDeploy(repo)} type="button"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-panel-ink">{repo.fullName}</span><span className="mt-1 block text-xs text-panel-muted">{repo.private ? "private" : "public"} · {repo.defaultBranch}</span></span><span className="flex h-8 shrink-0 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white"><Play size={13} />deploy</span></button>)}{!loading && (repos?.items ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No repositories found.</div> : null}</div></div></div>;
}

function LogsModal({ title, text, onCopy, onClose }: { title: string; text: string; onCopy: () => Promise<void> | void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

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
            <div className="mt-1 text-xs text-panel-muted">Separate build and runtime output for sharing and debugging.</div>
          </div>
          <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={onClose} type="button"><X size={16} /></button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">{text || "No logs yet."}</pre>
        <div className="flex justify-end gap-2 border-t border-panel-line p-4">
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={handleCopy} type="button"><Clipboard size={15} />{copied ? "Copied" : "Copy logs"}</button>
          <button className="h-9 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white" onClick={onClose} type="button">Close</button>
        </div>
      </div>
    </div>
  );
}
