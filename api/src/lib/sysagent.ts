import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { env } from "../config/env.js";

export type SysagentCommandResult = {
  dryRun?: boolean;
  command?: string[];
  cwd?: string | null;
  stdout?: string;
  stderr?: string;
  returncode?: number;
  signal?: string;
};

export type DnsZoneApplyResult = {
  write?: SysagentCommandResult;
  zoneCheck?: SysagentCommandResult;
  confCheck?: SysagentCommandResult;
  reload?: SysagentCommandResult;
  localCheck?: SysagentCommandResult;
  zonePath?: string;
  rolledBack?: boolean;
};

export type DnsZoneStatusResult = {
  domain: string;
  zonePath: string;
  zoneFileExists: boolean;
  declared: boolean;
  loaded: boolean;
  authoritative: boolean;
  ok: boolean;
  zonestatus: SysagentCommandResult;
  localCheck: SysagentCommandResult;
};

function failedCommand(result: SysagentCommandResult | undefined) {
  return typeof result?.returncode === "number" && result.returncode !== 0;
}

export function assertDnsZoneApplySucceeded(domain: string, result: DnsZoneApplyResult) {
  if (result.write?.dryRun) return result;
  const failedStep = [
    ["zone validation", result.zoneCheck],
    ["BIND configuration validation", result.confCheck],
    ["BIND reload", result.reload],
    ["local authoritative check", result.localCheck]
  ].find(([, step]) => failedCommand(step as SysagentCommandResult | undefined));
  const localAnswer = result.localCheck?.stdout?.trim();
  if (!result.rolledBack && !failedStep && localAnswer) return result;

  const [label, step] = failedStep ?? ["local authoritative check", result.localCheck];
  const detail = (step as SysagentCommandResult | undefined)?.stderr?.trim()
    || (step as SysagentCommandResult | undefined)?.stdout?.trim()
    || (result.rolledBack ? "the live change was rolled back" : "the zone did not return an SOA record locally");
  throw new Error(`DNS zone publish failed for ${domain} during ${label}: ${detail}`);
}

export type SysagentBackupCreateJob = {
  jobId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  archivePath: string;
  stagingDir: string;
  includes: string[];
  sizeBytes?: number | string | null;
  sizeBytesText?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  result: SysagentCommandResult;
};

export type SysagentBackupUploadJob = {
  jobId: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  archivePath: string;
  remoteTarget: string;
  remotePath: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  result: SysagentCommandResult;
};

export type SysagentLargestFile = {
  path: string;
  name: string;
  root: string;
  sizeBytes: number | string;
  modifiedAt: string | null;
  deletable: boolean;
  deleteReason?: string | null;
};

const sysagentResponseTimeoutMs = 31 * 60 * 1000;

export async function requestSysagentJson<T>(url: URL, init?: RequestInit, timeoutMs = sysagentResponseTimeoutMs): Promise<T> {
  const rawBody = init?.body;
  if (rawBody !== undefined && rawBody !== null && typeof rawBody !== "string" && !Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
    throw new Error("sysagent request body must be a string or byte buffer");
  }
  const body = rawBody === undefined || rawBody === null ? null : Buffer.from(rawBody as string | Uint8Array);
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));

  return new Promise<T>((resolve, reject) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(url, {
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries())
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const responseBody = Buffer.concat(chunks).toString("utf8");
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`failed with ${statusCode}${responseBody ? `: ${responseBody}` : ""}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch (error) {
          reject(new Error(`returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)));
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await requestSysagentJson<T>(new URL(path, `${env.SYSAGENT_URL.replace(/\/$/, "")}/`), init);
  } catch (error) {
    const cause = (error as any)?.cause;
    const detail = cause?.code ? `${cause.code}${cause.address ? ` ${cause.address}` : ""}${cause.port ? `:${cause.port}` : ""}` : error instanceof Error ? error.message : String(error);
    throw new Error(`sysagent ${path} request failed: ${detail}`);
  }
}

