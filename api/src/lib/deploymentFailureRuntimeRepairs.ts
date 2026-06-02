import { runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables, type RuntimeInstallTarget } from "./deploymentRuntimeTools.js";

function uniqueRuntimeTargets(targets: RuntimeInstallTarget[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.actionKey)) return false;
    seen.add(target.actionKey);
    return true;
  });
}

export function pythonRuntimeRepairNeeded(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("unsupported operand type") && lower.includes("for |") && lower.includes("nonetype") && lower.includes("python3.9");
}

export function supervisorRepairNeeded(text: string) {
  const lower = text.toLowerCase();
  return (lower.includes("supervisor") || lower.includes("supervisorctl"))
    && (lower.includes("spawn error") || lower.includes("can't spawn") || lower.includes("cannot spawn") || lower.includes("backoff") || lower.includes("exited too quickly"));
}

export function permissionRepairNeeded(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("permission denied")
    || lower.includes("eacces")
    || lower.includes("failed to open log")
    || ((lower.includes("log") || lower.includes("supervisor")) && lower.includes("no such file or directory"));
}

export function runtimeTargetsForFailedDeploymentLog(text: string) {
  const lower = text.toLowerCase();
  const missingTools = new Set<string>();
  const targets: RuntimeInstallTarget[] = [];

  targets.push(...runtimeInstallTargetsForComposerPlatformIssue(text));

  if (pythonRuntimeRepairNeeded(text)) {
    missingTools.add("python3.10+");
  }

  const missingExecutable = lower.includes("command not found")
    || lower.includes("no such file or directory")
    || lower.includes("unsupported deployment executable")
    || lower.includes("spawn error")
    || lower.includes("can't spawn")
    || lower.includes("cannot spawn");

  if (missingExecutable) {
    if (/\bcomposer\b/.test(lower)) missingTools.add("composer");
    if (/\bphp(?:-fpm)?\b/.test(lower)) missingTools.add("php");
    if (/\bnode\b|\bnpm\b|\bnpx\b|\bnext\b|\bvite\b/.test(lower)) {
      missingTools.add("node");
      missingTools.add("npm");
    }
    if (/\bpm2\b/.test(lower)) missingTools.add("pm2");
    if (/\bpnpm\b/.test(lower)) missingTools.add("pnpm");
    if (/\byarn\b/.test(lower)) missingTools.add("yarn");
    if (/\bpython3?\b|\bpip3?\b|\buvicorn\b|\bgunicorn\b|\bflask\b/.test(lower)) {
      missingTools.add("python3");
      missingTools.add("pip3");
    }
    if (/\bgo\b|\bgolang\b/.test(lower)) missingTools.add("go");
    if (/\bsupervisorctl\b|\bsupervisord\b|\bsupervisor\b/.test(lower)) missingTools.add("supervisorctl");
  }

  return uniqueRuntimeTargets([...targets, ...runtimeInstallTargetsForMissingExecutables([...missingTools])]);
}
