"use client";

import type { ReactNode } from "react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Database, GitBranch, Globe2, KeyRound, Save, ServerCog, Settings2, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { apiDeleteBody, apiGet, apiPatch, apiPost } from "@/lib/api";
import type { Deployment, DeploymentFramework, DeploymentSourceProvider } from "../../deployment-types";
import { ProjectTabs, ResultNotice } from "../../deployment-ui";

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

type WebhookStatus = {
  enabled: boolean;
  secretConfigured: boolean;
  webhookUrl: string;
  event: string;
  branch?: string;
  repository?: string | null;
};

type WebhookSecretResponse = WebhookStatus & {
  secret: string;
};

type LaravelWorkerConfig = {
  enabled: boolean;
  autoscale: boolean;
  desiredWorkers: number;
  minWorkers: number;
  maxWorkers: number;
  queueCommand: string;
  currentWorkers?: number;
  lastScaledAt?: string;
  lastScaleReason?: string;
};

type ResourcePolicy = {
  priorityTier: "P1" | "P2" | "P3";
  memoryMaxMb: number;
  cpuQuotaPercent: number;
  workersMax: number;
  restartDelayMs: number;
  healthStrict: boolean;
};

type WorkerStatusResponse = {
  config: LaravelWorkerConfig;
  status: {
    runningWorkers?: number;
    status?: { running?: number; configured?: number; processes?: Array<{ name: string; state: string; detail: string }> };
    error?: string;
  } | null;
};

type SettingsForm = {
  name: string;
  slug: string;
  domainId: string;
  sourceProvider: DeploymentSourceProvider;
  repoUrl: string;
  gitUrl: string;
  githubOwner: string;
  githubRepo: string;
  branch: string;
  commitSha: string;
  framework: DeploymentFramework;
  runtime: string;
  runtimeVersion: string;
  packageManager: string;
  processManager: string;
  rootDirectory: string;
  rootPath: string;
  port: string;
  healthUrl: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  publicDirectory: string;
  persistentPaths: string;
  dbType: string;
  dbName: string;
  dbUser: string;
  autoDeployEnabled: boolean;
  priorityTier: "P1" | "P2" | "P3";
  memoryMaxMb: string;
  cpuQuotaPercent: string;
  workersPolicyMax: string;
  restartDelayMs: string;
  healthStrict: boolean;
  workersEnabled: boolean;
  workersAutoscale: boolean;
  workersDesired: string;
  workersMin: string;
  workersMax: string;
  workersQueueCommand: string;
};

const emptyForm: SettingsForm = {
  name: "",
  slug: "",
  domainId: "",
  sourceProvider: "MANUAL",
  repoUrl: "",
  gitUrl: "",
  githubOwner: "",
  githubRepo: "",
  branch: "main",
  commitSha: "",
  framework: "STATIC",
  runtime: "",
  runtimeVersion: "",
  packageManager: "",
  processManager: "",
  rootDirectory: ".",
  rootPath: "",
  port: "10000",
  healthUrl: "",
  installCommand: "",
  buildCommand: "",
  startCommand: "",
  outputDirectory: "",
  publicDirectory: "",
  persistentPaths: "",
  dbType: "",
  dbName: "",
  dbUser: "",
  autoDeployEnabled: false,
  priorityTier: "P2",
  memoryMaxMb: "2048",
  cpuQuotaPercent: "200",
  workersPolicyMax: "2",
  restartDelayMs: "3000",
  healthStrict: false,
  workersEnabled: false,
  workersAutoscale: false,
  workersDesired: "0",
  workersMin: "0",
  workersMax: "8",
  workersQueueCommand: "php artisan queue:work --sleep=3 --tries=3 --timeout=90"
};

