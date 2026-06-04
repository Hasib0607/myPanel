import type { DeploymentFramework, DeploymentPackageManager, DeploymentProcessManager, DeploymentRuntime } from "@prisma/client";
import { envDrivenRuntimeExecutables, requiredRuntimeExecutables, runtimeInstallTargetsForMissingExecutables, runtimeInstallTargetsForTools } from "./deploymentRuntimeTools.js";
import { getSecret } from "./secrets.js";
import { sysagent, type SysagentCommandResult } from "./sysagent.js";

type DeploymentRuntimeInput = {
  id: string;
  framework: DeploymentFramework;
  packageManager: DeploymentPackageManager | null;
  runtime: DeploymentRuntime | null;
  processManager: DeploymentProcessManager | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  env?: Array<{ key: string; value: string | null; secretRef: string | null }>;
};

export function runtimeInstallTargetsForReview(
  missing: string[],
  inspection: Array<{ name: string; installed: boolean; version?: string | null }>
) {
  const installable = runtimeInstallTargetsForMissingExecutables(missing);
  const phpVersion = inspection.find((item) => item.name === "php")?.version ?? null;
  const [phpMajor = 0, phpMinor = 0] = (phpVersion ?? "0.0").split(".").map(Number);
  if (missing.includes("php-ext-swoole") && (phpMajor < 8 || (phpMajor === 8 && phpMinor < 2))) {
    const php82 = runtimeInstallTargetsForTools(["php82"])[0];
    if (php82 && !installable.some((item) => item.tool === php82.tool)) installable.unshift(php82);
  }
  return { installable, phpVersion };
}

export async function resolveDeploymentEnvVars(env: Array<{ key: string; value: string | null; secretRef: string | null }> = []) {
  const resolved: Record<string, string> = {};
  await Promise.all(env.map(async (item) => {
    if (item.value !== null && item.value !== undefined) {
      resolved[item.key] = item.value;
      return;
    }
    if (item.secretRef) {
      const secret = await getSecret(item.secretRef);
      if (secret !== null) resolved[item.key] = secret;
    }
  }));
  return resolved;
}

export async function deploymentRuntimeReview(deployment: DeploymentRuntimeInput) {
  const envVars = await resolveDeploymentEnvVars(deployment.env);
  const requiredTools = new Set(requiredRuntimeExecutables(deployment));
  if (deployment.framework === "LARAVEL") {
    for (const tool of envDrivenRuntimeExecutables(envVars)) requiredTools.add(tool);
  }
  const required = [...requiredTools];
  const inspection = required.length ? await sysagent.deploymentRuntimeTools({ tools: required }) : { items: [] };
  const missing = inspection.items.filter((item) => !item.installed).map((item) => item.name);
  const { installable, phpVersion } = runtimeInstallTargetsForReview(missing, inspection.items);
  return {
    required,
    installed: inspection.items.filter((item) => item.installed).map((item) => item.name),
    missing,
    installable,
    blocked: missing.filter((tool) => !installable.some((target) => target.executables.includes(tool))),
    needsApproval: installable.length > 0,
    phpVersion
  };
}

export async function prepareDeploymentRuntimeTools(deployment: DeploymentRuntimeInput, approvedTools: string[] = []) {
  const before = await deploymentRuntimeReview(deployment);
  if (!before.missing.length) return { ready: true, review: before, install: null };
  if (!approvedTools.length) return { ready: false, review: before, install: null };
  const install = await installDeploymentRuntimeTools(approvedTools);
  const after = await deploymentRuntimeReview(deployment);
  return { ready: install.failed.length === 0 && after.missing.length === 0, review: after, before, install };
}

export async function installDeploymentRuntimeTools(tools: string[] = []) {
  const targets = runtimeInstallTargetsForTools([...new Set(tools)]);
  const results: Array<{ tool: string; actionKey: string; ok: boolean; result?: SysagentCommandResult; error?: string }> = [];
  for (const target of targets) {
    try {
      const result = await sysagent.deploymentInstallRuntimeTool({ tool: target.tool });
      const ok = result.returncode === 0 && !result.dryRun;
      results.push({ tool: target.tool, actionKey: target.actionKey, ok, result });
    } catch (error) {
      results.push({ tool: target.tool, actionKey: target.actionKey, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { targets, results, failed: results.filter((result) => !result.ok) };
}
