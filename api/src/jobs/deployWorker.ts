import { Worker } from "bullmq";
import { DeploymentFramework, DeploymentPackageManager, DeploymentProcessManager, DeploymentRuntime, Prisma } from "@prisma/client";
import path from "node:path";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { detectDeploymentSource } from "../lib/deploymentDetection.js";
import { requiredRuntimeExecutables, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables } from "../lib/deploymentRuntimeTools.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSecret } from "../lib/secrets.js";
import { sysagent } from "../lib/sysagent.js";
import { sslQueue } from "./queues.js";

type DeployJobData = {
  deploymentId?: string;
  releaseId?: string;
};

type DeployStep = "PREFLIGHT" | "CLONING" | "INSTALLING" | "MIGRATING" | "BUILDING" | "CONFIGURING_PROXY" | "STARTING" | "HEALTH_CHECK" | "SUCCEEDED" | "FAILED" | "ROLLBACK";
const buildLogRetentionMs = 24 * 60 * 60 * 1000;
const deploymentWorkerInclude = Prisma.validator<Prisma.DeploymentInclude>()({
  domain: true,
  domainBindings: { include: { domain: true, subdomain: { include: { domain: true } } }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] },
  env: true
});

type DeploymentWithWorkerRelations = Prisma.DeploymentGetPayload<{ include: typeof deploymentWorkerInclude }>;

const defaultProcessManagerByFramework: Record<DeploymentFramework, DeploymentProcessManager> = {
  LARAVEL: "SUPERVISOR",
  NEXTJS: "PM2",
  NODEJS: "PM2",
  PYTHON: "SUPERVISOR",
  GO: "SUPERVISOR",
  STATIC: "STATIC"
};

async function writeLog(deploymentId: string, releaseId: string | undefined, step: DeployStep, message: string, metadata: Prisma.InputJsonObject = {}, level = "info") {
  await pruneBuildLogs(deploymentId);
  return prisma.deploymentLog.create({
    data: {
      deploymentId,
      releaseId,
      step,
      level,
      message,
      metadata
    }
  });
}

function deploymentLogDir(slug: string) {
  return `${env.DEPLOYMENT_LOG_ROOT.replace(/\/+$/, "")}/${slug}`;
}

function deploymentPortRange() {
  const start = env.DEPLOYMENT_PORT_START;
  const end = env.DEPLOYMENT_PORT_END;
  if (start > end) {
    throw new Error("DEPLOYMENT_PORT_START must be lower than or equal to DEPLOYMENT_PORT_END");
  }
  return { start, end };
}

