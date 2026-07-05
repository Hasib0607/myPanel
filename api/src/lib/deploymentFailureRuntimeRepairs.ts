import { detectFrontendModuleNotFound, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables, runtimeInstallTargetsForTools, type RuntimeInstallTarget } from "./deploymentRuntimeTools.js";

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

export function supervisorStartStillStarting(text: string) {
  const lower = text.toLowerCase();
  return (lower.includes("supervisor") || lower.includes("supervisorctl"))
    && lower.includes("abnormal termination")
    && lower.includes("starting");
}

export function laravelPublicCwdMissing(text: string) {
  return /provided cwd\s+["'][^"']+\/public["']\s+does not exist/i.test(text);
}

export function nodePackageBinaryMissing(text: string) {
  return /\b(cross-env|cross-env-shell|vite|next|react-scripts|mix|webpack)\b(?:[^;\n\r]*:)?\s+command not found/i.test(text)
    || /sh:\s+\d+:\s+(cross-env|cross-env-shell|vite|next|react-scripts|mix|webpack):\s+not found/i.test(text)
    || /sh:\s+line\s+\d+:\s+(cross-env|cross-env-shell|vite|next|react-scripts|mix|webpack):\s+command not found/i.test(text);
}

export function frontendModuleNotFound(text: string) {
  return detectFrontendModuleNotFound(text) !== null;
}

export function permissionRepairNeeded(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("permission denied")
    || lower.includes("eacces")
    || lower.includes("failed to open log")
    || ((lower.includes("log") || lower.includes("supervisor")) && lower.includes("no such file or directory"));
}

export function nginxProxyMissingDomainFailure(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("configuring_proxy")
    && lower.includes("cannot read properties of null")
    && lower.includes("reading 'name'");
}

export function nginxUpstreamFailure(result: unknown, text = "") {
  const value = result as { httpCode?: number; stderr?: string; stdout?: string };
  const detail = `${text} ${value?.stderr ?? ""} ${value?.stdout ?? ""}`.toLowerCase();
  return [502, 503, 504].includes(value?.httpCode ?? 0)
    || detail.includes("http 502")
    || detail.includes("http 503")
    || detail.includes("http 504")
    || detail.includes("bad gateway")
    || detail.includes("connect() failed")
    || detail.includes("upstream");
}

export function prismaDatabaseAuthFailure(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("p1000")
    && lower.includes("authentication failed")
    && lower.includes("database")
    && lower.includes("credentials");
}

export function runtimeTargetsForFailedDeploymentLog(text: string) {
  const lower = text.toLowerCase();
  const missingTools = new Set<string>();
  const targets: RuntimeInstallTarget[] = [];
  for (const match of text.matchAll(/Missing runtime tools(?:\s+on\s+the\s+server)?:\s*([^\n.]+)/ig)) {
    for (const item of match[1].split(",")) {
      const tool = item.trim().replace(/[`'"]/g, "");
      if (tool) missingTools.add(tool);
    }
  }

  if ((lower.includes("swoole") || lower.includes("openswoole")) && (lower.includes("requires php") || lower.includes("require php version 8.2 or later"))) {
    targets.push(...runtimeInstallTargetsForTools(["php82", "php-swoole"]));
  }

  targets.push(...runtimeInstallTargetsForComposerPlatformIssue(text));

  if (pythonRuntimeRepairNeeded(text)) {
    missingTools.add("python3.10+");
  }

  if (nodePackageBinaryMissing(text) || frontendModuleNotFound(text)) {
    return uniqueRuntimeTargets(targets);
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
