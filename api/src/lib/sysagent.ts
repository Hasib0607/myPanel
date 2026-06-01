import { env } from "../config/env.js";

export type SysagentCommandResult = {
  dryRun?: boolean;
  command?: string[];
  cwd?: string | null;
  stdout?: string;
  stderr?: string;
  returncode?: number;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${env.SYSAGENT_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`sysagent ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return response.json() as Promise<T>;
}

export const sysagent = {
  stats: () => request("/system/stats"),
  backupPlan: () => request<{ backupRoot: string; liveEnabled: boolean; freeBytes: number; includes: string[] }>("/backup/plan"),
  backupArchives: () => request<{ items: Array<{ path: string; name: string; sizeBytes: number; modifiedAt: string; checksumPath: string }> }>("/backup/archives"),
  createBackup: (body: unknown) =>
    request<{ archivePath: string; stagingDir: string; includes: string[]; sizeBytes?: number | null; result: SysagentCommandResult }>("/backup/create", { method: "POST", body: JSON.stringify(body) }),
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
  deploymentGitSync: (body: unknown) =>
    request("/deployments/git-sync", { method: "POST", body: JSON.stringify(body) }),
  deploymentInstall: (body: unknown) =>
    request("/deployments/install", { method: "POST", body: JSON.stringify(body) }),
  deploymentBuild: (body: unknown) =>
    request("/deployments/build", { method: "POST", body: JSON.stringify(body) }),
  deploymentMigrate: (body: unknown) =>
    request("/deployments/migrate", { method: "POST", body: JSON.stringify(body) }),
  deploymentProcess: (body: unknown) =>
    request("/deployments/process", { method: "POST", body: JSON.stringify(body) }),
  deploymentNginx: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; enabledPath?: string; serverName?: string }>("/deployments/nginx", { method: "POST", body: JSON.stringify(body) }),
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
  deploymentRuntimeTools: (body: unknown) =>
    request<{ items: Array<{ name: string; installed: boolean; path?: string | null }> }>("/deployments/runtime-tools", { method: "POST", body: JSON.stringify(body) }),
  deploymentInstallRuntimeTool: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/runtime-tools/install", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairPermissions: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/repair-permissions", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairLaravelWritablePaths: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/laravel/repair-writable-paths", { method: "POST", body: JSON.stringify(body) }),
  deploymentSyncLaravelEnv: (body: { rootPath: string; port?: number; env?: Record<string, string> }) =>
    request<SysagentCommandResult & { envPath?: string; appKey?: string; keyGenerated?: boolean }>("/deployments/laravel/sync-env-file", { method: "POST", body: JSON.stringify(body) }),
  deploymentRepairSupervisor: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/supervisor/repair", { method: "POST", body: JSON.stringify(body) }),
  deploymentNginxInspect: (body: unknown) =>
    request<SysagentCommandResult & { exists: boolean; enabled: boolean; expectedUpstream: string; containsExpectedUpstream: boolean; availablePath: string; enabledPath: string }>("/deployments/nginx-inspect", { method: "POST", body: JSON.stringify(body) }),
  deploymentPublicRoute: (body: unknown) =>
    request<SysagentCommandResult>("/deployments/public-route", { method: "POST", body: JSON.stringify(body) }),
  deploymentPublicAccessDiagnose: (body: unknown) =>
    request("/deployments/public-access-diagnose", { method: "POST", body: JSON.stringify(body) }),
  deploymentPublicAccessRepair: (body: unknown) =>
    request("/deployments/public-access-repair", { method: "POST", body: JSON.stringify(body) }),
  certificateExists: (domain: string) =>
    request<{ domain: string; exists: boolean; certificate: string; privateKey: string }>(`/ssl/certificate-exists/${encodeURIComponent(domain.split(" ")[0] ?? domain)}`),
  ensureAcmeWebroot: (body: { domain: string; webRoot?: string | null }) =>
    request<SysagentCommandResult & { webRoot?: string; challengeDir?: string }>("/ssl/ensure-acme-webroot", { method: "POST", body: JSON.stringify(body) }),
  applyDnsZone: (body: unknown) =>
    request("/dns/zone/apply", { method: "POST", body: JSON.stringify(body) }),
  provisionDatabase: (body: unknown) =>
    request("/database/provision", { method: "POST", body: JSON.stringify(body) }),
  databaseOverview: () =>
    request("/database/overview"),
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
  deleteFiles: (body: unknown) =>
    request<{ ok: true; removed: string[]; dryRun?: boolean }>("/files/delete", { method: "DELETE", body: JSON.stringify(body) }),
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
  writeStaticNginxVhost: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; rootPath: string; sslEnabled?: boolean; forceHttps?: boolean }>("/nginx/static-vhost", { method: "POST", body: JSON.stringify(body) }),
  writeRedirectNginxVhost: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; redirectUrl: string; sslEnabled?: boolean }>("/nginx/redirect-vhost", { method: "POST", body: JSON.stringify(body) }),
  certbotStatus: () =>
    request<SysagentCommandResult>("/ssl/certbot"),
  sslPreflight: (body: unknown) =>
    request<{ certbot: SysagentCommandResult; write: SysagentCommandResult; checks: SysagentCommandResult[]; webRoot: string }>("/ssl/preflight", { method: "POST", body: JSON.stringify(body) }),
  issueCertificate: (body: unknown) =>
    request<SysagentCommandResult>("/ssl/issue", { method: "POST", body: JSON.stringify(body) }),
  renewCertificate: (domain: string) =>
    request<SysagentCommandResult>(`/ssl/renew/${encodeURIComponent(domain)}`, { method: "POST" }),
  setupDkim: (body: unknown) =>
    request("/mail-config/dkim", { method: "POST", body: JSON.stringify(body) }),
  createMailbox: (body: unknown) =>
    request("/mail-config/mailbox", { method: "POST", body: JSON.stringify(body) }),
  updateMailAlias: (body: unknown) =>
    request("/mail-config/alias", { method: "POST", body: JSON.stringify(body) }),
  reloadMailServices: () =>
    request("/mail-config/reload", { method: "POST" })
};