function reservedDeploymentPorts() {
  const ports = new Set<number>();
  for (const rawPort of env.DEPLOYMENT_RESERVED_PORTS.split(",")) {
    const port = Number(rawPort.trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }

  ports.add(env.PANEL_PORT);
  const loginPort = Number(env.PANEL_LOGIN_PORT ?? 8453);
  if (Number.isInteger(loginPort) && loginPort > 0 && loginPort <= 65535) ports.add(loginPort);
  const accountPort = Number(env.CPANEL_LOGIN_PORT ?? 3138);
  if (Number.isInteger(accountPort) && accountPort > 0 && accountPort <= 65535) ports.add(accountPort);
  return ports;
}

function deploymentPortPolicyError(port: number) {
  const { start, end } = deploymentPortRange();
  if (port < start || port > end) {
    return `Deployment port ${port} is outside the managed project range ${start}-${end}`;
  }
  if (reservedDeploymentPorts().has(port)) {
    return `Deployment port ${port} is reserved for panel or system services`;
  }
  return null;
}

async function nextAvailableDeploymentPort(excludeDeploymentId?: string, blockedPorts = new Set<number>()) {
  const deployments = await prisma.deployment.findMany({
    where: excludeDeploymentId ? { id: { not: excludeDeploymentId } } : undefined,
    select: { port: true },
    orderBy: { port: "asc" }
  });
  const used = new Set(deployments.map((deployment) => deployment.port));
  const reserved = reservedDeploymentPorts();
  const { start, end } = deploymentPortRange();
  for (let port = start; port <= end; port += 1) {
    if (!used.has(port) && !reserved.has(port) && !blockedPorts.has(port)) return port;
  }
  throw new Error(`No available deployment ports in ${start}-${end}`);
}

async function dbPortOwner(port: number, deploymentId: string) {
  return prisma.deployment.findFirst({
    where: {
      port,
      id: { not: deploymentId }
    },
    select: { id: true, name: true, slug: true, port: true }
  });
}

async function livePortConflict(port: number, deployment: DeploymentWithWorkerRelations) {
  const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
  try {
    const status = await sysagent.deploymentPortStatus({
      rootPath: deploymentAppPath(deployment.rootPath, deployment.rootDirectory),
      port,
      processName: deployment.slug,
      processManager
    });
    if (status.dryRun || status.reusable || !status.occupied) return null;
    return status.owner ?? status.stderr ?? `port ${port} is already listening`;
  } catch (error) {
    return null;
  }
}

async function ensureManagedDeploymentPort(deployment: DeploymentWithWorkerRelations, releaseId: string | undefined) {
  let currentPort = deployment.port;
  const blockedPorts = new Set<number>();
  const { start, end } = deploymentPortRange();

  for (let attempt = 0; attempt <= end - start; attempt += 1) {
    const policyError = deploymentPortPolicyError(currentPort);
    const owner = policyError ? null : await dbPortOwner(currentPort, deployment.id);
    const liveOwner = !policyError && !owner ? await livePortConflict(currentPort, deployment) : null;

    if (!policyError && !owner && !liveOwner) {
      if (currentPort === deployment.port) return deployment;
      await writeLog(deployment.id, releaseId, "PREFLIGHT", `Deployment port reassigned to ${currentPort}`, {
        previousPort: deployment.port,
        nextPort: currentPort
      }, "warn");
      return prisma.deployment.update({
        where: { id: deployment.id },
        data: { port: currentPort },
        include: deploymentWorkerInclude
      });
    }

    blockedPorts.add(currentPort);
    const reason = policyError
      ?? (owner ? `already used by ${owner.name || owner.slug}` : `already used by a live process`);
    await writeLog(deployment.id, releaseId, "PREFLIGHT", `Port ${currentPort} is ${reason}; searching for a free port`, {
      port: currentPort,
      owner: owner ?? liveOwner
    }, "warn");
    currentPort = await nextAvailableDeploymentPort(deployment.id, blockedPorts);
  }

  throw new Error(`No available deployment ports in ${start}-${end}`);
}

async function pruneBuildLogs(deploymentId: string) {
  await prisma.deploymentLog.deleteMany({
    where: {
      deploymentId,
      createdAt: { lt: new Date(Date.now() - buildLogRetentionMs) }
    }
  });
}

async function resetBuildLogs(deploymentId: string) {
  await prisma.deploymentLog.deleteMany({ where: { deploymentId } });
}

async function runStep<T>(deploymentId: string, releaseId: string | undefined, step: DeployStep, message: string, fn: () => Promise<T>) {
  await writeLog(deploymentId, releaseId, step, `${message} started`);
  try {
    const result = await fn();
    await writeLog(deploymentId, releaseId, step, `${message} completed`, { result: JSON.parse(JSON.stringify(result ?? null)) });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown deployment step error";
    await writeLog(deploymentId, releaseId, step, `${message} failed`, { error: detail }, "error");
    throw error;
  }
}

function assertLiveResult(result: unknown, label: string) {
  const message = liveResultFailureMessage(result, label);
  if (message) throw new Error(message);
}

function liveResultFailureMessage(result: unknown, label: string) {
  const value = result as { dryRun?: boolean; returncode?: number; stderr?: string; reason?: string };
  if (value?.dryRun) {
    return `${label} did not run live. Set ALLOW_LIVE_SYSTEM_COMMANDS=true on vps-panel-sysagent, restart vps-panel-sysagent and vps-panel-workers, then retry.`;
  }
  if (typeof value?.returncode === "number" && value.returncode !== 0) {
    const signal = "signal" in value && typeof value.signal === "string" ? value.signal : null;
    const stderrText = value.stderr ?? "";
    const oomKilled = value.returncode === -9 || signal === "SIGKILL" || stderrText.includes("SIGKILL");
    const sigtermKilled = !oomKilled && (value.returncode === -15 || signal === "SIGTERM");
    const signalHint = oomKilled
      ? " The process was killed by the OOM killer (SIGKILL) — the server ran out of memory. Add swap space: run `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab` in the panel Terminal, then redeploy."
      : sigtermKilled
        ? " The command was terminated by SIGTERM. This may be caused by the OS killing the process due to low memory — try adding swap or reducing build memory usage (e.g. NODE_OPTIONS=--max-old-space-size=512 in env vars). If it repeats, increase DEPLOYMENT_COMMAND_TIMEOUT_SECONDS."
        : "";
    return `${label} failed with exit code ${value.returncode}${signal ? ` (${signal})` : ""}${stderrText ? `: ${stderrText}` : ""}${signalHint}`;
  }
  return null;
}

async function markRelease(releaseId: string | undefined, status: "RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK", startedAt?: Date) {
  if (!releaseId) return;
  const finished = status === "SUCCEEDED" || status === "FAILED" || status === "ROLLED_BACK" ? new Date() : undefined;
  await prisma.deploymentRelease.update({
    where: { id: releaseId },
    data: {
      status,
      startedAt: startedAt ?? (status === "RUNNING" ? new Date() : undefined),
      finishedAt: finished,
      durationMs: finished && startedAt ? finished.getTime() - startedAt.getTime() : undefined
    }
  });
}

function renderDeploymentCommand(command: string | null | undefined, port: number) {
  return command?.replaceAll("{PORT}", String(port)).replaceAll("$PORT", String(port)) ?? null;
}

function renderStartCommand(deployment: { framework: DeploymentFramework; startCommand: string | null; port: number }) {
  if (deployment.framework === "NEXTJS") {
    return `npx next start -p ${deployment.port} -H 127.0.0.1`;
  }
  return renderDeploymentCommand(deployment.startCommand, deployment.port);
}

function deploymentAppPath(rootPath: string, rootDirectory: string | null | undefined) {
  const cleanRootDirectory = (rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? path.join(rootPath, cleanRootDirectory) : rootPath;
}

type BoundDomain = { id: string; name: string; forceSsl: boolean; documentRoot?: string | null; includeWww?: boolean };

function deploymentServerName(domain: { name: string; includeWww?: boolean } | null | undefined) {
  if (!domain?.name) return null;
  if (domain.includeWww === false) return domain.name;
  return `${domain.name} www.${domain.name}`;
}

function boundDomainFromBinding(binding: { domain?: BoundDomain | null; subdomain?: { id: string; name: string; sslEnabled: boolean; domain: { name: string; documentRoot?: string | null } } | null }) {
  if (binding.subdomain) {
    return {
      id: `subdomain:${binding.subdomain.id}`,
      name: `${binding.subdomain.name}.${binding.subdomain.domain.name}`,
      forceSsl: binding.subdomain.sslEnabled,
      documentRoot: binding.subdomain.domain.documentRoot,
      includeWww: false
    };
  }
  return binding.domain ?? null;
}

function deploymentDomain(deployment: { domain?: BoundDomain | null; domainBindings?: Array<{ role: string; domain?: BoundDomain | null; subdomain?: { id: string; name: string; sslEnabled: boolean; domain: { name: string; documentRoot?: string | null } } | null }> }) {
  const primary = deployment.domainBindings?.find((binding) => binding.role === "primary");
  return (primary ? boundDomainFromBinding(primary) : null)
    ?? (deployment.domainBindings?.[0] ? boundDomainFromBinding(deployment.domainBindings[0]) : null)
    ?? deployment.domain
    ?? null;
}

function deploymentFallbackRootPath(domain: BoundDomain | null) {
  if (!domain?.name) return null;
  const documentRoot = (domain.documentRoot || "public_html").replace(/^\/+|\/+$/g, "") || "public_html";
  return path.join(env.FILE_MANAGER_ROOT, domain.name, documentRoot);
}

function deploymentPublicEnv(domain: BoundDomain | null) {
  if (!domain?.name) return {} as Record<string, string>;
  const url = `https://${domain.name}`;
  return {
    APP_URL: url,
    APP_ORIGIN: url,
    AUTH_URL: url,
    BASE_URL: url,
    HOST: domain.name,
    HOSTNAME: domain.name,
    NEXTAUTH_URL: url,
    NEXT_PUBLIC_APP_URL: url,
    NEXT_PUBLIC_APP_ORIGIN: url,
    NEXT_PUBLIC_BASE_URL: url,
    NEXT_PUBLIC_DOMAIN: domain.name,
    NEXT_PUBLIC_HOST: domain.name,
    NEXT_PUBLIC_HOSTNAME: domain.name,
    NEXT_PUBLIC_ORIGIN: url,
    NEXT_PUBLIC_SITE_URL: url,
    NEXT_PUBLIC_URL: url,
    ORIGIN: url,
    PUBLIC_URL: url,
    SERVER_URL: url,
    SITE_URL: url,
    URL: url,
    VERCEL_URL: domain.name
  };
}

function isLocalhostValue(value: string | null | undefined) {
  return Boolean(value && /(^|\/\/|\.)localhost(?::\d+)?(\/|$)|(^|\/\/)127\.0\.0\.1(?::\d+)?(\/|$)|(^|\/\/)0\.0\.0\.0(?::\d+)?(\/|$)/i.test(value));
}

function deploymentEnvWithPublicUrl(envVars: Record<string, string>, domain: BoundDomain | null) {
  const publicEnv: Record<string, string> = deploymentPublicEnv(domain);
  const merged: Record<string, string> = { ...publicEnv, ...envVars };

  if (!domain?.name) return merged;

  for (const [key, publicValue] of Object.entries(publicEnv)) {
    const currentValue = merged[key];
    if (!currentValue || isLocalhostValue(currentValue)) {
      merged[key] = publicValue;
    }
  }

  return merged;
}

async function ensureDeploymentDomainProxy(deploymentId: string, domain: BoundDomain | null) {
  if (!domain || domain.id.startsWith("subdomain:")) return;
  await prisma.domain.update({
    where: { id: domain.id },
    data: {
      hostingMode: "DEPLOYMENT_PROXY",
      hostingDeploymentId: deploymentId
    }
  });
}

async function assertHealthResult(result: unknown, label: string, deployment: { slug: string }) {
  const message = liveResultFailureMessage(result, label);
  if (!message) return;

  let runtimeText = "";
  try {
    const logs = await sysagent.deploymentRuntimeLogs({
      name: deployment.slug,
      logDir: deploymentLogDir(deployment.slug),
      lines: 120
    });
    runtimeText = logs.text ? `\n\nRunning log tail:\n${logs.text}` : "";
  } catch (error) {
    runtimeText = `\n\nCould not read running log: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  throw new Error(`${message}${runtimeText}`);
}

async function assertPublicRouteResult(result: unknown, label: string, deployment: { slug: string; domain?: { name: string } | null }) {
  const message = liveResultFailureMessage(result, label);
  if (!message) return;

  let runtimeText = "";
  try {
    const logs = await sysagent.deploymentRuntimeLogs({
      name: deployment.slug,
      logDir: deploymentLogDir(deployment.slug),
      lines: 80
    });
    runtimeText = logs.text ? `\n\nRunning log tail:\n${logs.text}` : "";
  } catch {
    runtimeText = "";
  }

  const localhostProxyMatch = runtimeText.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)"]*/i);
  const domainHint = localhostProxyMatch
    ? ` The app is healthy on localhost, but it is generating an internal URL (${localhostProxyMatch[0]}). Fix the deployed app env/source so public URLs use ${deployment.domain?.name ? `https://${deployment.domain.name}` : "the domain"} instead of localhost.`
    : deployment.domain?.name
      ? ` The app is healthy on localhost, but the public domain returned an error. Check the Nginx vhost, SSL redirect, DNS A record, and whether the app is generating localhost URLs.`
      : "";
  throw new Error(`${message}${domainHint}${runtimeText}`);
}

async function optionalPublicRouteWarning(deploymentId: string, releaseId: string | undefined, label: string, deployment: { slug: string; domain?: BoundDomain | null }) {
  const domain = deployment.domain;
  if (!domain) return null;

  const publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", label, () =>
    sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain) })
  );

  try {
    await assertPublicRouteResult(publicRoute, label, deployment);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Public route check failed";
    await writeLog(deploymentId, releaseId, "HEALTH_CHECK", `${label} warning`, { warning: message }, "warn");
    return message;
  }
}

function githubTokenSecretRef() {
  return "github:superadmin:token";
}

async function assertRuntimeToolsInstalled(deploymentId: string, releaseId: string | undefined, deployment: {
  framework: DeploymentFramework;
  packageManager: DeploymentPackageManager | null;
  runtime: DeploymentRuntime | null;
  processManager: DeploymentProcessManager | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
}) {
  const requiredTools = requiredRuntimeExecutables(deployment);
  if (requiredTools.length === 0) return;

  const inspectTools = async () =>
    runStep(deploymentId, releaseId, "PREFLIGHT", "Runtime tools check", () =>
      sysagent.deploymentRuntimeTools({ tools: requiredTools })
    );

  let toolsResult = await inspectTools();
  let missing = toolsResult.items.filter((tool) => !tool.installed).map((tool) => tool.name);
  if (missing.length === 0) return;

  const approvalTargets = runtimeInstallTargetsForMissingExecutables(missing);
  const autoInstalled: string[] = [];

  for (const target of approvalTargets) {
    const installResult = await runStep(deploymentId, releaseId, "PREFLIGHT", `Auto-install ${target.tool}`, () =>
      sysagent.deploymentInstallRuntimeTool({ tool: target.tool })
    );
    assertLiveResult(installResult, `Auto-install ${target.tool}`);
    autoInstalled.push(target.tool);
  }

  if (autoInstalled.length > 0) {
    toolsResult = await inspectTools();
    missing = toolsResult.items.filter((tool) => !tool.installed).map((tool) => tool.name);
    if (missing.length === 0) {
      await writeLog(deploymentId, releaseId, "PREFLIGHT", "Runtime tools auto-installed", { tools: autoInstalled });
      return;
    }
  }

  for (const target of approvalTargets) {
    const existing = await prisma.deploymentDoctorApproval.findFirst({
      where: {
        deploymentId,
        actionKey: target.actionKey,
        status: { in: ["PENDING", "APPROVED"] }
      }
    });
    if (existing) continue;
    await prisma.deploymentDoctorApproval.create({
      data: {
        deploymentId,
        actionKey: target.actionKey,
        label: target.label,
        command: target.command,
        reason: target.reason
      }
    });
  }

  throw new Error(
    `Missing runtime tools on the server: ${missing.join(", ")}. Auto-install could not finish everything. Pending repair approvals were created for installable tools. Open Deployment Doctor, approve the remaining installs, then redeploy.`
  );
}

async function ensureDoctorApprovalExists(deploymentId: string, target: { actionKey: string; label: string; command: string; reason: string }) {
  const existing = await prisma.deploymentDoctorApproval.findFirst({
    where: {
      deploymentId,
      actionKey: target.actionKey,
      status: { in: ["PENDING", "APPROVED"] }
    }
  });
  if (existing) return existing;
  return prisma.deploymentDoctorApproval.create({
    data: {
      deploymentId,
      actionKey: target.actionKey,
      label: target.label,
      command: target.command,
      reason: target.reason
    }
  });
}

async function autoRepairComposerPlatformIssue(deploymentId: string, releaseId: string | undefined, errorText: string) {
  const targets = runtimeInstallTargetsForComposerPlatformIssue(errorText);
  if (targets.length === 0) return false;

  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Composer platform mismatch detected", {
    targets: targets.map((target) => target.actionKey),
    evidence: errorText.slice(0, 4000)
  }, "warn");

  for (const target of targets) {
    await ensureDoctorApprovalExists(deploymentId, target);
  }

  const autoInstalled: string[] = [];
  for (const target of targets) {
    const installResult = await runStep(deploymentId, releaseId, "PREFLIGHT", `Auto-repair ${target.tool}`, () =>
      sysagent.deploymentInstallRuntimeTool({ tool: target.tool })
    );
    assertLiveResult(installResult, `Auto-repair ${target.tool}`);
    autoInstalled.push(target.tool);
  }

  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Composer platform repair applied", { tools: autoInstalled });
  return autoInstalled.length > 0;
}

async function githubCloneToken(sourceProvider: string, gitUrl: string | null) {
  if (sourceProvider !== "GITHUB" || !gitUrl?.startsWith("https://github.com/")) return null;
  return getSecret(githubTokenSecretRef());
}

async function resolveEnvVars(env: { key: string; value: string | null; secretRef: string | null }[]): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  await Promise.all(
    env.map(async (v) => {
      if (v.value !== null && v.value !== undefined) {
        resolved[v.key] = v.value;
      } else if (v.secretRef) {
        const secret = await getSecret(v.secretRef);
        if (secret !== null) resolved[v.key] = secret;
      }
    })
  );
  return resolved;
}

function assertCommandTree(result: unknown, label: string) {
  if (!result || typeof result !== "object") return;
  const value = result as { dryRun?: boolean; returncode?: number; stderr?: string; reason?: string; command?: unknown };
  if (Array.isArray(value.command) || typeof value.returncode === "number" || value.dryRun !== undefined) {
    assertLiveResult(value, label);
    return;
  }
  for (const [key, child] of Object.entries(result)) {
    if (child === null || key === "path") continue;
    assertCommandTree(child, `${label} ${key}`);
  }
}

async function processLifecycleAction(action: string, deploymentId: string, releaseId: string | undefined) {
  let deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: deploymentWorkerInclude });
  const processAction = action === "redeploy" || action === "deploy" ? "start" : action;

  try {
    if (action !== "stop") {
      deployment = await ensureManagedDeploymentPort(deployment, releaseId);
    }
    await assertRuntimeToolsInstalled(deployment.id, releaseId, {
      framework: deployment.framework,
      packageManager: deployment.packageManager,
      runtime: deployment.runtime,
      processManager: deployment.processManager,
      installCommand: deployment.installCommand,
      buildCommand: deployment.buildCommand,
      startCommand: deployment.startCommand
    });

    const envVars = await resolveEnvVars(deployment.env);
    const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
    const domain = deploymentDomain(deployment);
    const runtimeEnvVars = deploymentEnvWithPublicUrl(envVars, domain);

    if (processAction !== "stop" && domain) {
      await ensureDeploymentDomainProxy(deployment.id, domain);
      const serverName = deploymentServerName(domain);
      const nginxResult = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", () =>
        sysagent.deploymentNginx({
          deploymentId: deployment.id,
          serverName,
          upstreamPort: deployment.port,
          rootPath: deployment.rootPath,
          fallbackRootPath: deploymentFallbackRootPath(domain),
          forceSsl: domain.forceSsl
        })
      );
      assertLiveResult((nginxResult as { write?: unknown }).write, "Nginx proxy config write");
      assertLiveResult((nginxResult as { enable?: unknown }).enable, "Nginx proxy config enable");
      assertLiveResult((nginxResult as { test?: unknown }).test, "Nginx config test");
      assertLiveResult((nginxResult as { reload?: unknown }).reload, "Nginx reload");
    }

    const result = await runStep(deployment.id, releaseId, "STARTING", `${action} process`, () =>
      sysagent.deploymentProcess({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        action: processAction,
        processManager,
        startCommand: renderStartCommand(deployment),
        port: deployment.port,
        env: runtimeEnvVars,
        logDir: deploymentLogDir(deployment.slug)
      })
    );
    assertLiveResult(result, `${action} process`);

    if (processAction === "stop") {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "STOPPED", healthStatus: "DOWN", lastHealthCheckAt: new Date() } });
      return { result, status: "STOPPED", healthStatus: "DOWN" };
    }

    const health = await runStep(deployment.id, releaseId, "HEALTH_CHECK", `${action} health check`, () =>
        sysagent.deploymentHealth({
          deploymentId: deployment.id,
          port: deployment.port,
          healthUrl: deployment.healthUrl,
          processName: deployment.slug,
          processManager,
          rootPath: appPath
        })
    );
    await assertHealthResult(health, `${action} health check`, deployment);

    const publicRouteWarning = await optionalPublicRouteWarning(deployment.id, releaseId, `${action} public website check`, { ...deployment, domain });

    const healthStatus = publicRouteWarning ? "DEGRADED" : "HEALTHY";
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "RUNNING", healthStatus, lastHealthCheckAt: new Date() } });
    return { result, health, status: "RUNNING", healthStatus, publicRouteWarning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown lifecycle error";
    const nextStatus = processAction === "stop" ? "RUNNING" : "FAILED";
    const nextHealth = processAction === "stop" ? "UNKNOWN" : "DOWN";
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: nextStatus, healthStatus: nextHealth, lastHealthCheckAt: new Date() }
    });
    await writeLog(deployment.id, releaseId, "FAILED", `${action} failed`, { error: message }, "error");
    throw error;
  }
}

async function processDeploy(action: string, deploymentId: string, releaseId: string | undefined) {
  const startedAt = new Date();
  let deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: deploymentWorkerInclude });
  await resetBuildLogs(deployment.id);
  await markRelease(releaseId, "RUNNING", startedAt);
  await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "DEPLOYING" } });

  try {
    deployment = await ensureManagedDeploymentPort(deployment, releaseId);
    await runStep(deployment.id, releaseId, "PREFLIGHT", "Preflight", async () => ({
      rootPath: deployment.rootPath,
      port: deployment.port,
      sourceProvider: deployment.sourceProvider,
      envCount: deployment.env.length
    }));

    if (deployment.gitUrl || action === "pull") {
      const gitToken = await githubCloneToken(deployment.sourceProvider, deployment.gitUrl);
      const syncResult = await runStep(deployment.id, releaseId, "CLONING", "Source sync", () =>
        sysagent.deploymentGitSync({
          rootPath: deployment.rootPath,
          gitUrl: action === "pull" ? null : deployment.gitUrl,
          branch: deployment.branch,
          commitSha: deployment.commitSha,
          gitToken
        })
      );
      assertCommandTree(syncResult, "Source sync");
    } else {
      await writeLog(deployment.id, releaseId, "CLONING", "Source sync skipped for non-Git source", { sourceProvider: deployment.sourceProvider });
    }

    const detection = await runStep(deployment.id, releaseId, "PREFLIGHT", "Runtime detection", () =>
      detectDeploymentSource(deployment.rootPath, deployment.rootDirectory)
    );
    deployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        framework: detection.detected,
        runtime: detection.suggestions.runtime,
        packageManager: detection.suggestions.packageManager,
        installCommand: detection.suggestions.installCommand,
        buildCommand: detection.suggestions.buildCommand,
        startCommand: detection.suggestions.startCommand,
        outputDirectory: detection.suggestions.outputDirectory,
        processManager: detection.suggestions.processManager
      },
      include: deploymentWorkerInclude
    });
    await assertRuntimeToolsInstalled(deployment.id, releaseId, deployment);

    if (deployment.processManager === "NONE" && deployment.framework !== "STATIC") {
      throw new Error(`No runnable start command found for ${deployment.slug}. Add a package.json start script or set a manual start command.`);
    }

    const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    const domain = deploymentDomain(deployment);
    const envVars = deploymentEnvWithPublicUrl(await resolveEnvVars(deployment.env), domain);

    if (deployment.installCommand || deployment.packageManager) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "BUILDING" } });
      const runDependencyInstall = () => runStep(deployment.id, releaseId, "INSTALLING", "Dependency install", () =>
        sysagent.deploymentInstall({
          rootPath: appPath,
          command: renderDeploymentCommand(deployment.installCommand, deployment.port),
          packageManager: deployment.packageManager,
          env: envVars
        })
      );
      let installResult = await runDependencyInstall();
      try {
        assertCommandTree(installResult, "Dependency install");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const repaired = await autoRepairComposerPlatformIssue(deployment.id, releaseId, detail).catch(() => false);
        if (!repaired) throw error;
        installResult = await runDependencyInstall();
        assertCommandTree(installResult, "Dependency install");
      }
    }

    if (deployment.framework === "LARAVEL") {
      const migrateResult = await runStep(deployment.id, releaseId, "MIGRATING", "Database migration", () =>
        sysagent.deploymentMigrate({
          rootPath: appPath,
          command: "php artisan migrate --force",
          env: envVars
        })
      );
      assertCommandTree(migrateResult, "Database migration");
    } else {
      await writeLog(deployment.id, releaseId, "MIGRATING", "Migration skipped for framework", { framework: deployment.framework });
    }

    if (deployment.buildCommand) {
      const buildResult = await runStep(deployment.id, releaseId, "BUILDING", "Build", () =>
        sysagent.deploymentBuild({
          rootPath: appPath,
          command: renderDeploymentCommand(deployment.buildCommand, deployment.port),
          env: envVars
        })
      );
      assertCommandTree(buildResult, "Build");
    }

    await ensureDeploymentDomainProxy(deployment.id, domain);
    const serverName = deploymentServerName(domain);
    const nginxResult = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", () =>
      sysagent.deploymentNginx({
        deploymentId: deployment.id,
        serverName,
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        fallbackRootPath: deploymentFallbackRootPath(domain),
        forceSsl: domain?.forceSsl ?? false
      })
    );
    assertLiveResult((nginxResult as { write?: unknown }).write, "Nginx proxy config write");
    assertLiveResult((nginxResult as { enable?: unknown }).enable, "Nginx proxy config enable");
    assertLiveResult((nginxResult as { test?: unknown }).test, "Nginx config test");
    assertLiveResult((nginxResult as { reload?: unknown }).reload, "Nginx reload");

    if (domain?.forceSsl) {
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL request", () =>
        sslQueue.add("issue", {
          domainId: domain.id.startsWith("subdomain:") ? null : domain.id,
          domain: domain.name,
          email: `admin@${domain.name}`,
          source: "deployment"
        })
      );
    } else {
      await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL request skipped", { reason: domain ? "Force SSL is disabled" : "No linked domain" });
    }

    const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
    const startResult = await runStep(deployment.id, releaseId, "STARTING", "Process start", () =>
      sysagent.deploymentProcess({
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        action: "start",
        processManager,
        startCommand: renderStartCommand(deployment),
        port: deployment.port,
        env: envVars,
        logDir: deploymentLogDir(deployment.slug)
      })
    );
    assertLiveResult(startResult, "Process start");

    const health = await runStep(deployment.id, releaseId, "HEALTH_CHECK", "Health check", () =>
      sysagent.deploymentHealth({
        deploymentId: deployment.id,
        port: deployment.port,
        healthUrl: deployment.healthUrl,
        processName: deployment.slug,
        processManager,
        rootPath: appPath
      })
    );
    await assertHealthResult(health, "Health check", deployment);

    const publicRouteWarning = await optionalPublicRouteWarning(deployment.id, releaseId, "Public website check", { ...deployment, domain });

    await markRelease(releaseId, action === "rollback" ? "ROLLED_BACK" : "SUCCEEDED", startedAt);
    const healthStatus = publicRouteWarning ? "DEGRADED" : "HEALTHY";
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "RUNNING",
        healthStatus,
        lastHealthCheckAt: new Date(),
        lastDeployAt: new Date()
      }
    });
    await writeLog(deployment.id, releaseId, action === "rollback" ? "ROLLBACK" : "SUCCEEDED", `${action} completed`, { dryRun: false, publicRouteWarning });
    return { dryRun: false, completed: true, status: "RUNNING", healthStatus, publicRouteWarning };
  } catch (error) {
    await markRelease(releaseId, "FAILED", startedAt);
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "FAILED", healthStatus: "DOWN" } });
    await writeLog(deployment.id, releaseId, "FAILED", `${action} failed`, { error: error instanceof Error ? error.message : "Unknown error" }, "error");
    throw error;
  }
}

export const deployWorker = new Worker(
  "deploy",
  async (job) => {
    const data = job.data as DeployJobData;
    logger.info("deployment job received", { id: job.id, name: job.name, deploymentId: data.deploymentId });

    if (!data.deploymentId) {
      return { ignored: true, reason: "missing deployment id" };
    }

    if (["start", "stop", "restart"].includes(job.name)) {
      return processLifecycleAction(job.name, data.deploymentId, data.releaseId);
    }

    return processDeploy(job.name, data.deploymentId, data.releaseId);
  },
  { connection: redis }
);