export const sysagent = {
  health: () => request<{ ok?: boolean; status?: string }>("/health"),
  stats: () => request("/system/stats"),
  backupPlan: () => request<{ backupRoot: string; appDir?: string; liveEnabled: boolean; freeBytes: number; includes: string[] }>("/backup/plan"),
  backupCoverage: (body: unknown) =>
    request("/backup/coverage", { method: "POST", body: JSON.stringify(body) }),
  backupArchives: () => request<{ items: Array<{ path: string; name: string; sizeBytes: number | string; sizeBytesText?: string | null; modifiedAt: string; checksumPath: string }> }>("/backup/archives"),
  createBackup: (body: unknown) =>
    request<{ archivePath: string; stagingDir: string; includes: string[]; sizeBytes?: number | string | null; sizeBytesText?: string | null; result: SysagentCommandResult }>("/backup/create", { method: "POST", body: JSON.stringify(body) }),
  createBackupJob: (body: unknown) =>
    request<SysagentBackupCreateJob>("/backup/create-jobs", { method: "POST", body: JSON.stringify(body) }),
  backupCreateJob: (jobId: string) =>
    request<SysagentBackupCreateJob>(`/backup/create-jobs/${encodeURIComponent(jobId)}`),
  uploadBackupToRemote: (body: unknown) =>
    request<{ archivePath: string; remoteTarget: string; remotePath: string; result: SysagentCommandResult }>("/backup/upload-remote", { method: "POST", body: JSON.stringify(body) }),
  uploadBackupJob: (body: unknown) =>
    request<SysagentBackupUploadJob>("/backup/upload-jobs", { method: "POST", body: JSON.stringify(body) }),
  backupUploadJob: (jobId: string) =>
    request<SysagentBackupUploadJob>(`/backup/upload-jobs/${encodeURIComponent(jobId)}`),
  downloadBackupFromRemote: (body: unknown) =>
    request<{ archivePath: string; remotePath: string; skipped: boolean; result: SysagentCommandResult }>("/backup/download-remote", { method: "POST", body: JSON.stringify(body) }),
  pruneRemoteBackups: (body: unknown) =>
    request<{ remoteTarget: string; kept: string[]; removed: string[]; result: SysagentCommandResult }>("/backup/prune-remote", { method: "POST", body: JSON.stringify(body) }),
  remoteBackupStatus: (body: unknown) =>
    request<{ remoteTarget: string; about?: Record<string, unknown> | null; backupSize?: { count?: number; bytes?: number | string } | null; latest: string[]; result: SysagentCommandResult }>("/backup/remote-status", { method: "POST", body: JSON.stringify(body) }),
  restorePreview: (path: string) =>
    request<{ archivePath: string; commands: string[]; note: string }>(`/backup/restore-preview?path=${encodeURIComponent(path)}`, { method: "POST" }),
  restoreBackup: (body: unknown) =>
    request<{ archivePath: string; commands: string[]; result: SysagentCommandResult }>("/backup/restore", { method: "POST", body: JSON.stringify(body) }),
  verifyBackup: (path: string) =>
    request<{ ok: boolean; archivePath: string; result?: SysagentCommandResult; error?: string }>(`/backup/verify?path=${encodeURIComponent(path)}`, { method: "POST" }),
  backupManifest: (path: string) =>
    request<{ archivePath: string; result: SysagentCommandResult; entries: string[] }>(`/backup/manifest?path=${encodeURIComponent(path)}`, { method: "POST" }),
  deleteBackupArchive: (path: string) =>
    request<{ archivePath: string; result: SysagentCommandResult }>(`/backup/archive?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  deleteRemoteBackup: (body: unknown) =>
    request<{ remotePath: string; result: SysagentCommandResult }>("/backup/delete-remote", { method: "POST", body: JSON.stringify(body) }),
  pruneBackups: (body: unknown) =>
    request<{ kept: number; removed: string[]; result: SysagentCommandResult }>("/backup/prune", { method: "POST", body: JSON.stringify(body) }),
  guardianDiagnosis: () => request("/guardian/diagnosis"),
  reloadPanelEnv: () =>
    request<{ reloaded: boolean; liveSystemCommandsEnabled: boolean; panelEnvPath?: string | null }>("/system/reload-env", { method: "POST" }),
  guardianRestartService: (serviceKey: string) =>
    request("/guardian/actions/restart-service", { method: "POST", body: JSON.stringify({ serviceKey }) }),
  guardianRestartPm2: (body: { name?: string; pmId?: number }) =>
    request("/guardian/actions/restart-pm2", { method: "POST", body: JSON.stringify(body) }),
  guardianReloadNginx: () =>
    request("/guardian/actions/reload-nginx", { method: "POST" }),
  guardianRestartNginx: () =>
    request<{ action: string; restarted: boolean; test: SysagentCommandResult; restart: SysagentCommandResult | null }>("/guardian/actions/restart-nginx", { method: "POST" }),
  guardianCleanupLogs: (olderThanDays = 1) =>
    request("/guardian/actions/cleanup-logs", { method: "POST", body: JSON.stringify({ olderThanDays }) }),
  guardianBlockIp: (body: { ip: string; reason?: string }) =>
    request("/guardian/actions/block-ip", { method: "POST", body: JSON.stringify(body) }),
  guardianUnblockIp: (body: { ip: string; reason?: string }) =>
    request("/guardian/actions/unblock-ip", { method: "POST", body: JSON.stringify(body) }),
  guardianFileWatch: () =>
    request<{ roots: string[]; scanned: number; findings: Array<{ path: string; reason: string; risk: "WARNING" | "CRITICAL"; sizeBytes: number; mode?: string; owner?: string; modifiedAt?: string }> }>("/guardian/file-watch"),
  guardianRateLimitTemplates: () =>
    request<{ templates: Array<{ mode: string; content: string }> }>("/guardian/nginx-rate-limit/templates"),
  guardianApplyRateLimit: (mode: "balanced" | "strict") =>
    request("/guardian/nginx-rate-limit/apply", { method: "POST", body: JSON.stringify({ mode }) }),
  guardianIpEvidence: (ip: string) =>
    request<{ ip: string; access: string[]; error: string[]; auth: string[] }>(`/guardian/security/evidence/${encodeURIComponent(ip)}`),
  guardianQuarantineFile: (path: string) =>
    request("/guardian/file-watch/quarantine", { method: "POST", body: JSON.stringify({ path }) }),
  services: () => request<{ items: Array<{ key: string; name: string; port: number; status: "healthy" | "down"; detail: string; installed: boolean; manageable: boolean; availableActions: string[] }> }>("/system/services"),
  serviceAction: (serviceKey: string, action: string) =>
    request(`/system/services/${encodeURIComponent(serviceKey)}/action`, { method: "POST", body: JSON.stringify({ action }) }),
  firewallRules: () => request("/firewall/rules"),
  firewallStatus: () => request("/firewall/status"),
  applyFirewallRule: (body: unknown) =>
    request("/firewall/rules", { method: "POST", body: JSON.stringify(body) }),
  deleteFirewallRule: (ruleNumber: number) =>
    request(`/firewall/rules/${ruleNumber}`, { method: "DELETE" }),
  enableFirewall: () =>
    request("/firewall/enable", { method: "POST" }),
  disableFirewall: () =>
    request("/firewall/disable", { method: "POST" }),
  firewallSecurity: () => request("/firewall/security"),
  applySshHardening: (body: unknown) =>
    request("/firewall/ssh-hardening", { method: "POST", body: JSON.stringify(body) }),
  processes: () => request("/processes"),
  repairBind: () =>
    request("/dns/bind/repair", { method: "POST" }),
  deploymentGitSync: (body: unknown) =>
    request("/deployments/git-sync", { method: "POST", body: JSON.stringify(body) }),
  deploymentResourceSnapshot: (body: unknown) =>
    request("/deployments/resource-snapshot", { method: "POST", body: JSON.stringify(body) }),
  deploymentInstall: (body: unknown) =>
    request("/deployments/install", { method: "POST", body: JSON.stringify(body) }),
  deploymentBuild: (body: unknown) =>
    request("/deployments/build", { method: "POST", body: JSON.stringify(body) }),
  deploymentMigrate: (body: unknown) =>
    request("/deployments/migrate", { method: "POST", body: JSON.stringify(body) }),
  deploymentProcess: (body: unknown) =>
    request("/deployments/process", { method: "POST", body: JSON.stringify(body) }),
  deploymentLaravelWorkers: (body: unknown) =>
    request<SysagentCommandResult & { desiredWorkers?: number; runningWorkers?: number; status?: { running?: number; configured?: number; processes?: unknown[] } }>("/deployments/laravel-workers", { method: "POST", body: JSON.stringify(body) }),
  deploymentCron: (body: unknown) =>
    request<SysagentCommandResult & { cronPath?: string; enabledJobs?: number; removed?: boolean }>("/deployments/cron", { method: "POST", body: JSON.stringify(body) }),
  deploymentNginx: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; enabledPath?: string; serverName?: string }>("/deployments/nginx", { method: "POST", body: JSON.stringify(body) }),
  deploymentRetireNginxRoute: (body: unknown) =>
    request<{ dryRun?: boolean; serverName?: string | null; configName?: string; removedManaged?: string[]; scrubbed?: unknown; test?: SysagentCommandResult; reload?: SysagentCommandResult }>("/deployments/nginx-retire", { method: "POST", body: JSON.stringify(body) }),
  deploymentHealth: (body: unknown) =>
    request("/deployments/health", { method: "POST", body: JSON.stringify(body) }),
  deploymentGuardianRepair: (body: { rootPath: string; framework?: string; env?: Record<string, string> }) =>
    request<{ returncode: number; steps: Record<string, unknown>; failed?: string[]; appKey?: string }>("/deployments/guardian-repair", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  deploymentPortStatus: (body: unknown) =>
    request<SysagentCommandResult & { occupied?: boolean; reusable?: boolean; owner?: unknown }>("/deployments/port-status", { method: "POST", body: JSON.stringify(body) }),
  deploymentRuntimeLogs: (body: unknown) =>
    request<{ ok: boolean; logDir?: string; stdout: string; stderr: string; laravel?: string; text: string; error?: string }>("/deployments/runtime-logs", { method: "POST", body: JSON.stringify(body) }),
  deploymentMetrics: (body: unknown) =>
    request("/deployments/metrics", { method: "POST", body: JSON.stringify(body) }),
  deploymentRuntimeTools: (body: unknown) =>
    request<{ items: Array<{ name: string; installed: boolean; path?: string | null; version?: string | null }> }>("/deployments/runtime-tools", { method: "POST", body: JSON.stringify(body) }),
  deploymentInstallRuntimeTool: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/runtime-tools/install", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairPermissions: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/repair-permissions", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairLaravelWritablePaths: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/laravel/repair-writable-paths", { method: "POST", body: JSON.stringify(body) }),
  deploymentEnsureLaravelPublicIndex: (body: unknown) =>
    request<SysagentCommandResult & { created?: boolean; indexPath?: string }>("/deployments/laravel/ensure-public-index", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairPythonRuntime: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/python/repair-runtime", { method: "POST", body: JSON.stringify(body) }),
  deploymentSyncLaravelEnv: (body: { rootPath: string; port?: number; env?: Record<string, string> }) =>
    request<SysagentCommandResult & { envPath?: string; appKey?: string; keyGenerated?: boolean }>("/deployments/laravel/sync-env-file", { method: "POST", body: JSON.stringify(body) }),
  deploymentPatchLaravelProductionEnv: (body: { rootPath: string; values: Record<string, string> }) =>
    request<SysagentCommandResult & { envPath?: string; changedKeys?: string[] }>("/deployments/laravel/production-env", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairSupervisor: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/supervisor/repair", { method: "POST", body: JSON.stringify(body) }),
  deploymentNginxInspect: (body: unknown) =>
    request<SysagentCommandResult & { exists: boolean; enabled: boolean; expectedUpstream: string; containsExpectedUpstream: boolean; availablePath: string; enabledPath: string }>("/deployments/nginx-inspect", { method: "POST", body: JSON.stringify(body) }),
  deploymentLaravelRuntimeStatus: (body: unknown) =>
    request("/deployments/laravel/runtime-status", { method: "POST", body: JSON.stringify(body) }),
  deploymentLaravelRuntimeRepair: (body: unknown) =>
    request("/deployments/laravel/runtime-repair", { method: "POST", body: JSON.stringify(body) }),
  deploymentLaravelTiming: (body: unknown) =>
    request("/deployments/laravel/timing", { method: "POST", body: JSON.stringify(body) }),
  deploymentPublicRoute: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/public-route", { method: "POST", body: JSON.stringify(body) }),
  deploymentPublicAccessDiagnose: (body: unknown) =>
    request("/deployments/public-access-diagnose", { method: "POST", body: JSON.stringify(body) }),
  deploymentPublicAccessRepair: (body: unknown) =>
    request("/deployments/public-access-repair", { method: "POST", body: JSON.stringify(body) }),
  certificateExists: (domain: string) =>
    request<{ domain: string; exists: boolean; certificate: string; privateKey: string }>(`/ssl/certificate-exists/${encodeURIComponent(domain.split(" ")[0] ?? domain)}`),
  certificateStatus: (domain: string) =>
    request<{ domain: string; exists: boolean; expiry: string | null; names: string[]; certificate: string; privateKey: string }>(`/ssl/certificate-status/${encodeURIComponent(domain.split(" ")[0] ?? domain)}`),
  certificateFindReusable: (domain: string) =>
    request<{ requested: string; domain: string; exists: boolean; expiry: string | null; names: string[]; certificate: string; privateKey: string; candidates?: unknown[] }>(`/ssl/certificate-reusable/${encodeURIComponent(domain.split(" ")[0] ?? domain)}`),
  servedCertificate: (body: { domain: string; connectHost?: string | null; port?: number }) =>
    request<{ domain: string; connectHost?: string; connectedIp?: string | null; port: number; exists: boolean; matches: boolean; names: string[]; subject?: string | null; issuer?: string | null; notAfter?: string | null; error?: string | null }>("/ssl/served-certificate", { method: "POST", body: JSON.stringify(body) }),
  ensureAcmeWebroot: (body: { domain: string; webRoot?: string | null }) =>
    request<SysagentCommandResult & { webRoot?: string; challengeDir?: string }>("/ssl/ensure-acme-webroot", { method: "POST", body: JSON.stringify(body) }),
  killSslProcess: (body: { domain: string; certName?: string | null }) =>
    request<SysagentCommandResult & { domain?: string; certName?: string | null; pattern?: string }>("/ssl/kill", { method: "POST", body: JSON.stringify(body) }),
  applyDnsZone: async (body: { domain: string; zone: string }) => {
    const result = await request<DnsZoneApplyResult>("/dns/zone/apply", { method: "POST", body: JSON.stringify(body) });
    return assertDnsZoneApplySucceeded(body.domain, result);
  },
  dnsZoneStatus: (domain: string) =>
    request<DnsZoneStatusResult>(`/dns/zone/status/${encodeURIComponent(domain)}`),
  provisionDatabase: (body: unknown) =>
    request("/database/provision", { method: "POST", body: JSON.stringify(body) }),
  databaseOverview: () =>
    request("/database/overview"),
  databaseProtection: (body: unknown) =>
    request("/database/protection", { method: "POST", body: JSON.stringify(body) }),
  databasePassword: (body: unknown) =>
    request("/database/password", { method: "POST", body: JSON.stringify(body) }),
  databaseGrant: (body: unknown) =>
    request("/database/grant", { method: "POST", body: JSON.stringify(body) }),
  databaseDelete: (body: unknown) =>
    request("/database/database", { method: "DELETE", body: JSON.stringify(body) }),
  databaseExport: (body: unknown) =>
    request<{ engine: string; database: string; dump: string; result: SysagentCommandResult }>("/database/export", { method: "POST", body: JSON.stringify(body) }),
  databaseImport: (body: unknown) =>
    request("/database/import", { method: "POST", body: JSON.stringify(body) }),
  databaseImportFile: (body: unknown) =>
    request("/database/import-file", { method: "POST", body: JSON.stringify(body) }),
  databaseTables: (body: unknown) =>
    request("/database/tables", { method: "POST", body: JSON.stringify(body) }),
  databaseColumns: (body: unknown) =>
    request("/database/columns", { method: "POST", body: JSON.stringify(body) }),
  databaseRows: (body: unknown) =>
    request("/database/rows", { method: "POST", body: JSON.stringify(body) }),
  databaseTableExport: (body: unknown) =>
    request<{ engine: string; database: string; table: string; dump: string; result: SysagentCommandResult }>("/database/table/export", { method: "POST", body: JSON.stringify(body) }),
  databaseTableExportCsv: (body: unknown) =>
    request<{ engine: string; database: string; table: string; format: string; content: string; result: SysagentCommandResult }>("/database/table/export-csv", { method: "POST", body: JSON.stringify(body) }),
  databaseTableImport: (body: unknown) =>
    request("/database/table/import", { method: "POST", body: JSON.stringify(body) }),
  databaseRowCreate: (body: unknown) =>
    request("/database/row", { method: "POST", body: JSON.stringify(body) }),
  databaseRowUpdate: (body: unknown) =>
    request("/database/row", { method: "PATCH", body: JSON.stringify(body) }),
  databaseRowDelete: (body: unknown) =>
    request("/database/row", { method: "DELETE", body: JSON.stringify(body) }),
  deleteFiles: (body: unknown) =>
    request<{ ok: true; removed: string[]; dryRun?: boolean }>("/files/delete", { method: "DELETE", body: JSON.stringify(body) }),
  largestFiles: (body: unknown) =>
    request<{ items: SysagentLargestFile[]; scannedRoots: string[]; generatedAt: string }>("/files/largest", { method: "POST", body: JSON.stringify(body) }),
  deleteLargeFile: (body: unknown) =>
    request<{ ok: true; path: string; removedBytes: number | string; dryRun?: boolean }>("/files/largest", { method: "DELETE", body: JSON.stringify(body) }),
  trashFiles: (body: unknown) =>
    request<{ ok: true; movedToTrash: string[]; permanentlyRemoved: string[]; dryRun?: boolean }>("/files/trash", { method: "POST", body: JSON.stringify(body) }),
  gitStatus: (body: unknown) =>
    request<{ ok: true; path: string; isRepo: boolean; dryRun?: boolean }>("/files/git/status", { method: "POST", body: JSON.stringify(body) }),
  gitPull: (body: unknown) =>
    request<{ ok: true; path: string; stdout: string; stderr: string; returncode: number; dryRun?: boolean }>("/files/git/pull", { method: "POST", body: JSON.stringify(body) }),
  createFile: (body: unknown) =>
    request<{ ok: true; path: string; dryRun?: boolean }>("/files/files", { method: "POST", body: JSON.stringify(body) }),
  createFolder: (body: unknown) =>
    request<{ ok: true; path: string; dryRun?: boolean }>("/files/folders", { method: "POST", body: JSON.stringify(body) }),
  createDomainScaffold: (body: unknown) =>
    request<{ ok: true; domain: string; root: string; relativeRoot: string; folders: string[]; dryRun?: boolean }>("/files/domain-scaffold", { method: "POST", body: JSON.stringify(body) }),
  createSubdomainScaffold: (body: unknown) =>
    request<{ ok: true; domain: string; subdomain: string; fqdn: string; root: string; relativeRoot: string; folders: string[]; dryRun?: boolean }>("/files/subdomain-scaffold", { method: "POST", body: JSON.stringify(body) }),
  createAccountScaffold: (body: unknown) =>
    request<{ ok: true; username: string; root: string; relativeRoot: string; folders: string[]; dryRun?: boolean }>("/files/account-scaffold", { method: "POST", body: JSON.stringify(body) }),
  chmodFile: (body: unknown) =>
    request<{ ok: true; path: string; mode: string; dryRun?: boolean }>("/files/chmod", { method: "POST", body: JSON.stringify(body) }),
  writeFile: (body: unknown) =>
    request<{ ok: true; path: string; dryRun?: boolean }>("/files/write", { method: "PUT", body: JSON.stringify(body) }),
  writeNginxVhost: (body: unknown) =>
    request("/nginx/vhost", { method: "POST", body: JSON.stringify(body) }),
  ensurePanelUploadLimits: () =>
    request<{ ok: boolean; results: Array<Record<string, unknown>> }>("/nginx/panel-upload-limits", { method: "POST", body: "{}" }),
  ensureWebRuntimeOptimizations: () =>
    request<{ ok: boolean; results: Record<string, unknown> }>("/nginx/web-runtime-optimizations", { method: "POST", body: "{}" }),
  writeStaticNginxVhost: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; postReloadCheck?: SysagentCommandResult; configPath: string; rootPath: string; sslEnabled?: boolean; forceHttps?: boolean }>("/nginx/static-vhost", { method: "POST", body: JSON.stringify(body) }),
  nginxRouteDiagnose: (body: unknown) =>
    request<{ serverName: string; expectedRoute?: string | null; matchingServerNameBlocks?: unknown[]; expectedRouteBlocks?: unknown[]; defaultSslBlocks?: unknown[]; dump?: unknown }>("/nginx/route-diagnose", { method: "POST", body: JSON.stringify(body) }),
  writeRedirectNginxVhost: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; redirectUrl: string; sslEnabled?: boolean }>("/nginx/redirect-vhost", { method: "POST", body: JSON.stringify(body) }),
  certbotStatus: () =>
    request<SysagentCommandResult>("/ssl/certbot"),
  sslPreflight: (body: unknown) =>
    request<{
      certbot: SysagentCommandResult;
      write: SysagentCommandResult;
      checks: SysagentCommandResult[];
      localChecks?: SysagentCommandResult[];
      publicChecks?: SysagentCommandResult[];
      webRoot: string;
    }>("/ssl/preflight", { method: "POST", body: JSON.stringify(body) }),
  issueCertificate: (body: unknown) =>
    request<SysagentCommandResult>("/ssl/issue", { method: "POST", body: JSON.stringify(body) }),
  issueDnsCertificate: (body: unknown) =>
    request<SysagentCommandResult>("/ssl/issue-dns", { method: "POST", body: JSON.stringify(body) }),
  renewCertificate: (domain: string) =>
    request<SysagentCommandResult>(`/ssl/renew/${encodeURIComponent(domain)}`, { method: "POST" }),
  renewAllCertificates: () =>
    request<SysagentCommandResult>("/ssl/renew-all", { method: "POST" }),
  setupDkim: (body: unknown) =>
    request("/mail-config/dkim", { method: "POST", body: JSON.stringify(body) }),
  createMailbox: (body: unknown) =>
    request("/mail-config/mailbox", { method: "POST", body: JSON.stringify(body) }),
  deleteMailbox: (body: { email: string }) =>
    request<{ ok: boolean; email: string; maildirRetained: boolean }>("/mail-config/mailbox", { method: "DELETE", body: JSON.stringify(body) }),
  mailboxMessages: (body: { email: string; maxMessages?: number }) =>
    request<{ email: string; messages: Array<{ messageId: string; fromAddress: string; toAddress: string; subject: string; bodyText?: string | null; bodyHtml?: string | null; receivedAt: string }> }>("/mail-config/mailbox/messages", { method: "POST", body: JSON.stringify(body) }),
  syncMailboxes: (body: unknown) =>
    request("/mail-config/mailboxes/sync", { method: "POST", body: JSON.stringify(body) }),
  updateMailAlias: (body: unknown) =>
    request("/mail-config/alias", { method: "POST", body: JSON.stringify(body) }),
  deleteMailAlias: (body: { source: string }) =>
    request("/mail-config/alias", { method: "DELETE", body: JSON.stringify(body) }),
  configureSmtp: (body: unknown) =>
    request("/mail-config/smtp/configure", { method: "POST", body: JSON.stringify(body) }),
  testSmtpHealth: (body: unknown) =>
    request("/mail-config/health/smtp", { method: "POST", body: JSON.stringify(body) }),
  testIncomingMail: (body: unknown) =>
    request("/mail-config/health/incoming", { method: "POST", body: JSON.stringify(body) }),
  mailSecurityStatus: () =>
    request("/mail-config/security/status"),
  configureMailSecurity: (body: unknown) =>
    request("/mail-config/security/configure", { method: "POST", body: JSON.stringify(body) }),
  mailStackStatus: () =>
    request("/mail-config/stack/status"),
  mailBackups: () =>
    request("/mail-config/backup"),
  createMailBackup: () =>
    request("/mail-config/backup", { method: "POST" }),
  restoreMailBackup: (body: unknown) =>
    request("/mail-config/restore", { method: "POST", body: JSON.stringify(body) }),
  mailReputation: (body: unknown) =>
    request("/mail-config/reputation", { method: "POST", body: JSON.stringify(body) }),
  installMailStack: (body: { enableRspamd?: boolean } = {}) =>
    request("/mail-config/stack/install", { method: "POST", body: JSON.stringify(body) }),
  mailFirewallStatus: () =>
    request("/mail-config/firewall/status"),
  applyMailFirewall: () =>
    request("/mail-config/firewall/apply", { method: "POST" }),
  reloadMailServices: () =>
    request("/mail-config/reload", { method: "POST" }),
  mailDiagnostics: (body: unknown) =>
    request("/mail-config/diagnostics", { method: "POST", body: JSON.stringify(body) }),
  mailQueue: () => request("/mail-config/queue"),
  mailQueueAction: (body: unknown) =>
    request("/mail-config/queue/action", { method: "POST", body: JSON.stringify(body) })
};
