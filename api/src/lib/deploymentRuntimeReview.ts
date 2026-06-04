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
  const installable = runtimeInstallTargetsForMissingExecutables(missing);
  return {
    required,
    installed: inspection.items.filter((item) => item.installed).map((item) => item.name),
    missing,
    installable,
    blocked: missing.filter((tool) => !installable.some((target) => target.executables.includes(tool))),
    needsApproval: installable.length > 0
  };
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
