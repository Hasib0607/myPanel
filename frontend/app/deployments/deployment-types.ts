export type DeploymentStatus = "QUEUED" | "RUNNING" | "STOPPED" | "DEPLOYING" | "BUILDING" | "FAILED";
export type DeploymentHealthStatus = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "DOWN";
export type DeploymentFramework = "LARAVEL" | "NEXTJS" | "NODEJS" | "PYTHON" | "GO" | "STATIC";
export type DeploymentSourceProvider = "MANUAL" | "GIT_URL" | "GITHUB" | "FILE_MANAGER" | "UPLOAD";
export type ReleaseStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "ROLLED_BACK";

export type DeploymentDomain = {
  id: string;
  name: string;
};

export type DeploymentDomainBinding = {
  id: string;
  deploymentId: string;
  domainId: string;
  role: string;
  createdAt: string;
  domain: DeploymentDomain;
};

export type DeploymentRelease = {
  id: string;
  status: ReleaseStatus;
  commitSha: string | null;
  sourcePath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  createdAt: string;
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

export type DeploymentDoctorResponse = {
  status: "pass" | "warn" | "fail";
  summary: string;
  recommendedAction: "sync-runtime" | "health" | "restart" | "redeploy" | "rollback" | "set-node-memory" | "sync-public-env" | "request-approval" | null;
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
  generatedAt: string;
};

export const frameworkOptions: DeploymentFramework[] = ["NEXTJS", "LARAVEL", "NODEJS", "PYTHON", "GO", "STATIC"];
export const sourceOptions: DeploymentSourceProvider[] = ["GITHUB", "GIT_URL", "FILE_MANAGER", "MANUAL"];
