"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clipboard, Filter, FolderGit2, GitBranch, Github, Play, Plus, RefreshCw, Search, Square, Wand2, X } from "lucide-react";
import { apiGet, apiGetText, apiPost, apiPut } from "@/lib/api";
import type { Deployment, DeploymentFramework, DeploymentListResponse, DetectionResponse, PreflightResponse, QueueResponse, DeploymentSourceProvider } from "./deployment-types";
import { frameworkOptions, sourceOptions } from "./deployment-types";
import { EmptyState, ResultNotice, actionIcon, formatDate, healthBadge, queryString, statusBadge } from "./deployment-ui";

type GithubRepo = {
  id?: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt?: string;
};

type GithubRepoResponse = {
  connected: boolean;
  dryRun: boolean;
  items: GithubRepo[];
  note?: string;
};

type GithubDetectResponse = DetectionResponse & {
  repository: string;
  dryRun: boolean;
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
};

type Domain = {
  id: string;
  name: string;
};

type DomainListResponse = {
  items: Domain[];
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
  dbType: ""
};

function deploymentRootForRepo(repoName: string) {
  return `/var/www/deployments/${slugify(repoName)}`;
}

function parseEnv(text: string) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1)];
      })
  );
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function formPayload(draft: Draft) {
  const port = Number(draft.port);
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
    port,
    installCommand: draft.installCommand || null,
    buildCommand: draft.buildCommand || null,
    startCommand: draft.startCommand || null,
    outputDirectory: draft.outputDirectory || null,
    dbType: draft.dbType || null,
    envVars: parseEnv(draft.envText),
    autoDeployEnabled: false,
    persistentPaths: []
  };
}

