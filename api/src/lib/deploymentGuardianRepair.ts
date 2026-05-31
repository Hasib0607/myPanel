import { DeploymentFramework, DeploymentProcessManager } from "@prisma/client";
import { sysagent } from "./sysagent.js";

const recoveryAttempts = Number(process.env.DEPLOY_GUARDIAN_RECOVERY_ATTEMPTS ?? 3);

export function isRecoverableHealthFailure(result: unknown) {
  const value = result as { degraded?: boolean; returncode?: number; stderr?: string; stdout?: string };
  if (value?.degraded) return true;
  if (value?.returncode === 23 || value?.returncode === 22) return true;
  const detail = `${value?.stderr ?? ""} ${value?.stdout ?? ""}`.toLowerCase();
  return detail.includes("http 5") || detail.includes("app_key") || detail.includes("curl:");
}

export function deploymentRecoveryAttempts() {
  return recoveryAttempts;
}

export async function runGuardianDeploymentRepair(input: {
  rootPath: string;
  framework: DeploymentFramework;
  envVars: Record<string, string>;
}) {
  return sysagent.deploymentGuardianRepair({
    rootPath: input.rootPath,
    framework: input.framework,
    env: input.envVars
  });
}

export async function restartDeploymentProcess(input: {
  deploymentId: string;
  slug: string;
  appPath: string;
  port: number;
  processManager: DeploymentProcessManager;
  startCommand: string | null;
  envVars: Record<string, string>;
  logDir: string;
}) {
  return sysagent.deploymentProcess({
    deploymentId: input.deploymentId,
    name: input.slug,
    rootPath: input.appPath,
    action: "start",
    processManager: input.processManager,
    startCommand: input.startCommand,
    port: input.port,
    env: input.envVars,
    logDir: input.logDir
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
