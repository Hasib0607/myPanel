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
    request("/deployments/nginx", { method: "POST", body: JSON.stringify(body) }),
  deploymentHealth: (body: unknown) =>
    request("/deployments/health", { method: "POST", body: JSON.stringify(body) }),
  applyDnsZone: (body: unknown) =>
    request("/dns/zone/apply", { method: "POST", body: JSON.stringify(body) }),
  provisionDatabase: (body: unknown) =>
    request("/database/provision", { method: "POST", body: JSON.stringify(body) }),
  deleteFiles: (body: unknown) =>
    request<{ ok: true; removed: string[]; dryRun?: boolean }>("/files/delete", { method: "DELETE", body: JSON.stringify(body) }),
  createFile: (body: unknown) =>
    request<{ ok: true; path: string; dryRun?: boolean }>("/files/files", { method: "POST", body: JSON.stringify(body) }),
  createFolder: (body: unknown) =>
    request<{ ok: true; path: string; dryRun?: boolean }>("/files/folders", { method: "POST", body: JSON.stringify(body) }),
  createDomainScaffold: (body: unknown) =>
    request<{ ok: true; domain: string; root: string; relativeRoot: string; folders: string[]; dryRun?: boolean }>("/files/domain-scaffold", { method: "POST", body: JSON.stringify(body) }),
  chmodFile: (body: unknown) =>
    request<{ ok: true; path: string; mode: string; dryRun?: boolean }>("/files/chmod", { method: "POST", body: JSON.stringify(body) }),
  writeFile: (body: unknown) =>
    request<{ ok: true; path: string; dryRun?: boolean }>("/files/write", { method: "PUT", body: JSON.stringify(body) }),
  writeNginxVhost: (body: unknown) =>
    request("/nginx/vhost", { method: "POST", body: JSON.stringify(body) }),
  writeStaticNginxVhost: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; rootPath: string; sslEnabled?: boolean; forceHttps?: boolean }>("/nginx/static-vhost", { method: "POST", body: JSON.stringify(body) }),
  writeRedirectNginxVhost: (body: unknown) =>
    request<{ write: SysagentCommandResult; enable: SysagentCommandResult; test: SysagentCommandResult; reload: SysagentCommandResult; configPath: string; redirectUrl: string }>("/nginx/redirect-vhost", { method: "POST", body: JSON.stringify(body) }),
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
