export type DeploymentStatus = "QUEUED" | "RUNNING" | "STOPPED" | "DEPLOYING" | "BUILDING" | "FAILED";
export type DeploymentHealthStatus = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "DOWN";
export type DeploymentFramework = "LARAVEL" | "NEXTJS" | "NODEJS" | "PYTHON" | "GO" | "STATIC";
export type DeploymentSourceProvider = "MANUAL" | "GIT_URL" | "GITHUB" | "FILE_MANAGER" | "UPLOAD";
export type ReleaseStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "ROLLED_BACK";

export type DeploymentDomain = {
  id: string;
  name: string;
};

export type DeploymentSubdomain = {
  id: string;
  name: string;
  sslEnabled?: boolean;
  domain: DeploymentDomain;
};

export type DeploymentDomainBinding = {
  id: string;
  deploymentId: string;
  domainId: string | null;
  subdomainId?: string | null;
  role: string;
  createdAt: string;
  domain: DeploymentDomain | null;
  subdomain?: DeploymentSubdomain | null;
};

export type DeploymentRelease = {
  id: string;
  status: ReleaseStatus;
  commitSha: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  sourcePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  logs?: DeploymentLog[];
};

export type DeploymentLog = {
  id: string;
  releaseId: string | null;
  step: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type DeploymentEnvVar = {
  id: string;
  key: string;
  value: string | null;
  isSecret: boolean;
  secretRef: string | null;
  masked?: boolean;
  updatedAt: string;
};

export type Deployment = {
  id: string;
  domainId: string | null;
  name: string;
  slug: string;
  framework: DeploymentFramework;
  sourceProvider: DeploymentSourceProvider;
  repoUrl: string | null;
  gitUrl: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  branch: string;
  commitSha: string | null;
  rootDirectory: string;
  rootPath: string;
  runtime: string | null;
  runtimeVersion: string | null;
  packageManager: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  publicDirectory: string | null;
  processManager: string | null;
  processConfig: Record<string, unknown>;
  healthUrl: string | null;
  port: number;
  status: DeploymentStatus;
  healthStatus: DeploymentHealthStatus;
  lastHealthCheckAt: string | null;
  autoDeployEnabled: boolean;
  dbType: "POSTGRESQL" | "MYSQL" | null;
  dbName: string | null;
  dbUser: string | null;
  dbPasswordSecretRef: string | null;
  persistentPaths: string[];
  createdAt: string;
  updatedAt: string;
  domain?: DeploymentDomain | null;
  domainBindings?: DeploymentDomainBinding[];
  env?: DeploymentEnvVar[];
  releases?: DeploymentRelease[];
  logs?: DeploymentLog[];
  _count?: {
    env: number;
    logs: number;
    releases: number;
  };
};

export type DeploymentListResponse = {
  items: Deployment[];
  total: number;
  page: number;
  pageSize: number;
};

export type DetectionResponse = {
  detected: DeploymentFramework;
  confidence: number;
  reason: string;
  suggestions: {
    runtime: string | null;
    packageManager: string | null;
    installCommand: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    outputDirectory: string | null;
    processManager: string | null;
  };
};

export type PreflightResponse = {
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};

export type QueueResponse = {
  release?: DeploymentRelease;
  queue?: { queued: boolean; jobId?: string; dryRun?: boolean; reason?: string };
  status?: DeploymentStatus;
  dryRun?: boolean;
  reason?: string;
};

export type DeploymentMetrics = {
  ok: boolean;
  generatedAt?: string;
  error?: string;
  process: {
    cpuPercent: number;
    memoryBytes: number;
    processCount: number;
    processes: Array<{ pid: number; name?: string | null; status?: string | null; cpuPercent?: number; memoryBytes?: number }>;
  };
  history?: Array<{ timestamp: string; cpuPercent: number; memoryBytes: number; processCount: number }>;
  storage: { rootPath: string; bytes: number };
  database: { engine: string | null; name: string | null; sizeBytes: number; available: boolean };
  traffic: {
    incomingBytes: number;
    outgoingBytes: number;
    bandwidthBytes: number;
    requests: number;
    topIps?: Array<{ ip: string; requests: number }>;
    topPaths?: Array<{ path: string; requests: number }>;
    botSuspects?: Array<{ userAgent: string; requests: number }>;
    sources: string[];
    windowHours: number;
    note?: string | null;
  };
  logs: { ok: boolean; text: string; stdout: string; stderr: string; laravel?: string; logDir?: string; error?: string };
  buildLogs: DeploymentLog[];
};

export type LaravelRuntimeStatus = {
  returncode?: number;
  poolName: string;
  socketPath: string;
  socketExists: boolean;
  configPath: string;
  configExists: boolean;
  processCount: number;
  processes: Array<{ pid: number; user?: string | null; cpuPercent?: number; memoryBytes?: number; cmdline?: string }>;
  queue: { recvQ: number | null; sendQ: number | null; raw?: string };
  slowlog: { path: string; exists: boolean; sizeBytes: number; modifiedAt: string | null; text: string };
  nginx: {
    serverName: string | null;
    expectedUpstream: string;
    activeSocket: boolean;
    upstreams: Array<{ file: string; path: string; upstream: string }>;
  };
  staleSupervisor: {
    configured: boolean;
    program: string;
    configPath: string;
    artisanServeProcesses: Array<{ pid: number; user?: string | null; cpuPercent?: number; memoryBytes?: number; cmdline: string }>;
  };
};

export type LaravelTimingResult = {
  url: string;
  returncode?: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
  samples: Array<{ index: number; httpCode: number; startTransferSeconds: number | null; totalSeconds: number | null }>;
};

export type DeploymentDoctorResponse = {
  status: "pass" | "warn" | "fail";
  summary: string;
  recommendedAction: "sync-runtime" | "health" | "restart" | "redeploy" | "rollback" | "set-node-memory" | "sync-public-env" | "rewrite-nginx" | "request-approval" | null;
  checks: Array<{
    key: string;
    label: string;
    status: "pass" | "warn" | "fail";
    detail: string;
    fix?: string;
    repairAction?: string;
  }>;
  evidence: string[];
  envSuggestions: Array<{ key: string; value: string; reason: string; repairAction: string }>;
  riskyActions: Array<{ key: string; label: string; command: string; reason: string; approvalRequired: true }>;
  resourceBudget?: {
    totalMemoryMb: number;
    availableMemoryMb: number;
    runningAppsMemoryMb: number;
    appReserveMb: number;
    systemReserveMb: number;
    deployMemoryMb: number;
    cpuCount: number;
    cpuQuotaPercent: number;
    nodeHeapMb: number;
    nextWorkers: number;
    swapFreeMb: number;
    runningProcessCount: number;
  } | null;
  generatedAt: string;
};

export type DeploymentDoctorApproval = {
  id: string;
  deploymentId: string;
  actionKey: string;
  label: string;
  command: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "FAILED";
  result: Record<string, unknown>;
  requestedAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

export const frameworkOptions: DeploymentFramework[] = ["NEXTJS", "LARAVEL", "NODEJS", "PYTHON", "GO", "STATIC"];
export const sourceOptions: DeploymentSourceProvider[] = ["GITHUB", "GIT_URL", "FILE_MANAGER", "MANUAL"];