const frameworks: DeploymentFramework[] = ["NEXTJS", "LARAVEL", "NODEJS", "PYTHON", "GO", "STATIC"];
const sourceProviders: DeploymentSourceProvider[] = ["GITHUB", "GIT_URL", "FILE_MANAGER", "UPLOAD", "MANUAL"];
const runtimes = ["", "NODE", "PHP", "PYTHON", "GO", "STATIC"];
const packageManagers = ["", "NPM", "PNPM", "YARN", "COMPOSER", "PIP", "UV", "GO", "NONE"];
const processManagers = ["", "PM2", "SUPERVISOR", "SYSTEMD", "STATIC", "NONE"];
const dbTypes = ["", "POSTGRESQL", "MYSQL"];
const priorityTiers: Array<"P1" | "P2" | "P3"> = ["P1", "P2", "P3"];
const priorityDefaults: Record<"P1" | "P2" | "P3", ResourcePolicy> = {
  P1: { priorityTier: "P1", memoryMaxMb: 6144, cpuQuotaPercent: 400, workersMax: 5, restartDelayMs: 1000, healthStrict: true },
  P2: { priorityTier: "P2", memoryMaxMb: 2048, cpuQuotaPercent: 200, workersMax: 2, restartDelayMs: 3000, healthStrict: false },
  P3: { priorityTier: "P3", memoryMaxMb: 1024, cpuQuotaPercent: 100, workersMax: 1, restartDelayMs: 8000, healthStrict: false }
};

function resourcePolicyFromDeployment(deployment: Deployment): ResourcePolicy {
  const rawConfig = deployment.processConfig ?? {};
  const raw = rawConfig.resourcePolicy && typeof rawConfig.resourcePolicy === "object" && !Array.isArray(rawConfig.resourcePolicy)
    ? rawConfig.resourcePolicy as Partial<ResourcePolicy>
    : {};
  const tier = raw.priorityTier === "P1" || raw.priorityTier === "P3" ? raw.priorityTier : "P2";
  return { ...priorityDefaults[tier], ...raw, priorityTier: tier };
}

function laravelWorkersFromDeployment(deployment: Deployment): LaravelWorkerConfig {
  const raw = (deployment.processConfig?.laravelWorkers && typeof deployment.processConfig.laravelWorkers === "object")
    ? deployment.processConfig.laravelWorkers as Partial<LaravelWorkerConfig>
    : {};
  return {
    enabled: Boolean(raw.enabled),
    autoscale: Boolean(raw.autoscale),
    desiredWorkers: Number(raw.desiredWorkers ?? raw.currentWorkers ?? 0),
    minWorkers: Number(raw.minWorkers ?? 0),
    maxWorkers: Number(raw.maxWorkers ?? 8),
    queueCommand: raw.queueCommand || "php artisan queue:work --sleep=3 --tries=3 --timeout=90",
    currentWorkers: raw.currentWorkers,
    lastScaledAt: raw.lastScaledAt,
    lastScaleReason: raw.lastScaleReason
  };
}

function formFromDeployment(deployment: Deployment): SettingsForm {
  const workers = laravelWorkersFromDeployment(deployment);
  const resourcePolicy = resourcePolicyFromDeployment(deployment);
  return {
    name: deployment.name,
    slug: deployment.slug,
    domainId: deployment.domainId ?? "",
    sourceProvider: deployment.sourceProvider,
    repoUrl: deployment.repoUrl ?? "",
    gitUrl: deployment.gitUrl ?? "",
    githubOwner: deployment.githubOwner ?? "",
    githubRepo: deployment.githubRepo ?? "",
    branch: deployment.branch,
    commitSha: deployment.commitSha ?? "",
    framework: deployment.framework,
    runtime: deployment.runtime ?? "",
    runtimeVersion: deployment.runtimeVersion ?? "",
    packageManager: deployment.packageManager ?? "",
    processManager: deployment.processManager ?? "",
    rootDirectory: deployment.rootDirectory,
    rootPath: deployment.rootPath,
    port: String(deployment.port),
    healthUrl: deployment.healthUrl ?? "",
    installCommand: deployment.installCommand ?? "",
    buildCommand: deployment.buildCommand ?? "",
    startCommand: deployment.startCommand ?? "",
    outputDirectory: deployment.outputDirectory ?? "",
    publicDirectory: deployment.publicDirectory ?? "",
    persistentPaths: (deployment.persistentPaths ?? []).join("\n"),
    dbType: deployment.dbType ?? "",
    dbName: deployment.dbName ?? "",
    dbUser: deployment.dbUser ?? "",
    autoDeployEnabled: deployment.autoDeployEnabled,
    priorityTier: resourcePolicy.priorityTier,
    memoryMaxMb: String(resourcePolicy.memoryMaxMb),
    cpuQuotaPercent: String(resourcePolicy.cpuQuotaPercent),
    workersPolicyMax: String(resourcePolicy.workersMax),
    restartDelayMs: String(resourcePolicy.restartDelayMs),
    healthStrict: resourcePolicy.healthStrict,
    workersEnabled: workers.enabled,
    workersAutoscale: workers.autoscale,
    workersDesired: String(workers.desiredWorkers),
    workersMin: String(workers.minWorkers),
    workersMax: String(workers.maxWorkers),
    workersQueueCommand: workers.queueCommand
  };
}