export function DeploymentsClient() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [githubUsername, setGithubUsername] = useState("");
  const [copyingLogsFor, setCopyingLogsFor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const deployments = useQuery({
    queryKey: ["deployments", search, statusFilter, sourceFilter],
    queryFn: () => apiGet<DeploymentListResponse>(`/deployments?${queryString({ search, status: statusFilter, sourceProvider: sourceFilter, page: 1, pageSize: 50 })}`),
    refetchInterval: 8000
  });
  const domains = useQuery({
    queryKey: ["domains", "deployment-create"],
    queryFn: () => apiGet<DomainListResponse>("/domains?page=1&pageSize=100")
  });
  const nextPort = useQuery({
    queryKey: ["deployments-next-port"],
    queryFn: () => apiGet<{ port: number }>("/deployments/ports/next")
  });
  const repos = useQuery({
    enabled: repoPickerOpen,
    queryKey: ["deployments-github-repos", repoSearch],
    queryFn: () => apiGet<GithubRepoResponse>(`/deployments/github/repos?${queryString({ search: repoSearch })}`)
  });
  const githubConnection = useQuery({
    enabled: repoPickerOpen,
    queryKey: ["deployments-github-connection"],
    queryFn: () => apiGet<{ connected: boolean; username: string | null; scopes: string[] }>("/deployments/github/connection")
  });

  useEffect(() => {
    if (!draft.port && nextPort.data?.port) setDraft((current) => ({ ...current, port: String(nextPort.data.port) }));
  }, [draft.port, nextPort.data?.port]);

  const createDeployment = useMutation({
    mutationFn: () => apiPost<Deployment>("/deployments", formPayload(draft)),
    onSuccess: async (deployment) => {
      setNotice(`${deployment.name} created. Ready for deploy.`);
      setDraft({ ...initialDraft, port: String((nextPort.data?.port ?? deployment.port) + 1) });
      await queryClient.invalidateQueries({ queryKey: ["deployments"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-next-port"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create deployment")
  });

  function selectRepo(repo: GithubRepo) {
    setSelectedRepo(repo);
    setDraft((current) => ({
      ...current,
      name: current.name || repo.name,
      slug: current.slug || slugify(repo.name),
      githubOwner: repo.owner,
      githubRepo: repo.name,
      gitUrl: `https://github.com/${repo.fullName}.git`,
      branch: repo.defaultBranch,
      rootPath: deploymentRootForRepo(repo.name),
      sourceProvider: "GITHUB"
    }));
    setNotice(`${repo.fullName} selected. Review settings, then import and deploy.`);
  }

  const importAndDeployGithub = useMutation({
    mutationFn: async (repo?: GithubRepo) => {
      const targetRepo = repo ?? selectedRepo;
      if (!targetRepo) throw new Error("Select a GitHub repository first");
      const detection = await apiGet<GithubDetectResponse>(
        `/deployments/github/repos/${encodeURIComponent(targetRepo.owner)}/${encodeURIComponent(targetRepo.name)}/detect?${queryString({ branch: targetRepo.defaultBranch, rootDirectory: draft.rootDirectory || "." })}`
      );
      const suggestions = detection.suggestions;
      const repoDraft = {
        ...draft,
        name: draft.name || targetRepo.name,
        slug: draft.slug || slugify(targetRepo.name),
        githubOwner: targetRepo.owner,
        githubRepo: targetRepo.name,
        gitUrl: `https://github.com/${targetRepo.fullName}.git`,
        branch: draft.branch || targetRepo.defaultBranch,
        rootPath: deploymentRootForRepo(targetRepo.name),
        sourceProvider: "GITHUB" as const,
        framework: detection.detected,
        installCommand: suggestions.installCommand ?? "",
        buildCommand: suggestions.buildCommand ?? "",
        startCommand: suggestions.startCommand ?? "",
        outputDirectory: suggestions.outputDirectory ?? ""
      };
      const deployment = await apiPost<Deployment>("/deployments/github/import", {
        ...formPayload(repoDraft),
        githubOwner: targetRepo.owner,
        githubRepo: targetRepo.name
      });
      const queue = await apiPost<QueueResponse>(`/deployments/${deployment.slug}/deploy`);
      return { deployment, queue, detection };
    },
    onSuccess: async ({ deployment, detection }) => {
      setNotice(`${deployment.name} imported, ${detection.detected} detected, and deployment queued.`);
      setSelectedRepo(null);
      setRepoPickerOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["deployments"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-next-port"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not import and deploy repository")
  });

  const detect = useMutation({
    mutationFn: () => apiPost<DetectionResponse>("/deployments/detect", { rootPath: draft.rootPath }),
    onSuccess: (result) => {
      setDraft((current) => ({
        ...current,
        framework: result.detected,
        installCommand: result.suggestions.installCommand ?? "",
        buildCommand: result.suggestions.buildCommand ?? "",
        startCommand: result.suggestions.startCommand ?? "",
        outputDirectory: result.suggestions.outputDirectory ?? ""
      }));
      setNotice(`${result.detected} detected: ${result.reason}`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Framework detection failed")
  });

  const preflight = useMutation({
    mutationFn: () => apiPost<PreflightResponse>("/deployments/preflight", {
      rootPath: draft.rootPath,
      domainId: draft.domainId || null,
      port: Number(draft.port),
      dbType: draft.dbType || null,
      gitUrl: draft.gitUrl || null
    }),
    onSuccess: (result) => setNotice(result.ok ? "Preflight passed." : `Preflight needs attention: ${result.checks.filter((check) => !check.ok).map((check) => check.label).join(", ")}`),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Preflight failed")
  });

  const action = useMutation({
    mutationFn: ({ deployment, name }: { deployment: Deployment; name: "deploy" | "start" | "stop" | "restart" }) => apiPost<QueueResponse>(`/deployments/${deployment.slug}/${name}`),
    onSuccess: async (_result, variables) => {
      setNotice(`${variables.name} requested for ${variables.deployment.name}.`);
      await queryClient.invalidateQueries({ queryKey: ["deployments"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Action failed")
  });

  const copyLogs = useMutation({
    mutationFn: async (deployment: Deployment) => {
      setCopyingLogsFor(deployment.id);
      const text = await apiGetText(`/deployments/${deployment.slug}/logs/export?limit=500`);
      await navigator.clipboard.writeText(text);
      return deployment;
    },
    onSuccess: (deployment) => setNotice(`${deployment.name} logs copied. You can paste/share it now.`),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not copy logs"),
    onSettled: () => setCopyingLogsFor(null)
  });

  const saveGithubToken = useMutation({
    mutationFn: () => apiPut<{ connected: boolean; username: string | null; scopes: string[] }>("/deployments/github/connection", {
      username: githubUsername || null,
      token: githubToken,
      scopes: []
    }),
    onSuccess: async () => {
      setGithubToken("");
      setNotice("GitHub token connected. Repository list refreshed.");
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-connection"] });
      await queryClient.invalidateQueries({ queryKey: ["deployments-github-repos"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not connect GitHub token")
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  return (
    <section className="grid h-[calc(100vh-81px)] grid-cols-[410px_minmax(620px,1fr)] gap-6 overflow-hidden p-8">
      <aside className="min-h-0 overflow-auto rounded-md border border-panel-line bg-white">
        <div className="border-b border-panel-line p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Plus size={16} />
            New Project
          </div>
          <div className="mt-1 text-xs text-panel-muted">GitHub, Git URL, file root, commands, env, port and DB in one pass.</div>
        </div>

        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2">
            {sourceOptions.map((source) => (
              <button className={`h-9 rounded-md border text-xs font-semibold ${draft.sourceProvider === source ? "border-panel-accent bg-teal-50 text-panel-accent" : "border-panel-line hover:bg-slate-50"}`} key={source} onClick={() => {
                setDraft({ ...draft, sourceProvider: source });
                if (source === "GITHUB") setRepoPickerOpen(true);
              }} type="button">
                {source.replace("_", " ")}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Project name
              <input className="h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, name: event.target.value, slug: draft.slug || slugify(event.target.value) })} placeholder="my app" value={draft.name} />
            </label>
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Slug
              <input className="h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="my-app" value={draft.slug} />
            </label>
          </div>

          <label className="space-y-1 text-xs font-medium text-panel-muted">
            Domain
            <select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, domainId: event.target.value })} value={draft.domainId}>
              <option value="">No domain yet</option>
              {(domains.data?.items ?? []).map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
            </select>
          </label>

          {draft.sourceProvider === "GITHUB" ? (
            <div className="rounded-md border border-panel-line p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase text-panel-muted">
                <span className="flex items-center gap-2">
                  <Github size={15} />
                  GitHub Import
                </span>
                <button className="rounded border border-panel-line px-2 py-1 text-[11px] text-panel-ink hover:bg-slate-50" onClick={() => setRepoPickerOpen(true)} type="button">
                  Choose repo
                </button>
              </div>
              {selectedRepo ? (
                <div className="mt-3 rounded-md bg-slate-50 p-2 text-xs">
                  <div className="font-semibold text-panel-ink">{selectedRepo.fullName}</div>
                  <div className="mt-1 text-panel-muted">Branch {draft.branch || selectedRepo.defaultBranch} · port {draft.port || "pending"}</div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Git URL
              <input className="h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, gitUrl: event.target.value })} placeholder="https://github.com/owner/repo.git" value={draft.gitUrl} />
            </label>
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Branch
              <input className="h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, branch: event.target.value })} value={draft.branch} />
            </label>
          </div>

          <label className="space-y-1 text-xs font-medium text-panel-muted">
            App root path
            <input className="h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, rootPath: event.target.value })} value={draft.rootPath} />
          </label>

          <div className="grid grid-cols-3 gap-3">
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Framework
              <select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, framework: event.target.value as DeploymentFramework })} value={draft.framework}>
                {frameworkOptions.map((framework) => <option key={framework} value={framework}>{framework}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Port
              <input className="h-9 w-full rounded-md border border-panel-line px-3 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, port: event.target.value })} value={draft.port} />
            </label>
            <label className="space-y-1 text-xs font-medium text-panel-muted">
              Database
              <select className="h-9 w-full rounded-md border border-panel-line px-2 text-sm text-panel-ink" onChange={(event) => setDraft({ ...draft, dbType: event.target.value as Draft["dbType"] })} value={draft.dbType}>
                <option value="">None</option>
                <option value="POSTGRESQL">PostgreSQL</option>
                <option value="MYSQL">MySQL</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {(["installCommand", "buildCommand", "startCommand", "outputDirectory"] as const).map((field) => (
              <input className="h-9 rounded-md border border-panel-line px-3 font-mono text-xs" key={field} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} placeholder={field} value={draft[field]} />
            ))}
          </div>

          <textarea className="h-24 w-full rounded-md border border-panel-line p-3 font-mono text-xs" onChange={(event) => setDraft({ ...draft, envText: event.target.value })} value={draft.envText} />

          <ResultNotice message={notice} ok={notice.includes("passed") || notice.includes("created") || notice.includes("imported")} />

          <div className="grid grid-cols-3 gap-2">
            <button className="flex h-10 items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50" onClick={() => detect.mutate()} type="button">
              <Wand2 size={15} />
              Detect
            </button>
            <button className="flex h-10 items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50" onClick={() => preflight.mutate()} type="button">
              <CheckCircle2 size={15} />
              Check
            </button>
            <button className="flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!draft.name || !draft.rootPath || !draft.port || createDeployment.isPending} onClick={() => createDeployment.mutate()} type="button">
              <Plus size={15} />
              Create
            </button>
          </div>
          {draft.sourceProvider === "GITHUB" ? (
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-900 text-sm font-semibold text-white disabled:opacity-60" disabled={!selectedRepo || !draft.rootPath || !draft.port || importAndDeployGithub.isPending} onClick={() => importAndDeployGithub.mutate(undefined)} type="button">
              <Play size={15} />
              Import and deploy selected GitHub project
            </button>
          ) : null}
        </div>
      </aside>

      <main className="min-h-0 overflow-hidden rounded-md border border-panel-line bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-panel-line p-4">
          <div className="flex items-center gap-2">
            <form className="relative" onSubmit={submitSearch}>
              <Search className="absolute left-3 top-2.5 text-panel-muted" size={15} />
              <input className="h-9 w-72 rounded-md border border-panel-line pl-9 pr-3 text-sm" onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search deployments" value={draftSearch} />
            </form>
            <div className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-2 text-panel-muted">
              <Filter size={14} />
              <select className="h-7 bg-transparent text-sm text-panel-ink outline-none" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                <option value="">All status</option>
                {["QUEUED", "RUNNING", "STOPPED", "DEPLOYING", "BUILDING", "FAILED"].map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </div>
            <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setSourceFilter(event.target.value)} value={sourceFilter}>
              <option value="">All sources</option>
              {sourceOptions.map((source) => <option key={source} value={source}>{source.replace("_", " ")}</option>)}
            </select>
          </div>
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-medium hover:bg-slate-50" onClick={() => deployments.refetch()} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>

        <div className="h-[calc(100%-66px)] overflow-auto">
          {(deployments.data?.items ?? []).length > 0 ? (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-panel-muted">
                <tr>
                  <th className="px-4 py-3">Project</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Runtime</th>
                  <th className="px-4 py-3">State</th>
                  <th className="px-4 py-3">Release</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {deployments.data?.items.map((deployment) => {
                  const latest = deployment.releases?.[0];
                  return (
                    <tr className="border-t border-panel-line hover:bg-slate-50" key={deployment.id}>
                      <td className="max-w-0 px-4 py-4">
                        <Link className="font-semibold text-panel-ink hover:text-panel-accent" href={`/deployments/${deployment.slug}/overview`}>{deployment.name}</Link>
                        <div className="mt-1 truncate text-xs text-panel-muted">{deployment.rootPath}</div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          {deployment.sourceProvider === "GITHUB" ? <Github size={15} /> : <FolderGit2 size={15} />}
                          <span className="text-xs font-semibold">{deployment.sourceProvider}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-xs text-panel-muted"><GitBranch size={13} />{deployment.branch}</div>
                      </td>
                      <td className="px-4 py-4 text-xs">
                        <div className="font-semibold">{deployment.framework}</div>
                        <div className="mt-1 text-panel-muted">:{deployment.port}</div>
                      </td>
                      <td className="space-y-2 px-4 py-4">
                        {statusBadge(deployment.status)}
                        <div>{healthBadge(deployment.healthStatus)}</div>
                      </td>
                      <td className="px-4 py-4 text-xs">
                        <div className="font-semibold">{latest?.status ?? "No release"}</div>
                        <div className="mt-1 text-panel-muted">{formatDate(latest?.createdAt)}</div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-2">
                          {(["deploy", "start", "stop", "restart"] as const).map((name) => (
                            <button className="flex h-8 items-center gap-1 rounded-md border border-panel-line px-2 text-xs font-medium hover:bg-slate-50 disabled:opacity-50" disabled={action.isPending} key={name} onClick={() => action.mutate({ deployment, name })} type="button">
                              {name === "deploy" ? <Play size={13} /> : name === "stop" ? <Square size={13} /> : actionIcon(name)}
                              {name}
                            </button>
                          ))}
                          <button className="flex h-8 items-center gap-1 rounded-md border border-panel-line px-2 text-xs font-medium hover:bg-slate-50 disabled:opacity-50" disabled={copyingLogsFor === deployment.id} onClick={() => copyLogs.mutate(deployment)} type="button">
                            <Clipboard size={13} />
                            logs
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="p-8">
              <EmptyState title="No deployments yet" detail="Create or import a project to start the deployment engine." />
            </div>
          )}
        </div>
      </main>

      {repoPickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="flex max-h-[82vh] w-full max-w-3xl flex-col rounded-md border border-panel-line bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Github size={17} />
                  GitHub Projects
                </div>
                <div className="mt-1 text-xs text-panel-muted">Select a repository to auto-detect framework and start deploy.</div>
              </div>
              <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50" onClick={() => setRepoPickerOpen(false)} type="button">
                <X size={16} />
              </button>
            </div>

            <div className="border-b border-panel-line p-4">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 text-panel-muted" size={15} />
                <input className="h-9 w-full rounded-md border border-panel-line pl-9 pr-3 text-sm" onChange={(event) => setRepoSearch(event.target.value)} placeholder="Search GitHub repositories" value={repoSearch} />
              </div>
              {!githubConnection.data?.connected ? (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                  <div className="text-xs font-semibold text-amber-900">Connect GitHub token</div>
                  <div className="mt-1 text-xs text-amber-800">Use a fine-grained token with repository read access for the repos you want to deploy.</div>
                  <div className="mt-3 grid grid-cols-[1fr_2fr_auto] gap-2">
                    <input className="h-9 rounded-md border border-amber-200 bg-white px-3 text-sm" onChange={(event) => setGithubUsername(event.target.value)} placeholder="username" value={githubUsername} />
                    <input className="h-9 rounded-md border border-amber-200 bg-white px-3 text-sm" onChange={(event) => setGithubToken(event.target.value)} placeholder="github_pat_..." type="password" value={githubToken} />
                    <button className="h-9 rounded-md bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!githubToken || saveGithubToken.isPending} onClick={() => saveGithubToken.mutate()} type="button">
                      Connect
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-xs text-emerald-700">Connected{githubConnection.data.username ? ` as ${githubConnection.data.username}` : ""}.</div>
              )}
              {repos.data?.note ? <div className="mt-2 text-xs text-amber-700">{repos.data.note}</div> : null}
              {repos.data?.dryRun ? <div className="mt-2 text-xs text-amber-700">GitHub token is not connected; showing dry-run placeholder repositories.</div> : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {repos.isLoading ? <div className="p-8 text-center text-sm text-panel-muted">Loading repositories...</div> : null}
              {(repos.data?.items ?? []).map((repo) => (
                <button
                  className="flex w-full items-center justify-between gap-4 rounded-md px-3 py-3 text-left hover:bg-slate-50 disabled:opacity-60"
                  disabled={importAndDeployGithub.isPending}
                  key={repo.fullName}
                  onClick={() => {
                    selectRepo(repo);
                    importAndDeployGithub.mutate(repo);
                  }}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-panel-ink">{repo.fullName}</span>
                    <span className="mt-1 block text-xs text-panel-muted">
                      {repo.private ? "private" : "public"} · {repo.defaultBranch}{repo.updatedAt ? ` · updated ${formatDate(repo.updatedAt)}` : ""}
                    </span>
                  </span>
                  <span className="flex h-8 shrink-0 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white">
                    <Play size={13} />
                    deploy
                  </span>
                </button>
              ))}
              {!repos.isLoading && (repos.data?.items ?? []).length === 0 ? (
                <div className="p-8 text-center text-sm text-panel-muted">No repositories found.</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