function nullable(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberFromString(value: string) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function DeploymentSettingsClient({ project }: { project: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SettingsForm>(emptyForm);
  const [notice, setNotice] = useState("");
  const [deleteText, setDeleteText] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState("");
  const [laravelProcessesJson, setLaravelProcessesJson] = useState("");

  const detail = useQuery({
    queryKey: ["deployment", project],
    queryFn: () => apiGet<Deployment>(`/deployments/${project}`)
  });
  const domains = useQuery({
    queryKey: ["domains", "deployment-settings"],
    queryFn: () => apiGet<DomainListResponse>("/domains?page=1&pageSize=100")
  });
  const webhook = useQuery({
    queryKey: ["deployment", project, "webhook"],
    queryFn: () => apiGet<WebhookStatus>(`/deployments/${project}/webhook`)
  });
  const workers = useQuery({
    queryKey: ["deployment", project, "workers"],
    queryFn: () => apiGet<WorkerStatusResponse>(`/deployments/${project}/workers`),
    enabled: detail.data?.framework === "LARAVEL"
  });
  const laravelProcesses = useQuery({
    queryKey: ["deployment", project, "laravel-processes"],
    queryFn: () => apiGet<Record<string, unknown>>(`/deployments/${project}/laravel-processes`),
    enabled: detail.data?.framework === "LARAVEL"
  });

  useEffect(() => {
    if (detail.data) setForm(formFromDeployment(detail.data));
  }, [detail.data]);
  useEffect(() => {
    if (laravelProcesses.data) setLaravelProcessesJson(JSON.stringify(laravelProcesses.data, null, 2));
  }, [laravelProcesses.data]);

  const payload = useMemo(() => ({
    name: form.name.trim(),
    slug: form.slug.trim(),
    domainId: form.domainId || null,
    sourceProvider: form.sourceProvider,
    repoUrl: nullable(form.repoUrl),
    gitUrl: nullable(form.gitUrl),
    githubOwner: nullable(form.githubOwner),
    githubRepo: nullable(form.githubRepo),
    branch: form.branch.trim() || "main",
    commitSha: nullable(form.commitSha),
    framework: form.framework,
    runtime: nullable(form.runtime),
    runtimeVersion: nullable(form.runtimeVersion),
    packageManager: nullable(form.packageManager),
    processManager: nullable(form.processManager),
    rootDirectory: form.rootDirectory.trim() || ".",
    rootPath: form.rootPath.trim(),
    port: Number(form.port),
    healthUrl: nullable(form.healthUrl),
    installCommand: nullable(form.installCommand),
    buildCommand: nullable(form.buildCommand),
    startCommand: nullable(form.startCommand),
    outputDirectory: nullable(form.outputDirectory),
    publicDirectory: nullable(form.publicDirectory),
    persistentPaths: form.persistentPaths.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    dbType: nullable(form.dbType),
    dbName: nullable(form.dbName),
    dbUser: nullable(form.dbUser),
    autoDeployEnabled: form.autoDeployEnabled,
    processConfig: {
      ...(detail.data?.processConfig ?? {}),
      resourcePolicy: {
        priorityTier: form.priorityTier,
        memoryMaxMb: numberFromString(form.memoryMaxMb),
        cpuQuotaPercent: numberFromString(form.cpuQuotaPercent),
        workersMax: numberFromString(form.workersPolicyMax),
        restartDelayMs: numberFromString(form.restartDelayMs),
        healthStrict: form.healthStrict
      }
    }
  }), [detail.data?.processConfig, form]);

  const save = useMutation({
    mutationFn: () => apiPatch<Deployment>(`/deployments/${project}`, payload),
    onSuccess: async (deployment) => {
      setNotice("Settings saved.");
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
      if (deployment.slug !== project) router.replace(`/deployments/${deployment.slug}/settings`);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save settings")
  });

  const remove = useMutation({
    mutationFn: () => apiDeleteBody<{ ok: true }>(`/deployments/${project}`, { confirmSlug: deleteText }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["deployments"] });
      router.replace("/deployments");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete project")
  });

  const generateWebhookSecret = useMutation({
    mutationFn: () => apiPost<WebhookSecretResponse>(`/deployments/${project}/webhook-secret`),
    onSuccess: async (result) => {
      setNewWebhookSecret(result.secret);
      setField("autoDeployEnabled", true);
      setNotice("Webhook secret generated. Copy it now; it will only be shown once.");
      await queryClient.invalidateQueries({ queryKey: ["deployment", project, "webhook"] });
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not generate webhook secret")
  });

  const saveWorkers = useMutation({
    mutationFn: () => apiPatch<{ config: LaravelWorkerConfig }>(`/deployments/${project}/workers`, {
      laravelWorkers: {
        enabled: form.workersEnabled,
        autoscale: form.workersAutoscale,
        desiredWorkers: numberFromString(form.workersDesired),
        minWorkers: numberFromString(form.workersMin),
        maxWorkers: Math.max(1, numberFromString(form.workersMax)),
        queueCommand: form.workersQueueCommand.trim() || "php artisan queue:work --sleep=3 --tries=3 --timeout=90"
      }
    }),
    onSuccess: async (result) => {
      setNotice(`Laravel workers saved. Running: ${result.config.currentWorkers ?? result.config.desiredWorkers}.`);
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
      await queryClient.invalidateQueries({ queryKey: ["deployment", project, "workers"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save Laravel workers")
  });
  const saveLaravelProcesses = useMutation({
    mutationFn: () => apiPatch(`/deployments/${project}/laravel-processes`, {
      laravelManagedProcesses: JSON.parse(laravelProcessesJson)
    }),
    onSuccess: async () => {
      setNotice("Laravel scheduler, Horizon, Reverb, Octane, and queue groups saved.");
      await queryClient.invalidateQueries({ queryKey: ["deployment", project, "laravel-processes"] });
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save Laravel managed processes")
  });

  function setField<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  const domainLabels = (domains.data?.items ?? []).reduce<Record<string, string>>((acc, domain) => ({ ...acc, [domain.id]: domain.name }), { "": "No domain" });
  const deleteMatches = detail.data ? deleteText === detail.data.slug : false;

  return (
    <>
      <ProjectTabs active="settings" project={project} />
      <form className="space-y-6 p-8" onSubmit={submit}>
        {notice ? <ResultNotice message={notice} ok={!/could|error|failed/i.test(notice)} /> : null}

        <Section icon={<Settings2 size={16} />} title="Project">
          <div className="grid grid-cols-3 gap-3">
            <TextInput label="Name" onChange={(value) => setField("name", value)} required value={form.name} />
            <TextInput label="Slug" onChange={(value) => setField("slug", value.toLowerCase())} required value={form.slug} />
            <SelectInput label="Domain" labels={domainLabels} onChange={(value) => setField("domainId", value)} options={["", ...(domains.data?.items ?? []).map((domain) => domain.id)]} value={form.domainId} />
          </div>
        </Section>

        <Section icon={<ShieldCheck size={16} />} title="Priority And Resource Limits">
          <div className="grid grid-cols-4 gap-3">
            <SelectInput
              label="Priority tier"
              labels={{ P1: "P1 Critical", P2: "P2 Normal", P3: "P3 Low" }}
              onChange={(value) => {
                const tier = value as "P1" | "P2" | "P3";
                const defaults = priorityDefaults[tier];
                setForm((current) => ({
                  ...current,
                  priorityTier: tier,
                  memoryMaxMb: String(defaults.memoryMaxMb),
                  cpuQuotaPercent: String(defaults.cpuQuotaPercent),
                  workersPolicyMax: String(defaults.workersMax),
                  restartDelayMs: String(defaults.restartDelayMs),
                  healthStrict: defaults.healthStrict
                }));
              }}
              options={priorityTiers}
              value={form.priorityTier}
            />
            <TextInput label="RAM cap MB" onChange={(value) => setField("memoryMaxMb", value.replace(/\D/g, ""))} value={form.memoryMaxMb} />
            <TextInput label="CPU quota %" onChange={(value) => setField("cpuQuotaPercent", value.replace(/\D/g, ""))} value={form.cpuQuotaPercent} />
            <TextInput label="Worker cap" onChange={(value) => setField("workersPolicyMax", value.replace(/\D/g, ""))} value={form.workersPolicyMax} />
            <TextInput label="Restart delay ms" onChange={(value) => setField("restartDelayMs", value.replace(/\D/g, ""))} value={form.restartDelayMs} />
            <ToggleInput checked={form.healthStrict} label="Strict health" onChange={(value) => setField("healthStrict", value)} />
          </div>
        </Section>

        <Section icon={<GitBranch size={16} />} title="Source Connection">
          <div className="grid grid-cols-3 gap-3">
            <SelectInput label="Provider" onChange={(value) => setField("sourceProvider", value as DeploymentSourceProvider)} options={sourceProviders} value={form.sourceProvider} />
            <TextInput label="Git URL" onChange={(value) => setField("gitUrl", value)} value={form.gitUrl} />
            <TextInput label="Repository URL" onChange={(value) => setField("repoUrl", value)} value={form.repoUrl} />
            <TextInput label="GitHub owner" onChange={(value) => setField("githubOwner", value)} value={form.githubOwner} />
            <TextInput label="GitHub repo" onChange={(value) => setField("githubRepo", value)} value={form.githubRepo} />
            <TextInput label="Branch" onChange={(value) => setField("branch", value)} value={form.branch} />
            <TextInput label="Commit SHA" onChange={(value) => setField("commitSha", value)} value={form.commitSha} />
            <ToggleInput checked={form.autoDeployEnabled} label="Auto deploy" onChange={(value) => setField("autoDeployEnabled", value)} />
          </div>
        </Section>

        <Section icon={<KeyRound size={16} />} title="GitHub Push Webhook">
          <div className="grid gap-4">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <ReadOnlyValue label="Payload URL" value={webhook.data?.webhookUrl ?? "Loading..."} />
              <button
                className="mt-6 flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50"
                onClick={() => navigator.clipboard.writeText(webhook.data?.webhookUrl ?? "")}
                type="button"
              >
                <Copy size={15} />
                Copy
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <ReadOnlyValue label="Event" value={webhook.data?.event ?? "push"} />
              <ReadOnlyValue label="Branch" value={webhook.data?.branch ?? form.branch} />
              <ReadOnlyValue label="Secret" value={webhook.data?.secretConfigured ? "Configured" : "Not configured"} />
            </div>
            <div className="rounded-md border border-panel-line bg-slate-50 p-3 text-xs text-panel-muted">
              Add this URL in GitHub repository settings under Webhooks. Content type must be application/json, event should be push, and the secret must match the generated value below.
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-panel-line p-3">
              <div>
                <div className="text-sm font-semibold">Webhook signing secret</div>
                <div className="mt-1 text-xs text-panel-muted">Generating a secret also enables auto deploy for this project.</div>
              </div>
              <button
                className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={generateWebhookSecret.isPending}
                onClick={() => generateWebhookSecret.mutate()}
                type="button"
              >
                <KeyRound size={15} />
                {webhook.data?.secretConfigured ? "Rotate Secret" : "Generate Secret"}
              </button>
            </div>
            {newWebhookSecret ? (
              <div className="grid grid-cols-[1fr_auto] gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <div>
                  <div className="text-xs font-semibold uppercase text-amber-800">Copy this secret now</div>
                  <div className="mt-2 break-all font-mono text-xs text-amber-950">{newWebhookSecret}</div>
                </div>
                <button
                  className="flex h-10 items-center gap-2 rounded-md border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-900"
                  onClick={() => navigator.clipboard.writeText(newWebhookSecret)}
                  type="button"
                >
                  <Copy size={15} />
                  Copy
                </button>
              </div>
            ) : null}
          </div>
        </Section>

        <Section icon={<ServerCog size={16} />} title="Runtime And Commands">
          <div className="grid grid-cols-4 gap-3">
            <SelectInput label="Framework" onChange={(value) => setField("framework", value as DeploymentFramework)} options={frameworks} value={form.framework} />
            <SelectInput label="Runtime" labels={{ "": "Unset" }} onChange={(value) => setField("runtime", value)} options={runtimes} value={form.runtime} />
            <SelectInput label="Package manager" labels={{ "": "Unset" }} onChange={(value) => setField("packageManager", value)} options={packageManagers} value={form.packageManager} />
            <SelectInput label="Process manager" labels={{ "": "Unset" }} onChange={(value) => setField("processManager", value)} options={processManagers} value={form.processManager} />
            <TextInput label="Runtime version" onChange={(value) => setField("runtimeVersion", value)} value={form.runtimeVersion} />
            <TextInput label="Install command" onChange={(value) => setField("installCommand", value)} value={form.installCommand} />
            <TextInput label="Build command" onChange={(value) => setField("buildCommand", value)} value={form.buildCommand} />
            <TextInput label="Start command" onChange={(value) => setField("startCommand", value)} value={form.startCommand} />
          </div>
        </Section>

        {detail.data?.framework === "LARAVEL" ? (
          <Section icon={<Workflow size={16} />} title="Laravel Queue Workers">
            <div className="grid grid-cols-4 gap-3">
              <ToggleInput checked={form.workersEnabled} label="Enable workers" onChange={(value) => setField("workersEnabled", value)} />
              <ToggleInput checked={form.workersAutoscale} label="Guardian autoscale" onChange={(value) => setField("workersAutoscale", value)} />
              <ReadOnlyValue label="Running now" value={String(workers.data?.status?.runningWorkers ?? workers.data?.status?.status?.running ?? workers.data?.config.currentWorkers ?? 0)} />
              <ReadOnlyValue label="Last scale" value={workers.data?.config.lastScaleReason ?? "Not scaled yet"} />
              <TextInput label="Desired workers" onChange={(value) => setField("workersDesired", value.replace(/\D/g, ""))} value={form.workersDesired} />
              <TextInput label="Minimum workers" onChange={(value) => setField("workersMin", value.replace(/\D/g, ""))} value={form.workersMin} />
              <TextInput label="Maximum workers" onChange={(value) => setField("workersMax", value.replace(/\D/g, ""))} value={form.workersMax} />
              <div className="flex items-end">
                <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={saveWorkers.isPending} onClick={() => saveWorkers.mutate()} type="button">
                  <Workflow size={15} />
                  Apply Workers
                </button>
              </div>
            </div>
            <div className="mt-3">
              <TextInput label="Queue command" onChange={(value) => setField("workersQueueCommand", value)} value={form.workersQueueCommand} />
            </div>
            {workers.data?.status?.error ? <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{workers.data.status.error}</div> : null}
          </Section>
        ) : null}

        {form.framework === "LARAVEL" ? (
          <Section icon={<ServerCog size={16} />} title="Laravel Managed Processes">
            <p className="mb-3 text-sm text-panel-muted">
              Configure Scheduler, Horizon, Reverb, Octane, and independent queue groups. Octane replaces the main Laravel start command; the other enabled processes run under Supervisor.
            </p>
            <textarea
              className="h-80 w-full rounded-md border border-panel-line p-3 font-mono text-xs normal-case text-panel-ink"
              onChange={(event) => setLaravelProcessesJson(event.target.value)}
              spellCheck={false}
              value={laravelProcessesJson}
            />
            <button
              className="mt-3 flex h-10 items-center justify-center gap-2 rounded-md border border-panel-line px-4 text-sm font-semibold hover:bg-slate-50 disabled:opacity-60"
              disabled={saveLaravelProcesses.isPending || !laravelProcessesJson.trim()}
              onClick={() => saveLaravelProcesses.mutate()}
              type="button"
            >
              <Workflow size={15} />
              Apply Managed Processes
            </button>
          </Section>
        ) : null}

        <Section icon={<Globe2 size={16} />} title="Paths And Network">
          <div className="grid grid-cols-3 gap-3">
            <TextInput label="Root directory" onChange={(value) => setField("rootDirectory", value)} required value={form.rootDirectory} />
            <TextInput label="Root path" onChange={(value) => setField("rootPath", value)} required value={form.rootPath} />
            <TextInput label="Port (auto)" onChange={(value) => setField("port", value.replace(/\D/g, ""))} readOnly required value={form.port} />
            <TextInput label="Health URL" onChange={(value) => setField("healthUrl", value)} value={form.healthUrl} />
            <TextInput label="Output directory" onChange={(value) => setField("outputDirectory", value)} value={form.outputDirectory} />
            <TextInput label="Public directory" onChange={(value) => setField("publicDirectory", value)} value={form.publicDirectory} />
          </div>
          <label className="mt-3 block text-xs font-medium uppercase text-panel-muted">
            Persistent paths
            <textarea className="mt-2 h-24 w-full rounded-md border border-panel-line p-3 font-mono text-sm normal-case text-panel-ink" onChange={(event) => setField("persistentPaths", event.target.value)} value={form.persistentPaths} />
          </label>
        </Section>

        <Section icon={<Database size={16} />} title="Database Metadata">
          <div className="grid grid-cols-3 gap-3">
            <SelectInput label="Database type" labels={{ "": "None" }} onChange={(value) => setField("dbType", value)} options={dbTypes} value={form.dbType} />
            <TextInput label="Database name" onChange={(value) => setField("dbName", value)} value={form.dbName} />
            <TextInput label="Database user" onChange={(value) => setField("dbUser", value)} value={form.dbUser} />
          </div>
        </Section>

        <div className="flex justify-end">
          <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={save.isPending || !form.name || !form.slug || !form.rootPath || !form.port} type="submit">
            <Save size={15} />
            Save Settings
          </button>
        </div>
      </form>

      <section className="px-8 pb-8">
        <div className="rounded-md border border-red-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-panel-danger"><Trash2 size={16} />Delete Project</div>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-3">
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDeleteText(event.target.value)} placeholder={`Type ${detail.data?.slug ?? "project slug"} to confirm`} value={deleteText} />
            <button className="flex h-10 items-center gap-2 rounded-md border border-red-200 px-4 text-sm font-semibold text-panel-danger hover:bg-red-50 disabled:opacity-50" disabled={!deleteMatches || remove.isPending} onClick={() => remove.mutate()} type="button">
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-panel-line bg-white">
      <div className="flex items-center gap-2 border-b border-panel-line p-4 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function TextInput({ label, value, onChange, required, readOnly }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; readOnly?: boolean }) {
  return (
    <label className="block text-xs font-medium uppercase text-panel-muted">
      {label}
      <input className={`mt-2 h-10 w-full rounded-md border border-panel-line px-3 text-sm normal-case text-panel-ink ${readOnly ? "bg-slate-50 text-panel-muted" : ""}`} onChange={(event) => onChange(event.target.value)} readOnly={readOnly} required={required} value={value} />
    </label>
  );
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <label className="block text-xs font-medium uppercase text-panel-muted">
      {label}
      <div className="mt-2 flex h-10 items-center rounded-md border border-panel-line bg-slate-50 px-3 font-mono text-xs normal-case text-panel-ink">{value}</div>
    </label>
  );
}

function SelectInput({ label, value, options, labels = {}, onChange }: { label: string; value: string; options: readonly string[]; labels?: Record<string, string>; onChange: (value: string) => void }) {
  return (
    <label className="block text-xs font-medium uppercase text-panel-muted">
      {label}
      <select className="mt-2 h-10 w-full rounded-md border border-panel-line px-3 text-sm normal-case text-panel-ink" onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => <option key={option || "empty"} value={option}>{labels[option] ?? option}</option>)}
      </select>
    </label>
  );
}

function ToggleInput({ checked, label, onChange }: { checked: boolean; label: string; onChange: (value: boolean) => void }) {
  return (
    <label className="mt-7 flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm text-panel-ink">
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      {label}
    </label>
  );
}
