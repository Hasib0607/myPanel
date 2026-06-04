import { Worker } from "bullmq";
import { DeploymentFramework, DeploymentPackageManager, DeploymentProcessManager, DeploymentRuntime, Prisma } from "@prisma/client";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import {
  deploymentHasLaravelArtisan,
  deploymentHasLaravelPublicIndex,
  deploymentRunsLaravel,
  detectDeploymentFiles,
  detectDeploymentSource,
  findDeploymentAppRoot,
  findLaravelAppRoot,
  nodeStartUsesVitePreview
} from "../lib/deploymentDetection.js";
import { nginxUpstreamFailure, nodePackageBinaryMissing, supervisorStartStillStarting } from "../lib/deploymentFailureRuntimeRepairs.js";
import { appendFrontendModuleNotFoundHint, isComposerPlatformCheckInconclusive, requiredRuntimeExecutables, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables } from "../lib/deploymentRuntimeTools.js";
import {
  deploymentRecoveryAttempts,
  isRecoverableHealthFailure,
  restartDeploymentProcess,
  runGuardianDeploymentRepair,
  sleep as guardianRepairSleep
} from "../lib/deploymentGuardianRepair.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { deleteSecret, getSecret, putSecret } from "../lib/secrets.js";
import { sysagent } from "../lib/sysagent.js";
import { sslQueue } from "./queues.js";
import {
  type BoundDomain,
  boundDomainFromBinding,
  deploymentFallbackRootPath,
  deploymentServerName,
  deploymentSslCertificatePaths,
  deploymentHttpsReady,
  deploymentSslCertificatePathsWhenReady,
  deploymentCertbotIncludeWww,
  deploymentSslContactEmail,
  disableDeploymentTlsInDatabase,
  syncDeploymentTlsWithCertificate,
  ensureAcmeWebroot,
  ensureParentDomainDeploymentProxy,
  buildDeploymentNginxRequest,
  publishDeploymentProxyNginx,
  publishPublicHtmlNginxVhost,
  waitForQueueJob
} from "../lib/deploymentDomainSsl.js";

const execFileAsync = promisify(execFile);

type DeployJobData = {
  deploymentId?: string;
  releaseId?: string;
};

type DeployStep = "PREFLIGHT" | "CLONING" | "INSTALLING" | "MIGRATING" | "BUILDING" | "CONFIGURING_PROXY" | "STARTING" | "HEALTH_CHECK" | "SUCCEEDED" | "FAILED" | "ROLLBACK";
const buildLogRetentionMs = 24 * 60 * 60 * 1000;
const deploymentWorkerInclude = Prisma.validator<Prisma.DeploymentInclude>()({
  domain: { include: { account: true } },
  domainBindings: {
    include: {
      domain: { include: { account: true } },
      subdomain: { include: { domain: { include: { account: true } } } }
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }]
  },
  env: true
});

type DeploymentWithWorkerRelations = Prisma.DeploymentGetPayload<{ include: typeof deploymentWorkerInclude }>;

type DeploymentDatabaseRuntime = {
  id: string;
  port: number;
  dbType?: "POSTGRESQL" | "MYSQL" | null;
  dbName?: string | null;
  dbUser?: string | null;
  dbPasswordSecretRef?: string | null;
};

const deploymentLocks = new Map<string, Promise<unknown>>();

async function runDeploymentExclusive<T>(deploymentId: string, task: () => Promise<T>) {
  const previous = deploymentLocks.get(deploymentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  let tracked: Promise<unknown>;
  tracked = next.finally(() => {
    if (deploymentLocks.get(deploymentId) === tracked) deploymentLocks.delete(deploymentId);
  });
  deploymentLocks.set(deploymentId, tracked);
  return next;
}

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

function deploymentProcessConfig(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function laravelWorkerConfig(value: unknown) {
  const raw = value && typeof value === "object" ? value as Record<string, any> : {};
  const enabled = Boolean(raw.enabled);
  const minWorkers = Math.max(0, Math.min(64, Number(raw.minWorkers ?? 0) || 0));
  const maxWorkers = Math.max(1, Math.min(64, Number(raw.maxWorkers ?? 8) || 8));
  const desiredWorkers = enabled ? Math.max(minWorkers, Math.min(maxWorkers, Number(raw.desiredWorkers ?? raw.currentWorkers ?? minWorkers) || 0)) : 0;
  return {
    enabled,
    autoscale: Boolean(raw.autoscale),
    desiredWorkers,
    minWorkers,
    maxWorkers: Math.max(maxWorkers, minWorkers, desiredWorkers),
    queueCommand: typeof raw.queueCommand === "string" && raw.queueCommand.trim() ? raw.queueCommand.trim() : "php artisan queue:work --sleep=3 --tries=3 --timeout=90",
    currentWorkers: Math.max(0, Math.min(64, Number(raw.currentWorkers ?? 0) || 0)),
    lastScaledAt: typeof raw.lastScaledAt === "string" ? raw.lastScaledAt : undefined,
    lastScaleReason: typeof raw.lastScaleReason === "string" ? raw.lastScaleReason : undefined
  };
}

function laravelWorkerProgramName(slug: string) {
  return `${slug}-queue`;
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

async function wwwPointsToThisVps(domain: BoundDomain) {
  if (!deploymentCertbotIncludeWww(domain)) return false;
  try {
    const records = await dns.resolve4(`www.${domain.name}`);
    return records.includes(env.VPS_IP);
  } catch {
    return false;
  }
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

function isDryRunResult(result: unknown) {
  return Boolean(result && typeof result === "object" && (result as { dryRun?: boolean }).dryRun);
}

function isSupervisorSpawnError(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const text = JSON.stringify(result).toLowerCase();
  return text.includes("spawn error") || text.includes("can't spawn") || text.includes("cannot spawn");
}

function isSupervisorStartStillStarting(result: unknown) {
  if (!result || typeof result !== "object") return false;
  return supervisorStartStillStarting(JSON.stringify(result));
}

function isLaravelVendorAutoloadMissing(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const text = JSON.stringify(result).toLowerCase();
  return text.includes("vendor/autoload.php") && (text.includes("artisan") || text.includes("autoload"));
}

function isPythonPep604RuntimeIssue(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const text = JSON.stringify(result).toLowerCase();
  return text.includes("unsupported operand type")
    && text.includes("for |")
    && text.includes("nonetype")
    && text.includes("python3.9");
}

const liveSystemCommandsFix = "Set ALLOW_LIVE_SYSTEM_COMMANDS=true on vps-panel-sysagent, restart vps-panel-sysagent and vps-panel-workers, then retry.";

type SysagentLiveDiagnosis = {
  config?: { liveSystemCommandsEnabled?: boolean };
  incidents?: Array<{ category?: string; title?: string; detail?: string }>;
};

type DeploymentProcessBody = {
  deploymentId: string;
  name: string;
  rootPath: string;
  action: string;
  processManager: DeploymentProcessManager;
  startCommand: string | null;
  port: number;
  env: Record<string, string>;
  logDir: string;
  framework?: DeploymentFramework;
};

function sysagentLiveCommandsDisabled(diagnosis: SysagentLiveDiagnosis) {
  const disabledByConfig = diagnosis.config?.liveSystemCommandsEnabled === false;
  const disabledByIncident = diagnosis.incidents?.some((incident) =>
    incident.category === "sysagent" && /live system commands/i.test(`${incident.title ?? ""} ${incident.detail ?? ""}`)
  );
  return Boolean(disabledByConfig || disabledByIncident);
}

async function setPanelEnvValue(key: string, value: string) {
  const envPath = path.join(env.PANEL_UPDATE_WORKDIR, ".env");
  const current = await fs.readFile(envPath, "utf8");
  const next = new RegExp(`^${key}=.*$`, "m").test(current)
    ? current.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
    : `${current.replace(/\s*$/, "")}\n${key}=${value}\n`;
  if (next !== current) {
    await fs.writeFile(envPath, next, "utf8");
  }
  return { envPath, changed: next !== current };
}

async function systemctlRestart(service: string, noBlock = false) {
  const candidates = ["/usr/bin/systemctl", "/bin/systemctl", "systemctl"];
  let lastError: unknown = null;
  for (const systemctl of candidates) {
    try {
      const args = noBlock
        ? ["-n", systemctl, "--no-block", "restart", service]
        : ["-n", systemctl, "restart", service];
      return await execFileAsync("sudo", args, { timeout: 60_000 });
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") continue;
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("systemctl not found");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSysagentLiveCommandsEnabled(maxAttempts = 20) {
  let lastDiagnosis: SysagentLiveDiagnosis | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await sleep(1000);
    lastDiagnosis = await sysagent.guardianDiagnosis() as SysagentLiveDiagnosis;
    if (!sysagentLiveCommandsDisabled(lastDiagnosis)) {
      return { attempt, diagnosis: lastDiagnosis };
    }
  }
  throw new Error(`Sysagent live commands still disabled after ${maxAttempts} seconds`);
}

async function repairSysagentLiveCommands() {
  const envResults = [];
  envResults.push(await setPanelEnvValue("ALLOW_LIVE_SYSTEM_COMMANDS", "true"));
  envResults.push(await setPanelEnvValue("ALLOW_LIVE_FILE_MANAGER", "true"));
  envResults.push(await setPanelEnvValue("ALLOW_LIVE_NGINX", "true"));
  envResults.push(await setPanelEnvValue("ALLOW_LIVE_SSL", "true"));

  let reload: { reloaded: boolean; liveSystemCommandsEnabled: boolean; panelEnvPath?: string | null } | null = null;
  try {
    reload = await sysagent.reloadPanelEnv();
  } catch {
    reload = { reloaded: false, liveSystemCommandsEnabled: false };
  }

  if (reload.liveSystemCommandsEnabled) {
    const liveReady = await waitForSysagentLiveCommandsEnabled();
    return { envResults, reload, liveReady };
  }

  const restart = await systemctlRestart("vps-panel-sysagent");
  const liveReady = await waitForSysagentLiveCommandsEnabled();
  return {
    envResults,
    reload,
    restart: {
      stdout: restart.stdout,
      stderr: restart.stderr
    },
    liveReady
  };
}

async function repairSysagentLiveCommandsForDeployment(deploymentId: string, releaseId: string | undefined, reason: string) {
  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Sysagent live command auto-repair started", { reason });
  const repair = await repairSysagentLiveCommands();
  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Sysagent live command auto-repair completed", repair as Prisma.InputJsonObject);
  return repair;
}

async function assertSysagentLiveCommandsEnabled(deploymentId: string, releaseId: string | undefined) {
  let diagnosis = await sysagent.guardianDiagnosis() as SysagentLiveDiagnosis;
  if (!sysagentLiveCommandsDisabled(diagnosis)) return diagnosis;

  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Sysagent live command preflight failed", {
    fix: liveSystemCommandsFix,
    config: diagnosis.config ?? null
  }, "error");

  try {
    await repairSysagentLiveCommandsForDeployment(deploymentId, releaseId, "diagnosis reported live commands disabled");
    await writeLog(deploymentId, releaseId, "PREFLIGHT", "Sysagent live command mode repaired; rechecking");
    const liveReady = await waitForSysagentLiveCommandsEnabled();
    await writeLog(deploymentId, releaseId, "PREFLIGHT", "Sysagent live command preflight passed after repair", {
      attempt: liveReady.attempt,
      config: liveReady.diagnosis.config ?? null
    });
    return liveReady.diagnosis;
  } catch (error) {
    await writeLog(deploymentId, releaseId, "PREFLIGHT", "Sysagent live command auto-repair failed", {
      error: error instanceof Error ? error.message : String(error)
    }, "error");
  }

  throw new Error(`Sysagent live system commands are disabled. ${liveSystemCommandsFix}`);
}

async function runLiveDeploymentProcess(
  deploymentId: string,
  releaseId: string | undefined,
  label: string,
  body: DeploymentProcessBody
) {
  let result = await runStep(deploymentId, releaseId, "STARTING", label, () => sysagent.deploymentProcess(body));
  if (isDryRunResult(result)) {
    await writeLog(deploymentId, releaseId, "STARTING", `${label} returned dry-run; repairing sysagent live mode and retrying`, {
      result: result as Prisma.InputJsonValue
    }, "warn");
    try {
      await repairSysagentLiveCommandsForDeployment(deploymentId, releaseId, `${label} returned dry-run`);
      await waitForSysagentLiveCommandsEnabled();
      result = await runStep(deploymentId, releaseId, "STARTING", `${label} retry after sysagent live repair`, () =>
        sysagent.deploymentProcess(body)
      );
    } catch (error) {
      await writeLog(deploymentId, releaseId, "STARTING", `${label} live-mode repair failed`, {
        error: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }

  if (isSupervisorSpawnError(result)) {
    await writeLog(deploymentId, releaseId, "STARTING", `${label} hit Supervisor spawn error; repairing permissions and retrying`, {
      result: result as Prisma.InputJsonValue
    }, "warn");
    try {
      const repair = await sysagent.deploymentRepairPermissions({ rootPath: body.rootPath, logDir: body.logDir });
      await writeLog(deploymentId, releaseId, "STARTING", "Supervisor spawn permission repair completed", repair as Prisma.InputJsonObject);
      result = await runStep(deploymentId, releaseId, "STARTING", `${label} retry after Supervisor permission repair`, () =>
        sysagent.deploymentProcess(body)
      );
    } catch (error) {
      await writeLog(deploymentId, releaseId, "STARTING", "Supervisor spawn permission repair failed", {
        error: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }

  if (isLaravelVendorAutoloadMissing(result)) {
    await writeLog(deploymentId, releaseId, "STARTING", `${label} missing Laravel vendor/autoload; running Guardian dependency repair and retrying`, {
      result: result as Prisma.InputJsonValue
    }, "warn");
    try {
      const install = await runStep(deploymentId, releaseId, "INSTALLING", "Guardian Laravel dependency install", () =>
        sysagent.deploymentInstall({
          rootPath: body.rootPath,
          packageManager: "COMPOSER",
          command: "composer install --no-dev --optimize-autoloader --no-interaction",
          env: body.env
        })
      );
      assertLiveResult(install, "Guardian Laravel dependency install");
      await runStep(deploymentId, releaseId, "STARTING", "Guardian deployment repair", async () =>
        runGuardianDeploymentRepair({ rootPath: body.rootPath, framework: "LARAVEL", envVars: body.env })
      );
      result = await runStep(deploymentId, releaseId, "STARTING", `${label} retry after Laravel dependency repair`, () =>
        sysagent.deploymentProcess(body)
      );
    } catch (error) {
      await writeLog(deploymentId, releaseId, "STARTING", "Guardian Laravel dependency repair failed", {
        error: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }

  if (isPythonPep604RuntimeIssue(result)) {
    await writeLog(deploymentId, releaseId, "STARTING", `${label} hit Python 3.9 syntax/runtime mismatch; running Guardian Python runtime repair`, {
      result: result as Prisma.InputJsonValue
    }, "warn");
    try {
      let repair = await runStep(deploymentId, releaseId, "PREFLIGHT", "Guardian Python runtime repair", () =>
        sysagent.deploymentRepairPythonRuntime({ rootPath: body.rootPath })
      );
      if (liveResultFailureMessage(repair, "Guardian Python runtime repair")?.includes("Python 3.10+")) {
        const install = await runStep(deploymentId, releaseId, "PREFLIGHT", "Auto-repair Python 3.11 runtime", () =>
          sysagent.deploymentInstallRuntimeTool({ tool: "python311" })
        );
        assertLiveResult(install, "Auto-repair Python 3.11 runtime");
        repair = await runStep(deploymentId, releaseId, "PREFLIGHT", "Guardian Python runtime repair retry", () =>
          sysagent.deploymentRepairPythonRuntime({ rootPath: body.rootPath })
        );
      }
      assertLiveResult(repair, "Guardian Python runtime repair");
      result = await runStep(deploymentId, releaseId, "STARTING", `${label} retry after Python runtime repair`, () =>
        sysagent.deploymentProcess(body)
      );
    } catch (error) {
      await writeLog(deploymentId, releaseId, "STARTING", "Guardian Python runtime repair failed", {
        error: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }

  if (isSupervisorStartStillStarting(result)) {
    await writeLog(deploymentId, releaseId, "STARTING", `${label} returned Supervisor abnormal termination while status is STARTING; waiting for health before failing`, {
      result: result as Prisma.InputJsonValue
    }, "warn");
    let lastHealth: unknown = null;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await sleep(3000);
      lastHealth = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} Supervisor STARTING health poll ${attempt}`, () =>
        sysagent.deploymentHealth({
          deploymentId: body.deploymentId,
          port: body.port,
          processName: body.name,
          processManager: body.processManager,
          rootPath: body.rootPath,
          framework: body.framework
        })
      );
      const healthError = liveResultFailureMessage(lastHealth, `${label} Supervisor STARTING health poll ${attempt}`);
      if (!healthError) {
        await writeLog(deploymentId, releaseId, "STARTING", `${label} recovered after Supervisor STARTING health poll`, {
          attempt,
          health: lastHealth as Prisma.InputJsonValue
        });
        return {
          ...(result as Record<string, unknown>),
          returncode: 0,
          stderr: "",
          recoveredFromSupervisorStarting: true,
          health: lastHealth
        };
      }
    }
    await writeLog(deploymentId, releaseId, "STARTING", `${label} stayed unhealthy after Supervisor STARTING health polling`, {
      health: lastHealth as Prisma.InputJsonValue
    }, "warn");
  }

  return result;
}

function liveResultFailureMessage(result: unknown, label: string) {
  const value = result as {
    dryRun?: boolean;
    blocked?: boolean;
    liveCommandsDisabled?: boolean;
    returncode?: number;
    stderr?: string;
    stdout?: string;
    reason?: string;
    path?: { allowed?: boolean; target?: string; root?: string };
  };
  if (value?.blocked) {
    const pathHint = value.path?.allowed === false && value.path?.target && value.path?.root
      ? ` Path ${value.path.target} is outside ${value.path.root}.`
      : "";
    return `${label} was blocked: ${value.reason ?? value.stderr ?? "policy restriction"}.${pathHint}`;
  }
  if (value?.dryRun) {
    if (value.liveCommandsDisabled) {
      return `${label} did not run live. ${liveSystemCommandsFix}`;
    }
    const detail = value.reason ?? value.stderr ?? value.stdout;
    return detail
      ? `${label} did not run live: ${detail}`
      : `${label} did not run live. ${liveSystemCommandsFix}`;
  }
  if (typeof value?.returncode === "number" && value.returncode !== 0) {
    const signal = "signal" in value && typeof value.signal === "string" ? value.signal : null;
    const stderrText = value.stderr ?? "";
    const stdoutText = value.stdout ?? "";
    const logsText = "logs" in value && typeof value.logs === "object" && value.logs !== null
      ? ((value.logs as { stderr?: string; stdout?: string; text?: string }).stderr || (value.logs as { stderr?: string; stdout?: string; text?: string }).stdout || (value.logs as { stderr?: string; stdout?: string; text?: string }).text || "")
      : "";
    const postStatusText = "postStatus" in value && typeof value.postStatus === "object" && value.postStatus !== null
      ? ((value.postStatus as { stdout?: string; stderr?: string }).stdout || (value.postStatus as { stdout?: string; stderr?: string }).stderr || "")
      : "";
    const detailText = [stderrText || stdoutText, logsText ? `Runtime logs: ${logsText}` : "", postStatusText ? `Supervisor status: ${postStatusText}` : ""].filter(Boolean).join("\n");
    const oomKilled = value.returncode === -9 || signal === "SIGKILL" || stderrText.includes("SIGKILL");
    const sigtermKilled = !oomKilled && (value.returncode === -15 || signal === "SIGTERM");
    const signalHint = oomKilled
      ? " The process was killed by the OOM killer (SIGKILL) — the server ran out of memory. Add swap space: run `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab` in the panel Terminal, then redeploy."
      : sigtermKilled
        ? " The command was terminated by SIGTERM. This may be caused by the OS killing the process due to low memory — try adding swap or reducing build memory usage (e.g. NODE_OPTIONS=--max-old-space-size=512 in env vars). If it repeats, increase DEPLOYMENT_COMMAND_TIMEOUT_SECONDS."
        : "";
    return `${label} failed with exit code ${value.returncode}${signal ? ` (${signal})` : ""}${detailText ? `: ${detailText}` : ""}${signalHint}`;
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

type GitSyncCommitInfo = {
  sha: string | null;
  message: string | null;
  author: string | null;
};

function gitSyncCommitInfo(result: unknown): GitSyncCommitInfo | null {
  if (!result || typeof result !== "object") return null;
  const commit = (result as { commit?: unknown }).commit;
  if (!commit || typeof commit !== "object") return null;
  const value = commit as { sha?: unknown; message?: unknown; author?: unknown };
  const sha = typeof value.sha === "string" && value.sha ? value.sha : null;
  const message = typeof value.message === "string" && value.message ? value.message : null;
  const author = typeof value.author === "string" && value.author ? value.author : null;
  return sha || message || author ? { sha, message, author } : null;
}

async function syncReleaseCommitInfo(deploymentId: string, releaseId: string | undefined, commit: GitSyncCommitInfo | null) {
  if (!commit?.sha) return;
  const data = {
    commitSha: commit.sha,
    commitMessage: commit.message,
    commitAuthor: commit.author
  };
  await prisma.deployment.update({ where: { id: deploymentId }, data: { commitSha: commit.sha } });
  if (releaseId) {
    await prisma.deploymentRelease.update({
      where: { id: releaseId },
      data
    });
  }
}

function renderDeploymentCommand(command: string | null | undefined, port: number) {
  return command?.replaceAll("{PORT}", String(port)).replaceAll("$PORT", String(port)) ?? null;
}

function laravelStartCommand(port: number) {
  return `php artisan serve --host=127.0.0.1 --port ${port}`;
}

function isLegacyLaravelPhpFpmCommand(command: string | null | undefined) {
  const normalized = command?.trim().toLowerCase() ?? "";
  return !normalized || normalized === "php-fpm" || /^php\d*-fpm/.test(normalized) || /^php-fpm/.test(normalized);
}

function renderStartCommand(deployment: { framework: DeploymentFramework; startCommand: string | null; port: number }) {
  if (deployment.framework === "NEXTJS") {
    return `npx next start -p ${deployment.port} -H 127.0.0.1`;
  }
  if (deployment.framework === "LARAVEL" && isLegacyLaravelPhpFpmCommand(deployment.startCommand)) {
    return laravelStartCommand(deployment.port);
  }
  return renderDeploymentCommand(deployment.startCommand, deployment.port);
}

function deploymentAppPath(rootPath: string, rootDirectory: string | null | undefined) {
  const cleanRootDirectory = (rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? path.join(rootPath, cleanRootDirectory) : rootPath;
}

async function staticRootHasIndex(rootPath: string | null) {
  if (!rootPath) return false;
  for (const filename of ["index.html", "index.htm", "index.php"]) {
    try {
      await fs.access(path.join(rootPath, filename));
      return true;
    } catch {
      // Keep looking for another supported index file.
    }
  }
  return false;
}

function deploymentDomain(deployment: { domain?: BoundDomain | null; domainBindings?: Array<{ role: string; domain?: BoundDomain | null; subdomain?: { id: string; name: string; sslEnabled: boolean; domainId: string; domain: { name: string; documentRoot?: string | null } } | null }> }) {
  const primary = deployment.domainBindings?.find((binding) => binding.role === "primary");
  return (primary ? boundDomainFromBinding(primary) : null)
    ?? (deployment.domainBindings?.[0] ? boundDomainFromBinding(deployment.domainBindings[0]) : null)
    ?? deployment.domain
    ?? null;
}

function deploymentPublicEnv(domain: BoundDomain | null, httpsReady = false) {
  if (!domain?.name) return {} as Record<string, string>;
  const scheme = httpsReady ? "https" : "http";
  const url = `${scheme}://${domain.name}`;
  const shared = {
    APP_URL: url,
    ASSET_URL: url,
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
    VITE_APP_URL: url,
    VITE_BASE_URL: url,
    VITE_PUBLIC_URL: url,
    ORIGIN: url,
    PUBLIC_URL: url,
    SERVER_URL: url,
    SITE_URL: url,
    URL: url,
    VERCEL_URL: domain.name
  };
  if (scheme === "https") {
    return {
      ...shared,
      SESSION_SECURE_COOKIE: "true",
      SESSION_SAME_SITE: "lax",
      TRUSTED_PROXIES: "*"
    };
  }
  return {
    ...shared,
    SESSION_SECURE_COOKIE: "false"
  };
}

function isLocalhostValue(value: string | null | undefined) {
  return Boolean(value && /(^|\/\/|\.)localhost(?::\d+)?(\/|$)|(^|\/\/)127\.0\.0\.1(?::\d+)?(\/|$)|(^|\/\/)0\.0\.0\.0(?::\d+)?(\/|$)/i.test(value));
}

function isSameDomainPublicUrl(value: string | null | undefined, domain: BoundDomain | null) {
  if (!value || !domain?.name) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === domain.name && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return value === domain.name || value === `http://${domain.name}` || value === `https://${domain.name}`;
  }
}

function deploymentEnvWithPublicUrl(envVars: Record<string, string>, domain: BoundDomain | null, httpsReady = false) {
  const publicEnv: Record<string, string> = deploymentPublicEnv(domain, httpsReady);
  const merged: Record<string, string> = { ...publicEnv, ...envVars };

  if (!domain?.name) return merged;

  for (const [key, publicValue] of Object.entries(publicEnv)) {
    const currentValue = merged[key];
    if (!currentValue || isLocalhostValue(currentValue) || isSameDomainPublicUrl(currentValue, domain)) {
      merged[key] = publicValue;
    }
  }

  if (httpsReady) {
    const httpsUrl = `https://${domain.name}`;
    for (const key of ["APP_URL", "ASSET_URL", "APP_ORIGIN", "AUTH_URL", "BASE_URL", "PUBLIC_URL", "SITE_URL", "URL"]) {
      const current = merged[key];
      if (!current || isLocalhostValue(current) || isSameDomainPublicUrl(current, domain)) {
        merged[key] = httpsUrl;
      }
    }
    merged.SESSION_SECURE_COOKIE = "true";
    merged.SESSION_SAME_SITE = merged.SESSION_SAME_SITE || "lax";
    merged.TRUSTED_PROXIES = merged.TRUSTED_PROXIES || "*";
  }

  return merged;
}

function isPostgresDeploymentEnvironment(deployment: { dbType?: string | null }, envVars: Record<string, string>) {
  return deployment.dbType === "POSTGRESQL"
    || envVars.DB_CONNECTION === "pgsql"
    || envVars.DATABASE_URL?.startsWith("postgres://")
    || envVars.DATABASE_URL?.startsWith("postgresql://");
}

async function normalizePostgresRuntimeEnv(deploymentId: string, envVars: Record<string, string>, persist = true) {
  const normalized = { ...envVars };
  let changed = false;

  if ((normalized.DB_CHARSET || "").toLowerCase() !== "utf8") {
    normalized.DB_CHARSET = "utf8";
    changed = true;
    if (persist) await upsertDeploymentEnvValue(deploymentId, "DB_CHARSET", "utf8");
  }

  if ((normalized.DB_COLLATION || "").length > 0) {
    normalized.DB_COLLATION = "";
    changed = true;
    if (persist) await upsertDeploymentEnvValue(deploymentId, "DB_COLLATION", "");
  }

  if ((normalized.DB_CONNECTION || "").toLowerCase() !== "pgsql") {
    normalized.DB_CONNECTION = "pgsql";
    changed = true;
    if (persist) await upsertDeploymentEnvValue(deploymentId, "DB_CONNECTION", "pgsql");
  }

  return { envVars: normalized, changed };
}

async function assertHealthResult(
  result: unknown,
  label: string,
  deployment: { id: string; slug: string },
  releaseId?: string,
  appPath?: string
) {
  const value = result as { degraded?: boolean; httpCode?: number; stderr?: string };
  if (value?.degraded) {
    let runtimeText = "";
    try {
      const logs = await sysagent.deploymentRuntimeLogs({
        name: deployment.slug,
        logDir: deploymentLogDir(deployment.slug),
        rootPath: appPath,
        lines: 120
      });
      runtimeText = logs.text ? `\n\nRunning log tail:\n${logs.text}` : "";
    } catch {
      runtimeText = "";
    }
    await writeLog(deployment.id, releaseId, "HEALTH_CHECK", `${label} degraded`, {
      httpCode: value.httpCode ?? null,
      detail: value.stderr ?? null,
      runtimeText: runtimeText || null
    }, "warn");
    return { degraded: true as const, httpCode: value.httpCode, message: value.stderr ?? `${label} returned HTTP ${value.httpCode ?? "error"}` };
  }

  const message = liveResultFailureMessage(result, label);
  if (!message) return { degraded: false as const };

  let runtimeText = "";
  try {
    const logs = await sysagent.deploymentRuntimeLogs({
      name: deployment.slug,
      logDir: deploymentLogDir(deployment.slug),
      rootPath: appPath,
      lines: 120
    });
    runtimeText = logs.text ? `\n\nRunning log tail:\n${logs.text}` : "";
  } catch (error) {
    runtimeText = `\n\nCould not read running log: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  throw new Error(`${message}${runtimeText}`);
}

async function runHealthCheckWithGuardianRecovery(
  deployment: {
    id: string;
    slug: string;
    framework: DeploymentFramework;
    port: number;
    healthUrl: string | null;
    startCommand: string | null;
    processManager: DeploymentProcessManager | null;
    dbType?: "POSTGRESQL" | "MYSQL" | null;
    dbName?: string | null;
    dbUser?: string | null;
    dbPasswordSecretRef?: string | null;
  },
  releaseId: string | undefined,
  appPath: string,
  envVars: Record<string, string>,
  processManager: DeploymentProcessManager,
  label: string
) {
  const attempts = deploymentRecoveryAttempts();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const health = await runStep(
      deployment.id,
      releaseId,
      "HEALTH_CHECK",
      attempt === 1 ? label : `${label} retry ${attempt}`,
      () =>
        sysagent.deploymentHealth({
          deploymentId: deployment.id,
          port: deployment.port,
          healthUrl: deployment.healthUrl,
          processName: deployment.slug,
          processManager,
          rootPath: appPath,
          framework: deployment.framework
        })
    );

    try {
      const outcome = await assertHealthResult(health, label, deployment, releaseId, appPath);
      if (attempt > 1) {
        await writeLog(deployment.id, releaseId, "HEALTH_CHECK", "Guardian recovery succeeded", { attempt });
      }
      return { health, outcome };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= attempts || !isRecoverableHealthFailure(health)) {
        break;
      }

      await writeLog(deployment.id, releaseId, "HEALTH_CHECK", `Guardian recovery attempt ${attempt}/${attempts}`, {
        error: lastError.message,
        health: health as Prisma.InputJsonValue
      }, "warn");

      const repairedDatabaseEnv = await autoRepairDatabaseAccess(deployment, releaseId, appPath, lastError.message, envVars).catch(() => null);
      if (repairedDatabaseEnv) {
        envVars = repairedDatabaseEnv;
      }

      await runStep(deployment.id, releaseId, "HEALTH_CHECK", "Guardian deployment repair", async () =>
        runGuardianDeploymentRepair({ rootPath: appPath, framework: deployment.framework, envVars })
      ).then(async (repair) => {
        const repairedKey = (repair as { appKey?: string }).appKey;
        if (repairedKey) {
          envVars.APP_KEY = repairedKey;
          await upsertDeploymentEnvValue(deployment.id, "APP_KEY", repairedKey);
        }
        return repair;
      });
      await runStep(deployment.id, releaseId, "HEALTH_CHECK", "Guardian process restart", () =>
        restartDeploymentProcess({
          deploymentId: deployment.id,
          slug: deployment.slug,
          appPath,
          port: deployment.port,
          processManager,
          startCommand: renderStartCommand(deployment),
          envVars,
          logDir: deploymentLogDir(deployment.slug)
        })
      );
      await guardianRepairSleep(5000);
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

async function deploymentRuntimeLogTail(deployment: { slug: string }, appPath?: string) {
  try {
    const logs = await sysagent.deploymentRuntimeLogs({
      name: deployment.slug,
      logDir: deploymentLogDir(deployment.slug),
      rootPath: appPath,
      lines: 80
    });
    return logs.text ? `\n\nRunning log tail:\n${logs.text}` : "";
  } catch {
    return "";
  }
}

function isNginxStaticRootForbidden(warning: string) {
  return /HTTP 403/i.test(warning) && /403 Forbidden/i.test(warning) && /nginx/i.test(warning);
}

function isPublicRouteHttp403(warning: string) {
  return /HTTP 403/i.test(warning);
}

function isSslProtocolPublicRouteIssue(result: unknown, warning: string | null | undefined) {
  const route = result as { returncode?: number; stderr?: string; httpCode?: number };
  const text = `${warning ?? ""} ${route.stderr ?? ""}`;
  return route.returncode === 35
    || /SSL handshake failed|invalid SSL response|ERR_SSL_PROTOCOL|SSL_PROTOCOL_ERROR/i.test(text);
}

async function repairDeploymentSslAccess(
  deploymentId: string,
  releaseId: string | undefined,
  deployment: {
    id: string;
    port: number;
    rootPath: string;
    framework: DeploymentFramework;
    startCommand?: string | null;
    publicDirectory?: string | null;
    outputDirectory?: string | null;
  },
  domain: BoundDomain
) {
  const includeWww = await wwwPointsToThisVps(domain);
  const serverName = deploymentServerName({ ...domain, includeWww });
  if (!serverName) return null;

  const sslPaths = await deploymentSslCertificatePathsWhenReady(domain);
  const repairResult = await runStep(deploymentId, releaseId, "CONFIGURING_PROXY", "Repair public nginx and SSL listeners", () =>
    sysagent.deploymentPublicAccessRepair(
      buildDeploymentNginxRequest({
        deploymentId: deployment.id,
        fqdn: serverName,
        upstreamPort: deployment.port,
        rootPath: deployment.rootPath,
        framework: deployment.framework,
        startCommand: deployment.startCommand,
        publicDirectory: deployment.publicDirectory,
        outputDirectory: deployment.outputDirectory,
        fallbackRootPath: deploymentFallbackRootPath(domain),
        forceSsl: false,
        ...sslPaths
      })
    )
  );
  assertLiveResult((repairResult as { test?: unknown }).test, "Public access repair nginx test");
  assertLiveResult((repairResult as { reload?: unknown }).reload, "Public access repair nginx reload");

  if (await deploymentHttpsReady(domain)) {
    await republishDeploymentNginxVhost(deploymentId, releaseId, deployment, domain);
    return null;
  }

  try {
    const includeWww = await wwwPointsToThisVps(domain);
    await runStep(deploymentId, releaseId, "CONFIGURING_PROXY", "ACME preflight before SSL repair", async () => {
      await ensureAcmeWebroot(domain);
      const webRoot = deploymentFallbackRootPath(domain) ?? `${env.FILE_MANAGER_ROOT}/${domain.name}/public_html`;
      const preflight = await sysagent.sslPreflight({
        domain: domain.name,
        webRoot,
        includeWww
      });
      const checks = (preflight as { checks?: Array<{ returncode?: number }> }).checks ?? [];
      const failed = checks.filter((check) => check.returncode !== 0);
      if (failed.length > 0) {
        throw new Error(`ACME HTTP challenge is not reachable for ${domain.name}. Point DNS A record to this VPS, then redeploy.`);
      }
      return preflight;
    });

    const sslJob = await sslQueue.add("issue", {
      domainId: domain.id.startsWith("subdomain:") ? null : domain.id,
      subdomainId: domain.id.startsWith("subdomain:") ? domain.id.slice("subdomain:".length) : null,
      domain: domain.name,
      email: deploymentSslContactEmail(domain),
      webRoot: deploymentFallbackRootPath(domain) ?? `${env.FILE_MANAGER_ROOT}/${domain.name}/public_html`,
      includeWww,
      forceSsl: true,
      source: "deployment-repair"
    });
    await runStep(deploymentId, releaseId, "CONFIGURING_PROXY", "SSL repair issue", async () => {
      await waitForQueueJob(sslJob);
      return { jobId: sslJob.id, completed: true };
    });
    await syncDeploymentTlsWithCertificate(domain);
    await republishDeploymentNginxVhost(deploymentId, releaseId, deployment, domain);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${detail} Open http://${domain.name}/ until HTTPS is fixed.`;
  }
}

function isMissingLaravelAppKeyWarning(warning: string) {
  return /MissingAppKeyException/i.test(warning) || /No application encryption key has been specified/i.test(warning);
}

async function republishDeploymentNginxVhost(
  deploymentId: string,
  releaseId: string | undefined,
  deployment: {
    id: string;
    port: number;
    rootPath: string;
    framework: DeploymentFramework;
    startCommand?: string | null;
    publicDirectory?: string | null;
    outputDirectory?: string | null;
  },
  domain: BoundDomain
) {
  const serverName = deploymentServerName(domain);
  if (!serverName) return;
  const httpsReady = await deploymentHttpsReady(domain);
  await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Republish nginx vhost", () =>
    publishDeploymentProxyNginx({
      deploymentId: deployment.id,
      fqdn: serverName,
      upstreamPort: deployment.port,
      rootPath: deployment.rootPath,
      framework: deployment.framework,
      startCommand: deployment.startCommand,
      publicDirectory: deployment.publicDirectory,
      outputDirectory: deployment.outputDirectory,
      fallbackRootPath: deploymentFallbackRootPath(domain),
      forceHttps: httpsReady
    })
  );
}

async function reconcileNodeProductionStartCommand(
  deployment: DeploymentWithWorkerRelations,
  releaseId: string | undefined
) {
  if (deployment.framework !== "NODEJS" && deployment.framework !== "NEXTJS") {
    return deployment;
  }

  const detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
  const suggested = detection.suggestions.startCommand;
  if (!suggested || suggested === deployment.startCommand) {
    return deployment;
  }

  const usesPreview = nodeStartUsesVitePreview(deployment.startCommand);
  const suggestsServe = /\bserve\s+-s\b/.test(suggested);
  if (!usesPreview || !suggestsServe) {
    return deployment;
  }

  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: { startCommand: suggested, processManager: detection.suggestions.processManager ?? "PM2" },
    include: deploymentWorkerInclude
  });

  await writeLog(deployment.id, releaseId, "PREFLIGHT", "Switched Node start command from Vite preview to static serve", {
    previousStartCommand: deployment.startCommand,
    startCommand: suggested
  }, "warn");

  return updated;
}

async function assertPublicRouteResult(result: unknown, label: string, deployment: { slug: string; domain?: { name: string } | null }, appPath?: string) {
  const value = result as { degraded?: boolean; httpCode?: number; stderr?: string };
  if (value?.degraded) {
    const runtimeText = await deploymentRuntimeLogTail(deployment, appPath);
    const base = value.stderr ?? `${label} returned HTTP ${value.httpCode ?? "error"}`;
    if (nginxUpstreamFailure(result, base)) {
      throw new Error(`${base}. Nginx cannot reach the deployment process on its configured upstream port.${runtimeText}`);
    }
    return `${base}${runtimeText}`;
  }

  const message = liveResultFailureMessage(result, label);
  if (!message) return null;

  const runtimeText = await deploymentRuntimeLogTail(deployment, appPath);
  const routeMeta = result as { effectiveUrl?: string; stdout?: string };
  const curlDiagnostic = stripAnsi(`${message}\n${routeMeta.stdout ?? ""}\n${routeMeta.effectiveUrl ?? ""}`);
  const localhostProxyMatch = curlDiagnostic.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i);
  const domainHint = localhostProxyMatch
    ? ` The app is healthy on localhost, but the public route resolved to an internal URL (${localhostProxyMatch[0]}). Fix the deployed app env/source so public URLs use ${deployment.domain?.name ? `https://${deployment.domain.name}` : "the domain"} instead of localhost.`
    : deployment.domain?.name
      ? ` The app is healthy on localhost, but the public domain returned an error. Check the Nginx vhost, SSL redirect, DNS A record, and upstream port.`
      : "";
  throw new Error(`${message}${domainHint}${runtimeText}`);
}

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function extractFirstPartyAssetPaths(html: string | undefined, domainName: string | null | undefined) {
  if (!html || !domainName) return [];
  const paths = new Set<string>();
  const assetPattern = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|otf)(?:[?#][^"'\s<>]*)?$/i;
  const attrPattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(html))) {
    const raw = match[1]?.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("data:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    let pathValue: string | null = null;
    if (raw.startsWith("//")) {
      try {
        const parsed = new URL(`https:${raw}`);
        if (parsed.hostname === domainName) pathValue = `${parsed.pathname}${parsed.search}`;
      } catch {
        pathValue = null;
      }
    } else if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        if (parsed.hostname === domainName) pathValue = `${parsed.pathname}${parsed.search}`;
      } catch {
        pathValue = null;
      }
    } else if (raw.startsWith("/")) {
      pathValue = raw;
    }
    if (!pathValue || !assetPattern.test(pathValue)) continue;
    paths.add(pathValue);
  }
  return [...paths].sort((a, b) => {
    const score = (value: string) => value.endsWith(".css") || value.includes(".css?") ? 0 : value.endsWith(".js") || value.includes(".js?") ? 1 : 2;
    return score(a) - score(b);
  }).slice(0, 16);
}

async function validatePublicStaticAssets(
  deploymentId: string,
  releaseId: string | undefined,
  label: string,
  deployment: { slug: string; framework: DeploymentFramework; domain?: BoundDomain | null },
  appPath: string,
  publicRoute: unknown,
  requireHttps: boolean
) {
  if (!(await deploymentRunsLaravel(deployment.framework, appPath))) return null;
  const domainName = deployment.domain?.name;
  const serverName = deploymentServerName(deployment.domain);
  if (!domainName || !serverName) return null;
  const html = (publicRoute as { stdout?: string })?.stdout ?? "";
  const assetPaths = extractFirstPartyAssetPaths(html, domainName);
  if (!assetPaths.length) return null;

  const missing: Array<{ path: string; httpCode?: number; detail: string }> = [];
  for (const assetPath of assetPaths) {
    const result = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `Static asset check ${assetPath}`, () =>
      sysagent.deploymentPublicRoute({
        serverName,
        path: assetPath,
        rootPath: appPath,
        framework: deployment.framework,
        requireHttps
      })
    );
    const failed = liveResultFailureMessage(result, `Static asset check ${assetPath}`)
      ?? ((result as { degraded?: boolean; stderr?: string }).degraded ? ((result as { stderr?: string }).stderr ?? "Asset returned HTTP error") : null);
    if (failed) {
      missing.push({
        path: assetPath,
        httpCode: (result as { httpCode?: number }).httpCode,
        detail: failed
      });
    }
  }

  if (!missing.length) return null;
  const preview = missing.slice(0, 8).map((item) => `${item.path}${item.httpCode ? ` (${item.httpCode})` : ""}`).join(", ");
  const warning = `Laravel public page loaded, but first-party static assets are missing through Nginx: ${preview}. Ensure these files exist under ${path.join(appPath, "public")} or fix the app asset paths/source repo, then redeploy.`;
  await writeLog(deploymentId, releaseId, "HEALTH_CHECK", `${label} static asset warning`, {
    missing,
    publicRoot: path.join(appPath, "public")
  }, "warn");
  return warning;
}

async function optionalPublicRouteWarning(
  deploymentId: string,
  releaseId: string | undefined,
  label: string,
  deployment: { id: string; slug: string; rootPath: string; publicDirectory?: string | null; framework: DeploymentFramework; port: number; startCommand: string | null; processManager: DeploymentProcessManager | null; domain?: BoundDomain | null; dbType?: "POSTGRESQL" | "MYSQL" | null; dbName?: string | null; dbUser?: string | null; dbPasswordSecretRef?: string | null },
  appPath: string,
  envVars: Record<string, string>,
  processManager: DeploymentProcessManager
) {
  const domain = deployment.domain;
  if (!domain) return null;

  if (await deploymentRunsLaravel(deployment.framework, appPath)) {
    if (!(await deploymentHasLaravelPublicIndex(appPath))) {
      const detectedLaravelAppRoot = await findDeploymentAppRoot(deployment.rootPath, ".", "LARAVEL");
      if (detectedLaravelAppRoot?.detection.detected === "LARAVEL" && detectedLaravelAppRoot.hasLaravelPublicIndex) {
        await writeLog(deploymentId, releaseId, "HEALTH_CHECK", "Laravel public root exists outside current app path", {
          domain: domain.name,
          appPath,
          detectedAppPath: detectedLaravelAppRoot.appPath,
          reason: "Current app path has no public/index.php, but a nested Laravel public web root exists. Redeploy/start will correct rootDirectory before health checks."
        }, "warn");
        throw new Error(`Laravel public web root exists at ${detectedLaravelAppRoot.appPath}, but deployment is running from ${appPath}. Redeploy or restart so Deployment Doctor can correct rootDirectory before Nginx health checks.`);
      }
      await writeLog(deploymentId, releaseId, "HEALTH_CHECK", "Skipped public website check for backend-only Laravel deployment", {
        domain: domain.name,
        appPath,
        reason: "No public/index.php exists, so this deployment is database/controller/storage only and should not be probed through Nginx."
      }, "warn");
      return null;
    }
    await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Prepare Laravel public route check", () =>
      sysagent.deploymentRepairLaravelWritablePaths({ rootPath: appPath })
    );
    if (await deploymentHttpsReady(domain)) {
      envVars = deploymentEnvWithPublicUrl(envVars, domain, true);
    }
    envVars = await ensureLaravelAppKey(deploymentId, releaseId, appPath, deployment.port, envVars);
    await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Guardian preflight repair", () =>
      runGuardianDeploymentRepair({ rootPath: appPath, framework: deployment.framework, envVars })
    ).then(async (repair) => {
      const repairedKey = (repair as { appKey?: string }).appKey;
      if (repairedKey) {
        envVars.APP_KEY = repairedKey;
        await upsertDeploymentEnvValue(deploymentId, "APP_KEY", repairedKey);
      }
      return repair;
    });
    await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Guardian preflight process restart", () =>
      restartDeploymentProcess({
        deploymentId,
        slug: deployment.slug,
        appPath,
        port: deployment.port,
        processManager,
        startCommand: renderStartCommand(deployment),
        envVars,
        logDir: deploymentLogDir(deployment.slug)
      })
    );
    await guardianRepairSleep(5000);
  }

  const httpsReady = await deploymentHttpsReady(domain);
  let publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", label, () =>
    sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: httpsReady })
  );

  try {
    let warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
    if (warning && isMysqlAccessDenied(warning)) {
      const repairedEnv = await autoRepairDatabaseAccess(deployment, releaseId, appPath, warning, envVars);
      if (repairedEnv) {
        envVars = repairedEnv;
        await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Restart after database credential repair", () =>
          restartDeploymentProcess({
            deploymentId,
            slug: deployment.slug,
            appPath,
            port: deployment.port,
            processManager,
            startCommand: renderStartCommand(deployment),
            envVars,
            logDir: deploymentLogDir(deployment.slug)
          })
        );
        await guardianRepairSleep(5000);
        publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after database credential repair`, () =>
          sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: httpsReady })
        );
        warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
      }
    }
    if (warning && isPhpRedisClassMissing(warning)) {
      const repairedEnv = await autoRepairLaravelRedis(deploymentId, releaseId, appPath, deployment.port, warning, envVars);
      if (repairedEnv) {
        envVars = repairedEnv;
        await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Restart after Redis driver repair", () =>
          restartDeploymentProcess({
            deploymentId,
            slug: deployment.slug,
            appPath,
            port: deployment.port,
            processManager,
            startCommand: renderStartCommand(deployment),
            envVars,
            logDir: deploymentLogDir(deployment.slug)
          })
        );
        await guardianRepairSleep(5000);
        publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after Redis repair`, () =>
          sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: httpsReady })
        );
        warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
      }
    }
    if (warning && isMissingLaravelPublicEntrypoint(warning)) {
      await autoRepairLaravelWritablePaths(deploymentId, releaseId, appPath, warning).catch(() => false);
      await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Restart after Laravel public/index.php repair", () =>
        restartDeploymentProcess({
          deploymentId,
          slug: deployment.slug,
          appPath,
          port: deployment.port,
          processManager,
          startCommand: renderStartCommand(deployment),
          envVars,
          logDir: deploymentLogDir(deployment.slug)
        })
      );
      await guardianRepairSleep(5000);
      publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after Laravel public/index.php repair`, () =>
        sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: httpsReady })
      );
      warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
    }
    if (warning && isPublicRouteHttp403(warning) && deployment.framework === "NODEJS" && nodeStartUsesVitePreview(deployment.startCommand)) {
      const current = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: deploymentWorkerInclude });
      const reconciled = await reconcileNodeProductionStartCommand(current, releaseId);
      Object.assign(deployment, { startCommand: reconciled.startCommand, processManager: reconciled.processManager });
      await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Restart after Node production start command fix", () =>
        restartDeploymentProcess({
          deploymentId,
          slug: deployment.slug,
          appPath,
          port: deployment.port,
          processManager,
          startCommand: renderStartCommand(deployment),
          envVars,
          logDir: deploymentLogDir(deployment.slug)
        })
      );
      await guardianRepairSleep(5000);
      warning = null;
    }
    if (warning && (isNginxStaticRootForbidden(warning) || isPublicRouteHttp403(warning))) {
      await republishDeploymentNginxVhost(deploymentId, releaseId, { ...deployment, rootPath: appPath }, domain);
      await guardianRepairSleep(2000);
      publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after nginx public route fix`, () =>
        sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: httpsReady })
      );
      warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
    }
    if (warning && isSslProtocolPublicRouteIssue(publicRoute, warning)) {
      const sslRepairWarning = await repairDeploymentSslAccess(deploymentId, releaseId, { ...deployment, rootPath: appPath }, domain);
      await guardianRepairSleep(2000);
      const retryHttpsReady = await deploymentHttpsReady(domain);
      publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after SSL/nginx repair`, () =>
        sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: retryHttpsReady })
      );
      warning = (await assertPublicRouteResult(publicRoute, label, deployment, appPath)) ?? sslRepairWarning;
    }
    if (warning && isMissingLaravelAppKeyWarning(warning)) {
      envVars = await ensureLaravelAppKey(deploymentId, releaseId, appPath, deployment.port, envVars);
      await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Restart after APP_KEY repair", () =>
        restartDeploymentProcess({
          deploymentId,
          slug: deployment.slug,
          appPath,
          port: deployment.port,
          processManager,
          startCommand: renderStartCommand(deployment),
          envVars,
          logDir: deploymentLogDir(deployment.slug)
        })
      );
      await guardianRepairSleep(5000);
      publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after APP_KEY repair`, () =>
        sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: httpsReady })
      );
      warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
    }
    const routeMeta = publicRoute as { effectiveUrl?: string };
    if (
      await deploymentRunsLaravel(deployment.framework, appPath)
      && httpsReady
      && routeMeta.effectiveUrl?.toLowerCase().startsWith(`http://${domain.name.toLowerCase()}`)
    ) {
      envVars = deploymentEnvWithPublicUrl(envVars, domain, true);
      envVars = await ensureLaravelAppKey(deploymentId, releaseId, appPath, deployment.port, envVars);
      await republishDeploymentNginxVhost(deploymentId, releaseId, { ...deployment, rootPath: appPath }, domain);
      await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Restart after HTTPS URL repair", () =>
        restartDeploymentProcess({
          deploymentId,
          slug: deployment.slug,
          appPath,
          port: deployment.port,
          processManager,
          startCommand: renderStartCommand(deployment),
          envVars,
          logDir: deploymentLogDir(deployment.slug)
        })
      );
      await guardianRepairSleep(5000);
      publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after HTTPS URL repair`, () =>
        sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: true })
      );
      warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
    }
    if (!warning) {
      const staticAssetWarning = await validatePublicStaticAssets(deploymentId, releaseId, label, deployment, appPath, publicRoute, await deploymentHttpsReady(domain));
      if (staticAssetWarning) return staticAssetWarning;
    }
    return warning;
  } catch (error) {
    const firstMessage = error instanceof Error ? error.message : "Public route check failed";
    await writeLog(deploymentId, releaseId, "HEALTH_CHECK", `${label} failed; running Guardian public-route repair`, { warning: firstMessage }, "warn");

    envVars = await ensureLaravelAppKey(deploymentId, releaseId, appPath, deployment.port, envVars);
    const repairedCharset = await autoRepairPostgresEncoding(deploymentId, releaseId, firstMessage, envVars).catch(() => null);
    if (repairedCharset) {
      envVars = repairedCharset;
      await ensureLaravelAppKey(deploymentId, releaseId, appPath, deployment.port, envVars);
    }
    if (isLaravelWritablePathIssue(firstMessage)) {
      await autoRepairLaravelWritablePaths(deploymentId, releaseId, appPath, firstMessage).catch(() => false);
    }
    const repairedDatabaseEnv = await autoRepairDatabaseAccess(deployment, releaseId, appPath, firstMessage, envVars).catch(() => null);
    if (repairedDatabaseEnv) {
      envVars = repairedDatabaseEnv;
    }
    const repairedRedis = await autoRepairLaravelRedis(deploymentId, releaseId, appPath, deployment.port, firstMessage, envVars).catch(() => null);
    if (repairedRedis) {
      envVars = repairedRedis;
    }

    if (nginxUpstreamFailure(publicRoute, firstMessage)) {
      await republishDeploymentNginxVhost(deploymentId, releaseId, { ...deployment, rootPath: appPath }, domain);
    }
    await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Guardian public-route repair", () =>
      runGuardianDeploymentRepair({ rootPath: appPath, framework: deployment.framework, envVars })
    );
    await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Guardian public-route process restart", () =>
      restartDeploymentProcess({
        deploymentId,
        slug: deployment.slug,
        appPath,
        port: deployment.port,
        processManager,
        startCommand: renderStartCommand(deployment),
        envVars,
        logDir: deploymentLogDir(deployment.slug)
      })
    );
    await guardianRepairSleep(5000);
    const retryHttpsReady = await deploymentHttpsReady(domain);
    publicRoute = await runStep(deploymentId, releaseId, "HEALTH_CHECK", `${label} retry after Guardian repair`, () =>
      sysagent.deploymentPublicRoute({ serverName: deploymentServerName(domain), rootPath: appPath, framework: deployment.framework, requireHttps: retryHttpsReady })
    );
  }

  try {
    const warning = await assertPublicRouteResult(publicRoute, label, deployment, appPath);
    if (!warning) {
      await writeLog(deploymentId, releaseId, "HEALTH_CHECK", `${label} recovered after Guardian repair`);
      const staticAssetWarning = await validatePublicStaticAssets(deploymentId, releaseId, label, deployment, appPath, publicRoute, await deploymentHttpsReady(domain));
      if (staticAssetWarning) return staticAssetWarning;
    }
    return warning;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Public route check failed";
    await writeLog(deploymentId, releaseId, "HEALTH_CHECK", `${label} warning`, { warning: message }, "warn");
    if (nginxUpstreamFailure(publicRoute, message)) {
      throw new Error(`${message}\n\nGuardian rewrote the Nginx vhost and restarted the deployment process, but the upstream still returns 502/503/504.`);
    }
    return message;
  }
}

function githubTokenSecretRef() {
  return "github:superadmin:token";
}

function accountGithubTokenSecretRef(accountId: string) {
  return `github:account:${accountId}:token`;
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
  const autoInstallFailures: Array<{ tool: string; error: string }> = [];

  for (const target of approvalTargets) {
    try {
      const installResult = await runStep(deploymentId, releaseId, "PREFLIGHT", `Auto-install ${target.tool}`, () =>
        sysagent.deploymentInstallRuntimeTool({ tool: target.tool })
      );
      assertLiveResult(installResult, `Auto-install ${target.tool}`);
      autoInstalled.push(target.tool);
    } catch (error) {
      autoInstallFailures.push({ tool: target.tool, error: error instanceof Error ? error.message : String(error) });
      await writeLog(deploymentId, releaseId, "PREFLIGHT", `Auto-install ${target.tool} failed; Doctor approval will be queued`, {
        actionKey: target.actionKey,
        error: error instanceof Error ? error.message : String(error)
      }, "warn");
    }
  }

  if (autoInstalled.length > 0 || autoInstallFailures.length > 0) {
    toolsResult = await inspectTools();
    missing = toolsResult.items.filter((tool) => !tool.installed).map((tool) => tool.name);
    if (missing.length === 0) {
      await writeLog(deploymentId, releaseId, "PREFLIGHT", "Runtime tools auto-installed", { tools: autoInstalled });
      return;
    }
  }

  const remainingApprovalTargets = runtimeInstallTargetsForMissingExecutables(missing);
  for (const target of remainingApprovalTargets) {
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
    `Missing runtime tools on the server: ${missing.join(", ")}. Auto-install could not finish everything. Pending repair approvals were created for installable tools. Open Deployment Doctor, approve the remaining installs, then redeploy.${autoInstallFailures.length ? ` Auto-install failures: ${autoInstallFailures.map((item) => `${item.tool}: ${item.error}`).join("; ")}` : ""}`
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

async function upsertDeploymentEnvValue(deploymentId: string, key: string, value: string) {
  return prisma.deploymentEnvVar.upsert({
    where: { deploymentId_key: { deploymentId, key } },
    update: { value, isSecret: false, secretRef: null },
    create: { deploymentId, key, value, isSecret: false, secretRef: null }
  });
}

async function stripStaleDatabaseEnvFromPanel(deploymentId: string) {
  for (const key of ["DB_PASSWORD", "DATABASE_URL"] as const) {
    const row = await prisma.deploymentEnvVar.findUnique({
      where: { deploymentId_key: { deploymentId, key } },
      select: { value: true, secretRef: true }
    });
    if (!row) continue;
    if (key === "DB_PASSWORD" && row.secretRef) continue;
    if (row.value !== null || key === "DATABASE_URL") {
      await deleteDeploymentEnvValue(deploymentId, key);
    }
  }
}

type DatabaseProvisionResponse = {
  password?: string;
  result?: {
    verifyLocal?: { returncode?: number };
    verifyTcp?: { returncode?: number };
  };
};

async function deleteDeploymentEnvValue(deploymentId: string, key: string) {
  const existing = await prisma.deploymentEnvVar.findUnique({
    where: { deploymentId_key: { deploymentId, key } },
    select: { secretRef: true }
  });
  if (existing?.secretRef) {
    await deleteSecret(existing.secretRef);
  }
  await prisma.deploymentEnvVar.delete({ where: { deploymentId_key: { deploymentId, key } } }).catch(() => undefined);
}

async function normalizeSelectedDatabaseEngineEnv(
  deployment: { id: string; dbType?: "POSTGRESQL" | "MYSQL" | null },
  envVars: Record<string, string>
) {
  if (!deployment.dbType) return { envVars, changed: false };

  const nextEnv = { ...envVars };
  let changed = false;
  const desiredConnection = deployment.dbType === "MYSQL" ? "mysql" : "pgsql";
  const oppositeUrlPrefixes = deployment.dbType === "MYSQL" ? ["postgres://", "postgresql://"] : ["mysql://", "mariadb://"];

  if ((nextEnv.DB_CONNECTION || "").toLowerCase() !== desiredConnection) {
    nextEnv.DB_CONNECTION = desiredConnection;
    await upsertDeploymentEnvValue(deployment.id, "DB_CONNECTION", desiredConnection);
    changed = true;
  }

  const databaseUrl = nextEnv.DATABASE_URL || "";
  if (oppositeUrlPrefixes.some((prefix) => databaseUrl.startsWith(prefix))) {
    delete nextEnv.DATABASE_URL;
    await deleteDeploymentEnvValue(deployment.id, "DATABASE_URL");
    changed = true;
  }

  if (deployment.dbType === "MYSQL") {
    if (!nextEnv.DB_PORT || nextEnv.DB_PORT === "5432") {
      nextEnv.DB_PORT = "3306";
      await upsertDeploymentEnvValue(deployment.id, "DB_PORT", "3306");
      changed = true;
    }
    if ((nextEnv.DB_CHARSET || "").toLowerCase() === "utf8") {
      nextEnv.DB_CHARSET = "utf8mb4";
      await upsertDeploymentEnvValue(deployment.id, "DB_CHARSET", "utf8mb4");
      changed = true;
    }
    if ((nextEnv.DB_COLLATION || "") === "") {
      nextEnv.DB_COLLATION = "utf8mb4_unicode_ci";
      await upsertDeploymentEnvValue(deployment.id, "DB_COLLATION", "utf8mb4_unicode_ci");
      changed = true;
    }
    return { envVars: nextEnv, changed };
  }

  if (!nextEnv.DB_PORT || nextEnv.DB_PORT === "3306") {
    nextEnv.DB_PORT = "5432";
    await upsertDeploymentEnvValue(deployment.id, "DB_PORT", "5432");
    changed = true;
  }
  if ((nextEnv.DB_CHARSET || "").toLowerCase() !== "utf8") {
    nextEnv.DB_CHARSET = "utf8";
    await upsertDeploymentEnvValue(deployment.id, "DB_CHARSET", "utf8");
    changed = true;
  }
  if ((nextEnv.DB_COLLATION || "") !== "") {
    nextEnv.DB_COLLATION = "";
    await upsertDeploymentEnvValue(deployment.id, "DB_COLLATION", "");
    changed = true;
  }
  return { envVars: nextEnv, changed };
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

async function ensureComposerPlatformCompatible(
  deploymentId: string,
  releaseId: string | undefined,
  appPath: string,
  envVars: Record<string, string>
) {
  const verify = () =>
    runStep(deploymentId, releaseId, "PREFLIGHT", "Composer platform requirements check", () =>
      sysagent.deploymentBuild({
        rootPath: appPath,
        command: "composer check-platform-reqs --no-interaction",
        env: envVars
      })
    );

  let result = await verify();
  try {
    assertCommandTree(result, "Composer platform requirements check");
    return;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let repairFailure: string | null = null;
    const repaired = await autoRepairComposerPlatformIssue(deploymentId, releaseId, detail).catch((repairError) => {
      repairFailure = repairError instanceof Error ? repairError.message : String(repairError);
      return false;
    });
    if (!repaired) {
      if (isComposerPlatformCheckInconclusive(detail)) {
        await writeLog(deploymentId, releaseId, "PREFLIGHT", "Composer platform check was inconclusive before vendor install; continuing to dependency install", {
          evidence: detail.slice(0, 4000)
        }, "warn");
        return;
      }
      if (repairFailure) {
        throw new Error(`${detail}\n\nComposer platform auto-repair failed: ${repairFailure}`);
      }
      throw error;
    }

    result = await verify();
    assertCommandTree(result, "Composer platform requirements check retry");
  }
}

async function ensureComposerDeclaredPlatformExtensions(deploymentId: string, releaseId: string | undefined, appPath: string) {
  const composerJsonPath = path.join(appPath, "composer.json");
  let composerJson: unknown;
  try {
    composerJson = JSON.parse(await fs.readFile(composerJsonPath, "utf8"));
  } catch {
    return false;
  }

  const manifest = composerJson as {
    require?: Record<string, unknown>;
    "require-dev"?: Record<string, unknown>;
  };
  const requiredKeys = new Set([
    ...Object.keys(manifest.require ?? {}),
    ...Object.keys(manifest["require-dev"] ?? {})
  ].map((key) => key.toLowerCase()));

  const targets = [];
  if (requiredKeys.has("ext-soap")) targets.push({ tool: "php-soap" as const, label: "PHP SOAP extension" });
  if (requiredKeys.has("ext-gd")) targets.push({ tool: "php-gd" as const, label: "PHP GD extension" });
  if (targets.length === 0) return false;

  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Composer declared PHP extensions detected", {
    composerJsonPath,
    tools: targets.map((target) => target.tool)
  }, "warn");

  const installed: string[] = [];
  for (const target of targets) {
    const result = await runStep(deploymentId, releaseId, "PREFLIGHT", `Pre-install ${target.label}`, () =>
      sysagent.deploymentInstallRuntimeTool({ tool: target.tool })
    );
    assertLiveResult(result, `Pre-install ${target.label}`);
    installed.push(target.tool);
  }

  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Composer PHP extension preflight completed", { tools: installed });
  return installed.length > 0;
}

function isLaravelWritablePathIssue(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("please provide a valid cache path")
    || lower.includes("bootstrap/cache")
    || lower.includes("storage/framework")
    || isMissingLaravelPublicEntrypoint(text)
    || lower.includes("laravel package discovery failed");
}

function isMissingLaravelPublicEntrypoint(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("public/index.php")
    || /provided cwd\s+["'][^"']+\/public["']\s+does not exist/i.test(text);
}

function isPhpRedisClassMissing(text: string) {
  return /class\s+["']redis["']\s+not\s+found/i.test(text);
}

function isMysqlAccessDenied(text: string) {
  const lower = text.toLowerCase();
  return (lower.includes("sqlstate[hy000] [1045]") || lower.includes("access denied for user"))
    && lower.includes("using password");
}

async function autoRepairDatabaseAccess(
  deployment: DeploymentDatabaseRuntime,
  releaseId: string | undefined,
  appPath: string,
  errorText: string,
  envVars: Record<string, string>
) {
  if (!isMysqlAccessDenied(errorText)) return null;
  if (!deployment.dbType || !deployment.dbName || !deployment.dbUser) return null;

  await writeLog(deployment.id, releaseId, "PREFLIGHT", "Database access denied detected; repairing deployment credentials", {
    dbType: deployment.dbType,
    dbName: deployment.dbName,
    dbUser: deployment.dbUser,
    evidence: errorText.slice(0, 4000)
  }, "warn");

  const repaired = await buildDatabaseRuntimeEnv(deployment, envVars, { forcePasswordRotate: true, releaseId });
  const nextEnv = repaired.envVars;
  await ensureLaravelAppKey(deployment.id, releaseId, appPath, deployment.port, nextEnv);
  return nextEnv;
}

function databaseConnectionDiagnostics(envVars: Record<string, string>) {
  const databaseUrl = envVars.DATABASE_URL || "";
  let databaseUrlSummary: string | null = null;
  if (databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      databaseUrlSummary = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}`;
    } catch {
      databaseUrlSummary = "present but invalid URL";
    }
  }
  return {
    DB_CONNECTION: envVars.DB_CONNECTION ?? null,
    DB_HOST: envVars.DB_HOST ?? null,
    DB_PORT: envVars.DB_PORT ?? null,
    DB_DATABASE: envVars.DB_DATABASE ?? null,
    DB_USERNAME: envVars.DB_USERNAME ?? null,
    hasDbPassword: Boolean(envVars.DB_PASSWORD),
    DATABASE_URL: databaseUrlSummary
  };
}

function laravelDatabaseVerifyCommand() {
  return `php -r 'require "vendor/autoload.php"; $app = require "bootstrap/app.php"; $kernel = $app->make(Illuminate\\Contracts\\Console\\Kernel::class); $kernel->bootstrap(); $app["db"]->connection()->getPdo(); echo "database-ok\\n";'`;
}

async function ensureLaravelDatabaseConnection(
  deployment: DeploymentDatabaseRuntime,
  releaseId: string | undefined,
  appPath: string,
  port: number,
  envVars: Record<string, string>
) {
  if (!deployment.dbType || !deployment.dbName || !deployment.dbUser) return envVars;

  await runStep(deployment.id, releaseId, "PREFLIGHT", "Prepare Laravel writable paths before database check", () =>
    sysagent.deploymentRepairLaravelWritablePaths({ rootPath: appPath })
  ).catch((error) =>
    writeLog(deployment.id, releaseId, "PREFLIGHT", "Laravel writable path preflight warning", {
      warning: error instanceof Error ? error.message : String(error),
      rootPath: appPath
    }, "warn")
  );

  const clearConfig = await runStep(deployment.id, releaseId, "PREFLIGHT", "Clear Laravel config cache before database check", () =>
    sysagent.deploymentBuild({
      rootPath: appPath,
      command: "php artisan config:clear",
      env: envVars
    })
  );
  try {
    assertCommandTree(clearConfig, "Clear Laravel config cache before database check");
  } catch (error) {
    await writeLog(deployment.id, releaseId, "PREFLIGHT", "Laravel config cache clear warning", {
      warning: error instanceof Error ? error.message : String(error),
      result: JSON.parse(JSON.stringify(clearConfig ?? null))
    }, "warn");
  }

  const verify = () =>
    runStep(deployment.id, releaseId, "PREFLIGHT", "Verify Laravel database connection", () =>
      sysagent.deploymentBuild({
        rootPath: appPath,
        command: laravelDatabaseVerifyCommand(),
        env: envVars
      })
    );

  let result = await verify();
  try {
    assertCommandTree(result, "Laravel database connection");
    return envVars;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLog(deployment.id, releaseId, "PREFLIGHT", "Laravel database connection diagnostic", {
      error: message,
      selectedDatabase: {
        dbType: deployment.dbType,
        dbName: deployment.dbName,
        dbUser: deployment.dbUser
      },
      env: databaseConnectionDiagnostics(envVars),
      result: JSON.parse(JSON.stringify(result ?? null))
    }, "error");
    const repairedWritablePaths = await autoRepairLaravelWritablePaths(deployment.id, releaseId, appPath, message).catch(() => false);
    if (repairedWritablePaths) {
      result = await verify();
      assertCommandTree(result, "Laravel database connection");
      return envVars;
    }
    if (!isMysqlAccessDenied(message)) throw error;
    await writeLog(deployment.id, releaseId, "PREFLIGHT", "Laravel database connection failed; repairing credentials", {
      evidence: message.slice(0, 4000)
    }, "warn");
    const repaired = await buildDatabaseRuntimeEnv(deployment, envVars, { forcePasswordRotate: true, releaseId });
    const nextEnv = await ensureLaravelAppKey(deployment.id, releaseId, appPath, port, repaired.envVars);
    result = await runStep(deployment.id, releaseId, "PREFLIGHT", "Verify Laravel database connection retry", () =>
      sysagent.deploymentBuild({
        rootPath: appPath,
        command: laravelDatabaseVerifyCommand(),
        env: nextEnv
      })
    );
    assertCommandTree(result, "Laravel database connection");
    return nextEnv;
  }
}

async function autoRepairLaravelRedis(
  deploymentId: string,
  releaseId: string | undefined,
  appPath: string,
  port: number,
  errorText: string,
  envVars: Record<string, string>
) {
  if (!isPhpRedisClassMissing(errorText)) return null;

  await writeLog(deploymentId, releaseId, "HEALTH_CHECK", "PHP Redis extension missing for Laravel", {
    evidence: errorText.slice(0, 2000)
  }, "warn");

  try {
    await runStep(deploymentId, releaseId, "HEALTH_CHECK", "Install PHP Redis extension", () =>
      sysagent.deploymentInstallRuntimeTool({ tool: "php-redis" })
    );
  } catch (error) {
    await writeLog(deploymentId, releaseId, "HEALTH_CHECK", "PHP Redis extension install skipped", {
      warning: error instanceof Error ? error.message : String(error)
    }, "warn");
  }

  const fallbackDrivers: Record<string, string> = {
    CACHE_DRIVER: "file",
    CACHE_STORE: "file",
    SESSION_DRIVER: "file",
    QUEUE_CONNECTION: "sync",
    BROADCAST_DRIVER: "log"
  };
  for (const [key, value] of Object.entries(fallbackDrivers)) {
    if ((envVars[key] || "").toLowerCase() === "redis" || (envVars[key] || "").toLowerCase() === "phpredis") {
      envVars[key] = value;
      await upsertDeploymentEnvValue(deploymentId, key, value);
    }
  }

  return ensureLaravelAppKey(deploymentId, releaseId, appPath, port, envVars);
}

async function applyLaravelAppKeyFromSync(
  deploymentId: string,
  envVars: Record<string, string>,
  syncResult: unknown
) {
  const appKey = (syncResult as { appKey?: string }).appKey;
  if (appKey && appKey !== envVars.APP_KEY) {
    envVars.APP_KEY = appKey;
    await upsertDeploymentEnvValue(deploymentId, "APP_KEY", appKey);
  }
  return envVars;
}

async function reconcileMissingStartCommand(
  deployment: DeploymentWithWorkerRelations,
  releaseId: string | undefined
) {
  if (deployment.framework === "STATIC" || deployment.startCommand?.trim()) {
    return deployment;
  }

  const detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
  const startCommand = detection.suggestions.startCommand;
  if (!startCommand) {
    return deployment;
  }

  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      framework: detection.detected,
      runtime: detection.suggestions.runtime,
      packageManager: detection.suggestions.packageManager,
      installCommand: detection.suggestions.installCommand,
      buildCommand: detection.suggestions.buildCommand,
      startCommand,
      outputDirectory: detection.suggestions.outputDirectory,
      processManager: detection.suggestions.processManager ?? "PM2"
    },
    include: deploymentWorkerInclude
  });

  await writeLog(deployment.id, releaseId, "PREFLIGHT", "Applied detected start command", {
    framework: detection.detected,
    startCommand,
    processManager: updated.processManager
  });

  return updated;
}

async function reconcileMisdetectedLaravelFramework(
  deployment: DeploymentWithWorkerRelations,
  releaseId: string | undefined,
  appPath: string
) {
  if (await deploymentHasLaravelArtisan(appPath)) {
    return deployment;
  }

  if (deployment.framework !== "LARAVEL") {
    return deployment;
  }

  let detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
  if (detection.detected === "LARAVEL") {
    const sourceRoot = path.resolve(deployment.rootPath, deployment.rootDirectory || ".");
    const files = await fs.readdir(sourceRoot);
    const packageJson = await fs.readFile(path.join(sourceRoot, "package.json"), "utf8").catch(() => null);
    detection = detectDeploymentFiles(files, packageJson, null);
  }
  const updated = await prisma.deployment.update({
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

  await writeLog(deployment.id, releaseId, "PREFLIGHT", "Corrected misdetected Laravel framework", {
    previousFramework: "LARAVEL",
    detected: detection.detected,
    reason: detection.reason
  }, "warn");

  return updated;
}

async function reconcileDeploymentRootDirectory(
  deployment: DeploymentWithWorkerRelations,
  releaseId: string | undefined,
  appPath: string
) {
  const detected = await findDeploymentAppRoot(deployment.rootPath, deployment.rootDirectory, deployment.framework);
  if (!detected) {
    return { deployment, appPath };
  }

  const rootPath = path.resolve(deployment.rootPath);
  const detectedAppPath = path.resolve(detected.appPath);
  const currentAppPath = path.resolve(appPath);
  if (detectedAppPath === currentAppPath) {
    return { deployment, appPath };
  }

  const relativeRootDirectory = path.relative(rootPath, detectedAppPath);
  if (!relativeRootDirectory || relativeRootDirectory.startsWith("..") || path.isAbsolute(relativeRootDirectory)) {
    return { deployment, appPath };
  }

  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      rootDirectory: relativeRootDirectory,
      publicDirectory: detected.detection.detected === "LARAVEL" ? deployment.publicDirectory || "public" : deployment.publicDirectory
    },
    include: deploymentWorkerInclude
  });

  await writeLog(deployment.id, releaseId, "PREFLIGHT", "Corrected nested deployment app root directory", {
    framework: detected.detection.detected,
    previousRootDirectory: deployment.rootDirectory,
    previousAppPath: appPath,
    appPath: detectedAppPath,
    rootDirectory: updated.rootDirectory,
    reason: detected.detection.reason
  }, "warn");

  return { deployment: updated, appPath: detectedAppPath };
}

async function reconcileLaravelRootDirectory(
  deployment: DeploymentWithWorkerRelations,
  releaseId: string | undefined,
  appPath: string
) {
  if (deployment.framework !== "LARAVEL") {
    return { deployment, appPath };
  }
  if (await deploymentHasLaravelArtisan(appPath) && await deploymentHasLaravelPublicIndex(appPath)) {
    return { deployment, appPath };
  }

  const detectedLaravelAppRoot = await findLaravelAppRoot(deployment.rootPath, deployment.rootDirectory);
  const rootPath = path.resolve(deployment.rootPath);
  const parentPath = path.dirname(rootPath);
  const appParentPath = path.dirname(path.resolve(appPath));
  if (path.basename(path.resolve(appPath)).toLowerCase() === "public" && await deploymentHasLaravelArtisan(appParentPath)) {
    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: { rootPath: appParentPath, rootDirectory: ".", publicDirectory: deployment.publicDirectory || "public" },
      include: deploymentWorkerInclude
    });

    await writeLog(deployment.id, releaseId, "PREFLIGHT", "Corrected Laravel deployment root from public directory", {
      previousRootPath: deployment.rootPath,
      previousRootDirectory: deployment.rootDirectory,
      appPath,
      rootPath: appParentPath,
      publicDirectory: updated.publicDirectory
    }, "warn");

    return { deployment: updated, appPath: appParentPath };
  }
  if (path.basename(rootPath).toLowerCase() === "public" && await deploymentHasLaravelArtisan(parentPath)) {
    const updated = await prisma.deployment.update({
      where: { id: deployment.id },
      data: { rootPath: parentPath, rootDirectory: ".", publicDirectory: deployment.publicDirectory || "public" },
      include: deploymentWorkerInclude
    });

    await writeLog(deployment.id, releaseId, "PREFLIGHT", "Corrected Laravel deployment root from public directory", {
      previousRootPath: deployment.rootPath,
      previousRootDirectory: deployment.rootDirectory,
      appPath,
      rootPath: parentPath,
      publicDirectory: updated.publicDirectory
    }, "warn");

    return { deployment: updated, appPath: parentPath };
  }
  if (detectedLaravelAppRoot) {
    const relativeRootDirectory = path.relative(rootPath, detectedLaravelAppRoot);
    if (relativeRootDirectory && !relativeRootDirectory.startsWith("..") && !path.isAbsolute(relativeRootDirectory)) {
      const updated = await prisma.deployment.update({
        where: { id: deployment.id },
        data: { rootDirectory: relativeRootDirectory, publicDirectory: deployment.publicDirectory || "public" },
        include: deploymentWorkerInclude
      });

      await writeLog(deployment.id, releaseId, "PREFLIGHT", "Corrected nested Laravel app root directory", {
        previousRootDirectory: deployment.rootDirectory,
        previousAppPath: appPath,
        appPath: detectedLaravelAppRoot,
        rootDirectory: updated.rootDirectory,
        publicDirectory: updated.publicDirectory
      }, "warn");

      return { deployment: updated, appPath: detectedLaravelAppRoot };
    }
  }
  if (!(await deploymentHasLaravelArtisan(deployment.rootPath))) {
    return { deployment, appPath };
  }

  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: { rootDirectory: ".", publicDirectory: deployment.publicDirectory || "public" },
    include: deploymentWorkerInclude
  });

  await writeLog(deployment.id, releaseId, "PREFLIGHT", "Corrected Laravel app root directory", {
    previousRootDirectory: deployment.rootDirectory,
    previousAppPath: appPath,
    appPath: deployment.rootPath,
    publicDirectory: updated.publicDirectory
  }, "warn");

  return { deployment: updated, appPath: deployment.rootPath };
}

async function ensureLaravelAppKey(
  deploymentId: string,
  releaseId: string | undefined,
  appPath: string,
  port: number,
  envVars: Record<string, string>
) {
  if (!(await deploymentHasLaravelArtisan(appPath))) {
    await writeLog(deploymentId, releaseId, "PREFLIGHT", "Skipped Laravel .env sync (no artisan file)", { appPath }, "warn");
    return envVars;
  }

  const syncResult = await runStep(deploymentId, releaseId, "PREFLIGHT", "Sync Laravel .env", () =>
    sysagent.deploymentSyncLaravelEnv({
      rootPath: appPath,
      port,
      env: envVars
    })
  );
  assertCommandTree(syncResult, "Sync Laravel .env");
  return applyLaravelAppKeyFromSync(deploymentId, envVars, syncResult);
}

async function prepareLaravelForStart(
  deploymentId: string,
  releaseId: string | undefined,
  appPath: string,
  port: number,
  envVars: Record<string, string>
) {
  await runStep(deploymentId, releaseId, "BUILDING", "Prepare Laravel runtime paths", () =>
    sysagent.deploymentRepairLaravelWritablePaths({ rootPath: appPath })
  );

  await runStep(deploymentId, releaseId, "BUILDING", "Clear Laravel config cache", () =>
    sysagent.deploymentBuild({
      rootPath: appPath,
      command: "php artisan config:clear",
      env: envVars
    })
  );

  await runStep(deploymentId, releaseId, "BUILDING", "Link Laravel public storage", () =>
    sysagent.deploymentBuild({
      rootPath: appPath,
      command: "php artisan storage:link",
      env: envVars
    })
  ).catch(() => undefined);
}

async function autoRepairLaravelWritablePaths(deploymentId: string, releaseId: string | undefined, appPath: string, errorText: string) {
  if (!isLaravelWritablePathIssue(errorText)) return false;
  await writeLog(deploymentId, releaseId, "PREFLIGHT", "Laravel writable path issue detected", {
    rootPath: appPath,
    evidence: errorText.slice(0, 4000)
  }, "warn");
  const repairResult = await runStep(deploymentId, releaseId, "PREFLIGHT", "Repair Laravel writable paths", () =>
    sysagent.deploymentRepairLaravelWritablePaths({ rootPath: appPath })
  );
  assertLiveResult(repairResult, "Repair Laravel writable paths");
  return true;
}

function isPostgresEncodingMismatch(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("client_encoding")
    && lower.includes("utf8mb4")
    && (lower.includes("postgres") || lower.includes("pgsql") || lower.includes("postgresconnector"));
}

async function autoRepairPostgresEncoding(deploymentId: string, releaseId: string | undefined, errorText: string, envVars: Record<string, string>) {
  if (!isPostgresEncodingMismatch(errorText)) return null;

  await writeLog(deploymentId, releaseId, "PREFLIGHT", "PostgreSQL charset mismatch detected", {
    evidence: errorText.slice(0, 4000),
    previousCharset: envVars.DB_CHARSET ?? null,
    previousCollation: envVars.DB_COLLATION ?? null
  }, "warn");

  const normalized = await normalizePostgresRuntimeEnv(deploymentId, envVars, true);
  return normalized.envVars;
}

async function shouldRunDatabaseMigration(
  deployment: { id: string; dbType?: "POSTGRESQL" | "MYSQL" | null; dbName?: string | null },
  releaseId: string | undefined,
  envVars: Record<string, string>
) {
  const explicitSkip = ["1", "true", "yes"].includes((envVars.SKIP_DATABASE_MIGRATIONS || envVars.SKIP_DB_MIGRATIONS || "").toLowerCase());
  if (explicitSkip) {
    await writeLog(deployment.id, releaseId, "MIGRATING", "Migration skipped by env flag", {
      SKIP_DATABASE_MIGRATIONS: envVars.SKIP_DATABASE_MIGRATIONS ?? null,
      SKIP_DB_MIGRATIONS: envVars.SKIP_DB_MIGRATIONS ?? null
    });
    return false;
  }

  const explicitRun = ["1", "true", "yes"].includes((envVars.RUN_DATABASE_MIGRATIONS || envVars.RUN_DB_MIGRATIONS || "").toLowerCase());
  if (explicitRun) return true;

  if (!deployment.dbType || !deployment.dbName) return true;

  try {
    const tables = await sysagent.databaseTables({
      engine: deployment.dbType,
      database: deployment.dbName
    }) as { tables?: string[]; result?: unknown };
    const tableCount = tables.tables?.length ?? 0;
    if (tableCount > 0) {
      await writeLog(deployment.id, releaseId, "MIGRATING", "Migration skipped for existing selected database", {
        dbType: deployment.dbType,
        dbName: deployment.dbName,
        tableCount,
        reason: "Selected database already has tables. Add RUN_DATABASE_MIGRATIONS=true to force migrations."
      });
      return false;
    }
  } catch (error) {
    await writeLog(deployment.id, releaseId, "MIGRATING", "Could not inspect selected database before migration", {
      dbType: deployment.dbType ?? null,
      dbName: deployment.dbName ?? null,
      warning: error instanceof Error ? error.message : String(error)
    }, "warn");
  }

  return true;
}

async function githubCloneToken(sourceProvider: string, gitUrl: string | null, accountId?: string | null) {
  if (sourceProvider !== "GITHUB" || !gitUrl?.startsWith("https://github.com/")) return null;
  if (accountId) {
    const accountToken = await getSecret(accountGithubTokenSecretRef(accountId));
    if (accountToken) return accountToken;
  }
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

async function buildDatabaseRuntimeEnv(
  deployment: { id: string; dbType?: "POSTGRESQL" | "MYSQL" | null; dbName?: string | null; dbUser?: string | null; dbPasswordSecretRef?: string | null },
  envVars: Record<string, string>,
  options?: { forcePasswordRotate?: boolean; releaseId?: string }
) {
  const selectedEngine = await normalizeSelectedDatabaseEngineEnv(deployment, envVars);
  const nextEnv = { ...selectedEngine.envVars };
  let changed = selectedEngine.changed;

  if (!deployment.dbType || !deployment.dbName || !deployment.dbUser) return { envVars: nextEnv, changed };

  await stripStaleDatabaseEnvFromPanel(deployment.id);
  delete nextEnv.DB_PASSWORD;
  delete nextEnv.DATABASE_URL;
  changed = true;

  const secretRef = deployment.dbPasswordSecretRef ?? `deployment:${deployment.id}:database-password`;
  let password = options?.forcePasswordRotate ? null : await getSecret(secretRef);
  const protectedUsers = new Set(["root", "mysql", "mariadb.sys", "postgres"]);
  if (!protectedUsers.has(deployment.dbUser)) {
    let provision = (await sysagent.provisionDatabase({
      engine: deployment.dbType,
      database: deployment.dbName,
      username: deployment.dbUser,
      password: password ?? undefined
    })) as DatabaseProvisionResponse;
    assertCommandTree(provision.result, "Database provision/grant");

    const verifyOk =
      provision.result?.verifyLocal?.returncode === 0 || provision.result?.verifyTcp?.returncode === 0;
    if (!verifyOk) {
      await writeLog(deployment.id, options?.releaseId, "PREFLIGHT", "Database credential verify failed; rotating password", {
        dbUser: deployment.dbUser,
        dbName: deployment.dbName
      }, "warn");
      const rotated = (await sysagent.databasePassword({
        engine: deployment.dbType,
        username: deployment.dbUser
      })) as { password?: string };
      password = rotated.password ?? null;
      provision = (await sysagent.provisionDatabase({
        engine: deployment.dbType,
        database: deployment.dbName,
        username: deployment.dbUser,
        password: password ?? undefined
      })) as DatabaseProvisionResponse;
      assertCommandTree(provision.result, "Database reprovision after password rotate");
    }

    if (provision.password) {
      password = provision.password;
    }
    if (password) {
      await putSecret({
        ref: secretRef,
        value: password,
        kind: "DATABASE_PASSWORD",
        label: `${deployment.dbUser}@${deployment.dbName}`,
        metadata: { deploymentId: deployment.id, engine: deployment.dbType, database: deployment.dbName, username: deployment.dbUser }
      });
      if (deployment.dbPasswordSecretRef !== secretRef) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { dbPasswordSecretRef: secretRef }
        });
      }
    }
  }
  if (deployment.dbType === "MYSQL") {
    const host = nextEnv.DB_HOST || "localhost";
    const port = nextEnv.DB_PORT || "3306";
    const desiredUrl = password !== null
      ? `mysql://${encodeURIComponent(deployment.dbUser)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(deployment.dbName)}`
      : null;
    const updates: Record<string, string> = {
      DB_CONNECTION: "mysql",
      DB_HOST: host,
      DB_PORT: port,
      DB_DATABASE: deployment.dbName,
      DB_USERNAME: deployment.dbUser,
      DB_CHARSET: "utf8mb4",
      DB_COLLATION: "utf8mb4_unicode_ci"
    };
    for (const [key, value] of Object.entries(updates)) {
      if (nextEnv[key] !== value) {
        nextEnv[key] = value;
        changed = true;
      }
    }
    if (desiredUrl && nextEnv.DATABASE_URL !== desiredUrl) {
      nextEnv.DATABASE_URL = desiredUrl;
      changed = true;
    }
    if (password !== null && nextEnv.DB_PASSWORD !== password) {
      nextEnv.DB_PASSWORD = password;
      changed = true;
    }
    return { envVars: nextEnv, changed };
  }

  const host = nextEnv.DB_HOST || "127.0.0.1";
  const port = nextEnv.DB_PORT || "5432";
  const desiredUrl = password !== null
    ? `postgresql://${encodeURIComponent(deployment.dbUser)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(deployment.dbName)}`
    : null;
  const updates: Record<string, string> = {
    DB_CONNECTION: "pgsql",
    DB_HOST: host,
    DB_PORT: port,
    DB_DATABASE: deployment.dbName,
    DB_USERNAME: deployment.dbUser,
    DB_CHARSET: "utf8"
  };
  for (const [key, value] of Object.entries(updates)) {
    if (nextEnv[key] !== value) {
      nextEnv[key] = value;
      changed = true;
    }
  }
  if ((nextEnv.DB_COLLATION || "") !== "") {
    nextEnv.DB_COLLATION = "";
    changed = true;
  }
  if (desiredUrl && nextEnv.DATABASE_URL !== desiredUrl) {
    nextEnv.DATABASE_URL = desiredUrl;
    changed = true;
  }
  if (password !== null && nextEnv.DB_PASSWORD !== password) {
    nextEnv.DB_PASSWORD = password;
    changed = true;
  }
  return { envVars: nextEnv, changed };
}

function enrichDeployBuildError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const enriched = appendFrontendModuleNotFoundHint(message);
  if (enriched === message) return error instanceof Error ? error : new Error(message);
  return new Error(enriched);
}

function assertCommandTree(result: unknown, label: string) {
  if (!result || typeof result !== "object") return;
  const value = result as { dryRun?: boolean; returncode?: number; stderr?: string; reason?: string; command?: unknown };
  if (Array.isArray(value.command) || typeof value.returncode === "number" || value.dryRun !== undefined) {
    try {
      assertLiveResult(value, label);
    } catch (error) {
      throw enrichDeployBuildError(error);
    }
    return;
  }
  for (const [key, child] of Object.entries(result)) {
    if (child === null || key === "path") continue;
    assertCommandTree(child, `${label} ${key}`);
  }
}

function nodeDependencyRepairCommand(packageManager: DeploymentPackageManager | null) {
  if (packageManager === "PNPM") return "pnpm install --prod=false";
  if (packageManager === "YARN") return "yarn install --production=false";
  return "npm install --production=false";
}

function isNodePackageManager(packageManager: DeploymentPackageManager | null) {
  return packageManager === "NPM" || packageManager === "PNPM" || packageManager === "YARN";
}

type JsPackageManager = "NPM" | "PNPM" | "YARN";

type LaravelFrontendAssets = {
  hasPackageJson: boolean;
  hasFrontendMarkers: boolean;
  hasBuiltAssets: boolean;
  packageManager: JsPackageManager;
  installCommand: string;
  buildCommand: string | null;
  evidence: string[];
};

function jsPackageManagerForFiles(files: Set<string>): JsPackageManager {
  if (files.has("pnpm-lock.yaml")) return "PNPM";
  if (files.has("yarn.lock")) return "YARN";
  return "NPM";
}

function jsInstallCommand(packageManager: JsPackageManager) {
  if (packageManager === "PNPM") return "pnpm install";
  if (packageManager === "YARN") return "yarn install";
  return "npm install";
}

function jsRunCommand(packageManager: JsPackageManager, script: string) {
  if (packageManager === "PNPM") return `pnpm run ${script}`;
  if (packageManager === "YARN") return `yarn ${script}`;
  return `npm run ${script}`;
}

async function pathExists(filePath: string) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function inspectLaravelFrontendAssets(appPath: string, publicDirectory: string | null | undefined): Promise<LaravelFrontendAssets> {
  const files = new Set<string>();
  const rootEntries = await fs.readdir(appPath).catch(() => []);
  for (const entry of rootEntries) files.add(entry.toLowerCase());
  const packageManager = jsPackageManagerForFiles(files);
  const packageJsonText = await fs.readFile(path.join(appPath, "package.json"), "utf8").catch(() => null);
  if (!packageJsonText) {
    return {
      hasPackageJson: false,
      hasFrontendMarkers: false,
      hasBuiltAssets: false,
      packageManager,
      installCommand: jsInstallCommand(packageManager),
      buildCommand: null,
      evidence: ["package.json not found"]
    };
  }

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(packageJsonText) as typeof pkg;
  } catch {
    pkg = {};
  }
  const scripts = pkg.scripts ?? {};
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const publicRoot = path.join(appPath, publicDirectory || "public");
  const viteConfig = files.has("vite.config.js") || files.has("vite.config.ts") || files.has("vite.config.mjs") || files.has("vite.config.cjs");
  const mixConfig = files.has("webpack.mix.js") || files.has("webpack.mix.cjs");
  const hasFrontendMarkers = Boolean(
    viteConfig
    || mixConfig
    || deps.vite
    || deps["laravel-vite-plugin"]
    || deps["laravel-mix"]
    || scripts.build
    || scripts.production
    || scripts.prod
  );
  const hasBuiltAssets = await pathExists(path.join(publicRoot, "build", "manifest.json"))
    || await pathExists(path.join(publicRoot, "mix-manifest.json"))
    || await pathExists(path.join(publicRoot, "admin", "assets", "css"))
    || await pathExists(path.join(publicRoot, "css"))
    || await pathExists(path.join(publicRoot, "js"));
  const buildScript = scripts.build ? "build" : scripts.production ? "production" : scripts.prod ? "prod" : null;
  return {
    hasPackageJson: true,
    hasFrontendMarkers,
    hasBuiltAssets,
    packageManager,
    installCommand: jsInstallCommand(packageManager),
    buildCommand: buildScript ? jsRunCommand(packageManager, buildScript) : null,
    evidence: [
      `packageManager=${packageManager}`,
      `vite=${Boolean(viteConfig || deps.vite || deps["laravel-vite-plugin"])}`,
      `mix=${Boolean(mixConfig || deps["laravel-mix"])}`,
      `builtAssets=${hasBuiltAssets}`,
      `buildCommand=${buildScript ?? "none"}`
    ]
  };
}

function laravelFrontendMissingSourceHint(text: string, appPath: string) {
  const match = text.match(/Can't resolve ['"]([^'"]+)['"] in ['"]([^'"]+)['"]/i);
  if (!match && !/module not found/i.test(text)) return null;
  const importPath = match?.[1] ?? "a referenced frontend source file";
  const fromDirectory = match?.[2] ? path.relative(appPath, match[2]) || "." : "the frontend source tree";
  return `Laravel Mix/Vite/webpack cannot find source file ${importPath} under ${fromDirectory}. Add the missing file to Git, fix the import path/case, or commit pre-built public assets (mix-manifest.json / public/build) and redeploy. The VPS cannot create missing application source files automatically.`;
}

async function ensureLaravelFrontendAssets(
  deploymentId: string,
  releaseId: string | undefined,
  appPath: string,
  publicDirectory: string | null | undefined,
  envVars: Record<string, string>,
  existingBuildCommand: string | null | undefined
) {
  const assets = await inspectLaravelFrontendAssets(appPath, publicDirectory);
  if (!assets.hasPackageJson || !assets.hasFrontendMarkers) return;
  if (assets.hasBuiltAssets && !assets.buildCommand) return;
  if (existingBuildCommand) {
    await writeLog(deploymentId, releaseId, "BUILDING", "Laravel frontend asset build deferred to deployment build command", {
      buildCommand: existingBuildCommand,
      evidence: assets.evidence
    });
    return;
  }
  if (!assets.buildCommand) {
    await writeLog(deploymentId, releaseId, "BUILDING", "Laravel frontend assets may be missing but no build script exists", {
      evidence: assets.evidence
    }, "warn");
    return;
  }

  await assertRuntimeToolsInstalled(deploymentId, releaseId, {
    framework: "NODEJS",
    packageManager: assets.packageManager,
    runtime: "NODE",
    processManager: "PM2",
    installCommand: assets.installCommand,
    buildCommand: assets.buildCommand,
    startCommand: null
  });

  const installResult = await runStep(deploymentId, releaseId, "INSTALLING", "Laravel frontend dependency install", () =>
    sysagent.deploymentInstall({
      rootPath: appPath,
      command: assets.installCommand,
      packageManager: assets.packageManager,
      env: envVars
    })
  );
  assertCommandTree(installResult, "Laravel frontend dependency install");

  const runFrontendBuild = () => runStep(deploymentId, releaseId, "BUILDING", "Laravel frontend asset build", () =>
    sysagent.deploymentBuild({
      rootPath: appPath,
      command: assets.buildCommand!,
      env: envVars
    })
  );
  let buildResult = await runFrontendBuild();
  try {
    assertCommandTree(buildResult, "Laravel frontend asset build");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const afterFailure = await inspectLaravelFrontendAssets(appPath, publicDirectory);
    if (afterFailure.hasBuiltAssets) {
      await writeLog(deploymentId, releaseId, "BUILDING", "Laravel frontend build reported errors but public assets exist; continuing deploy", {
        warning: detail.slice(0, 2000),
        evidence: afterFailure.evidence
      }, "warn");
      return;
    }
    const missingSourceHint = laravelFrontendMissingSourceHint(detail, appPath);
    if (missingSourceHint) throw new Error(`${detail}\n\n${missingSourceHint}`);
    if (!nodePackageBinaryMissing(detail)) throw error;
    await writeLog(deploymentId, releaseId, "BUILDING", "Laravel frontend build binary missing; reinstalling dev dependencies", {
      packageManager: assets.packageManager,
      evidence: detail.slice(0, 2000)
    }, "warn");
    const repairInstall = await runStep(deploymentId, releaseId, "INSTALLING", "Repair Laravel frontend dependencies", () =>
      sysagent.deploymentInstall({
        rootPath: appPath,
        command: nodeDependencyRepairCommand(assets.packageManager),
        packageManager: assets.packageManager,
        env: envVars
      })
    );
    assertCommandTree(repairInstall, "Repair Laravel frontend dependencies");
    buildResult = await runFrontendBuild();
    try {
      assertCommandTree(buildResult, "Laravel frontend asset build retry");
    } catch (retryError) {
      const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
      const afterRetry = await inspectLaravelFrontendAssets(appPath, publicDirectory);
      if (afterRetry.hasBuiltAssets) {
        await writeLog(deploymentId, releaseId, "BUILDING", "Laravel frontend build retry reported errors but public assets exist; continuing deploy", {
          warning: retryDetail.slice(0, 2000),
          evidence: afterRetry.evidence
        }, "warn");
        return;
      }
      const retryMissingSourceHint = laravelFrontendMissingSourceHint(retryDetail, appPath);
      if (retryMissingSourceHint) throw new Error(`${retryDetail}\n\n${retryMissingSourceHint}`);
      throw retryError;
    }
  }

  const after = await inspectLaravelFrontendAssets(appPath, publicDirectory);
  await writeLog(deploymentId, releaseId, "BUILDING", after.hasBuiltAssets ? "Laravel frontend assets ready" : "Laravel frontend build completed but assets were not detected", {
    evidence: after.evidence
  }, after.hasBuiltAssets ? "info" : "warn");
}

async function processLifecycleAction(action: string, deploymentId: string, releaseId: string | undefined) {
  let deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: deploymentWorkerInclude });
  const processAction = action === "redeploy" || action === "deploy" ? "start" : action;

  try {
    await runStep(deployment.id, releaseId, "PREFLIGHT", "Sysagent live command preflight", () =>
      assertSysagentLiveCommandsEnabled(deployment.id, releaseId)
    );

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
    let appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    ({ deployment, appPath } = await reconcileDeploymentRootDirectory(deployment, releaseId, appPath));
    ({ deployment, appPath } = await reconcileLaravelRootDirectory(deployment, releaseId, appPath));
    const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
    const domain = deploymentDomain(deployment);
    const runtimeEnvVars = deploymentEnvWithPublicUrl(envVars, domain);

    const lifecycleBackendOnlyLaravel = Boolean(
      processAction !== "stop"
      && domain
      && await deploymentRunsLaravel(deployment.framework, appPath)
      && !(await deploymentHasLaravelPublicIndex(appPath))
    );
    if (processAction !== "stop" && domain && lifecycleBackendOnlyLaravel && await staticRootHasIndex(deploymentFallbackRootPath(domain))) {
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Backend-only Laravel indexed public fallback config", () =>
        publishPublicHtmlNginxVhost(domain)
      );
    } else if (processAction !== "stop" && domain && lifecycleBackendOnlyLaravel) {
      await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "Skipped public route for backend-only Laravel deployment", {
        domain: domain.name,
        appPath,
        reason: "No public/index.php exists and public_html has no index file. The Laravel process can still run as backend-only/worker-safe."
      }, "warn");
    }
    if (processAction !== "stop" && domain && !lifecycleBackendOnlyLaravel) {
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Link deployment domain", () =>
        ensureParentDomainDeploymentProxy(deployment.id, domain).then(() => ({
          domain: domain.name,
          domainId: domain.id,
          fallbackRootPath: deploymentFallbackRootPath(domain)
        }))
      );
      const serverName = deploymentServerName(domain);
      const nginxResult = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", async () =>
        sysagent.deploymentNginx(
          buildDeploymentNginxRequest({
            deploymentId: deployment.id,
            fqdn: serverName ?? domain.name,
            upstreamPort: deployment.port,
            rootPath: appPath,
            framework: deployment.framework,
            startCommand: deployment.startCommand,
            publicDirectory: deployment.publicDirectory,
            outputDirectory: deployment.outputDirectory,
            fallbackRootPath: deploymentFallbackRootPath(domain),
            forceSsl: false,
            ...(await deploymentSslCertificatePathsWhenReady(domain))
          })
        )
      );
      assertLiveResult((nginxResult as { write?: unknown }).write, "Nginx proxy config write");
      assertLiveResult((nginxResult as { enable?: unknown }).enable, "Nginx proxy config enable");
      assertLiveResult((nginxResult as { test?: unknown }).test, "Nginx config test");
      assertLiveResult((nginxResult as { reload?: unknown }).reload, "Nginx reload");
    }

    const result = await runLiveDeploymentProcess(
      deployment.id,
      releaseId,
      `${action} process`,
      {
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        action: processAction,
        processManager,
        startCommand: renderStartCommand(deployment),
        port: deployment.port,
        env: runtimeEnvVars,
        logDir: deploymentLogDir(deployment.slug),
        framework: deployment.framework
      }
    );
    assertLiveResult(result, `${action} process`);

    if (deployment.framework === "LARAVEL") {
      const config = laravelWorkerConfig(deploymentProcessConfig(deployment.processConfig).laravelWorkers);
      const desiredWorkers = processAction === "stop" || !config.enabled ? 0 : config.desiredWorkers;
      const workerResult = await runStep(deployment.id, releaseId, "STARTING", `Laravel queue workers ${desiredWorkers > 0 ? "apply" : "stop"}`, () =>
        sysagent.deploymentLaravelWorkers({
          name: laravelWorkerProgramName(deployment.slug),
          rootPath: appPath,
          action: desiredWorkers > 0 ? "apply" : "stop",
          desiredWorkers,
          queueCommand: config.queueCommand,
          env: runtimeEnvVars,
          logDir: deploymentLogDir(deployment.slug)
        })
      );
      const runningWorkers = (workerResult as { runningWorkers?: number; status?: { running?: number } }).runningWorkers ?? (workerResult as { status?: { running?: number } }).status?.running ?? 0;
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          processConfig: {
            ...deploymentProcessConfig(deployment.processConfig),
            laravelWorkers: {
              ...config,
              desiredWorkers,
              currentWorkers: runningWorkers,
              lastScaledAt: new Date().toISOString(),
              lastScaleReason: `${action} lifecycle`
            }
          } as Prisma.InputJsonValue
        }
      });
    }

    if (processAction === "stop") {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "STOPPED", healthStatus: "DOWN", lastHealthCheckAt: new Date() } });
      if (domain) {
        await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Public HTML fallback config", async () =>
          publishPublicHtmlNginxVhost(domain)
        );
      }
      return { result, status: "STOPPED", healthStatus: "DOWN" };
    }

    const { health, outcome: healthOutcome } = await runHealthCheckWithGuardianRecovery(
      deployment,
      releaseId,
      appPath,
      envVars,
      processManager,
      `${action} health check`
    );

    const publicRouteWarning = await optionalPublicRouteWarning(deployment.id, releaseId, `${action} public website check`, { ...deployment, domain }, appPath, envVars, processManager);

    const healthStatus = publicRouteWarning || healthOutcome.degraded ? "DEGRADED" : "HEALTHY";
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
    await runStep(deployment.id, releaseId, "PREFLIGHT", "Sysagent live command preflight", () =>
      assertSysagentLiveCommandsEnabled(deployment.id, releaseId)
    );

    if (deployment.gitUrl || action === "pull") {
      const gitToken = await githubCloneToken(deployment.sourceProvider, deployment.gitUrl, deployment.accountId);
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
      await syncReleaseCommitInfo(deployment.id, releaseId, gitSyncCommitInfo(syncResult));
    } else {
      await writeLog(deployment.id, releaseId, "CLONING", "Source sync skipped for non-Git source", { sourceProvider: deployment.sourceProvider });
    }

    let appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    ({ deployment, appPath } = await reconcileDeploymentRootDirectory(deployment, releaseId, appPath));

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

    ({ deployment, appPath } = await reconcileLaravelRootDirectory(deployment, releaseId, appPath));
    deployment = await reconcileMisdetectedLaravelFramework(deployment, releaseId, appPath);
    deployment = await reconcileMissingStartCommand(deployment, releaseId);
    deployment = await reconcileNodeProductionStartCommand(deployment, releaseId);
    await assertRuntimeToolsInstalled(deployment.id, releaseId, deployment);

    if (deployment.processManager === "NONE" && deployment.framework !== "STATIC") {
      throw new Error(`No runnable start command found for ${deployment.slug}. Add a package.json start script or set a manual start command.`);
    }
    let domain = deploymentDomain(deployment);
    let envVars = deploymentEnvWithPublicUrl(await resolveEnvVars(deployment.env), domain);
    const databaseRuntime = await buildDatabaseRuntimeEnv(deployment, envVars, { releaseId });
    envVars = databaseRuntime.envVars;
    if (databaseRuntime.changed) {
      await writeLog(deployment.id, releaseId, "PREFLIGHT", "Normalized deployment database runtime env", {
        dbType: deployment.dbType,
        DB_CONNECTION: envVars.DB_CONNECTION,
        DB_HOST: envVars.DB_HOST,
        DB_PORT: envVars.DB_PORT,
        DB_DATABASE: envVars.DB_DATABASE,
        hasDatabaseUrl: Boolean(envVars.DATABASE_URL)
      }, "warn");
    }
    if (isPostgresDeploymentEnvironment(deployment, envVars)) {
      const normalized = await normalizePostgresRuntimeEnv(deployment.id, envVars, true);
      envVars = normalized.envVars;
      if (normalized.changed) {
        await writeLog(deployment.id, releaseId, "PREFLIGHT", "Normalized PostgreSQL runtime env", {
          DB_CONNECTION: envVars.DB_CONNECTION,
          DB_CHARSET: envVars.DB_CHARSET,
          DB_COLLATION: envVars.DB_COLLATION
        }, "warn");
      }
    }

    if (deployment.installCommand || deployment.packageManager) {
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "BUILDING" } });
      const installCommandText = renderDeploymentCommand(deployment.installCommand, deployment.port);
      const runsComposer = deployment.packageManager === "COMPOSER" || /\bcomposer\b/i.test(installCommandText ?? "");
      if (runsComposer) {
        try {
          await ensureComposerPlatformCompatible(deployment.id, releaseId, appPath, envVars);
          await ensureComposerDeclaredPlatformExtensions(deployment.id, releaseId, appPath);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await writeLog(deployment.id, releaseId, "PREFLIGHT", "Composer PHP extension preflight failed", {
            error: detail
          }, "error");
          throw new Error(`Composer PHP extension preflight failed before dependency install: ${detail}`);
        }
      }
      const runDependencyInstall = () => runStep(deployment.id, releaseId, "INSTALLING", "Dependency install", () =>
        sysagent.deploymentInstall({
          rootPath: appPath,
          command: installCommandText,
          packageManager: deployment.packageManager,
          env: envVars
        })
      );
      let installResult = await runDependencyInstall();
      try {
        assertCommandTree(installResult, "Dependency install");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        let repairFailure: string | null = null;
        const repaired = await autoRepairComposerPlatformIssue(deployment.id, releaseId, detail).catch((repairError) => {
          repairFailure = repairError instanceof Error ? repairError.message : String(repairError);
          return false;
        });
        if (!repaired) {
          if (repairFailure) {
            throw new Error(`${detail}\n\nComposer platform auto-repair failed: ${repairFailure}`);
          }
          throw error;
        }
        installResult = await runDependencyInstall();
        try {
          assertCommandTree(installResult, "Dependency install retry after Composer platform repair");
        } catch (retryError) {
          const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`${retryDetail}\n\nComposer platform auto-repair was attempted but the dependency install still failed. Deployment Doctor has a pending repair target for the detected PHP platform issue.`);
        }
      }
    }

    if (await deploymentRunsLaravel(deployment.framework, appPath)) {
      envVars = await ensureLaravelAppKey(deployment.id, releaseId, appPath, deployment.port, envVars);
      envVars = await ensureLaravelDatabaseConnection(deployment, releaseId, appPath, deployment.port, envVars);

      const optimizeClearResult = await runStep(deployment.id, releaseId, "INSTALLING", "Laravel cache clear", () =>
        sysagent.deploymentBuild({
          rootPath: appPath,
          command: "php artisan optimize:clear",
          env: envVars
        })
      );
      try {
        assertCommandTree(optimizeClearResult, "Laravel cache clear");
      } catch (error) {
        await writeLog(deployment.id, releaseId, "INSTALLING", "Laravel cache clear warning", {
          warning: error instanceof Error ? error.message : String(error)
        }, "warn");
      }

      const runLaravelPackageDiscovery = () => runStep(deployment.id, releaseId, "INSTALLING", "Laravel package discovery", () =>
        sysagent.deploymentBuild({
          rootPath: appPath,
          command: "php artisan package:discover --ansi -vvv",
          env: envVars
        })
      );
      let packageDiscoverResult = await runLaravelPackageDiscovery();
      try {
        assertCommandTree(packageDiscoverResult, "Laravel package discovery");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const repaired = await autoRepairLaravelWritablePaths(deployment.id, releaseId, appPath, detail).catch(() => false);
        if (!repaired) throw error;
        packageDiscoverResult = await runLaravelPackageDiscovery();
        assertCommandTree(packageDiscoverResult, "Laravel package discovery");
      }

      if (await shouldRunDatabaseMigration(deployment, releaseId, envVars)) {
        const runDatabaseMigration = () => runStep(deployment.id, releaseId, "MIGRATING", "Database migration", () =>
          sysagent.deploymentMigrate({
            rootPath: appPath,
            command: "php artisan migrate --force",
            env: envVars
          })
        );
        let migrateResult = await runDatabaseMigration();
        try {
          assertCommandTree(migrateResult, "Database migration");
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const repairedEnv = await autoRepairPostgresEncoding(deployment.id, releaseId, detail, envVars).catch(() => null);
          if (!repairedEnv) throw error;
          envVars = repairedEnv;
          migrateResult = await runDatabaseMigration();
          assertCommandTree(migrateResult, "Database migration");
        }
      }

      await ensureLaravelFrontendAssets(
        deployment.id,
        releaseId,
        appPath,
        deployment.publicDirectory,
        envVars,
        deployment.buildCommand
      );
    } else {
      await writeLog(deployment.id, releaseId, "MIGRATING", "Migration skipped for framework", { framework: deployment.framework });
    }

    if (deployment.buildCommand) {
      const runBuild = () => runStep(deployment.id, releaseId, "BUILDING", "Build", () =>
        sysagent.deploymentBuild({
          rootPath: appPath,
          command: renderDeploymentCommand(deployment.buildCommand, deployment.port),
          env: envVars
        })
      );
      let buildResult = await runBuild();
      try {
        assertCommandTree(buildResult, "Build");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!nodePackageBinaryMissing(detail) || !isNodePackageManager(deployment.packageManager)) {
          throw error;
        }
        await writeLog(deployment.id, releaseId, "BUILDING", "Node build package binary missing; reinstalling dependencies with devDependencies", {
          packageManager: deployment.packageManager,
          evidence: detail.slice(0, 2000)
        }, "warn");
        const repairInstall = await runStep(deployment.id, releaseId, "INSTALLING", "Repair Node build dependencies", () =>
          sysagent.deploymentInstall({
            rootPath: appPath,
            command: nodeDependencyRepairCommand(deployment.packageManager),
            packageManager: deployment.packageManager,
            env: envVars
          })
        );
        assertCommandTree(repairInstall, "Repair Node build dependencies");
        buildResult = await runBuild();
        try {
          assertCommandTree(buildResult, "Build retry after Node dependency repair");
        } catch (retryError) {
          const retryDetail = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`${retryDetail}\n\nGuardian reinstalled Node dependencies with devDependencies because a local build binary was missing, but the build still failed.`);
        }
      }
    }

    const backendOnlyLaravel = Boolean(
      domain
      && await deploymentRunsLaravel(deployment.framework, appPath)
      && !(await deploymentHasLaravelPublicIndex(appPath))
    );
    if (domain && backendOnlyLaravel) {
      const fallbackRootPath = deploymentFallbackRootPath(domain);
      const hasFallbackIndex = await staticRootHasIndex(fallbackRootPath);
      if (hasFallbackIndex) {
        await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Backend-only Laravel public fallback config", () =>
          publishPublicHtmlNginxVhost(domain)
        );
      }
      await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", hasFallbackIndex ? "Published indexed public_html fallback for backend-only Laravel deployment" : "Skipped public route for backend-only Laravel deployment", {
        domain: domain.name,
        appPath,
        fallbackRootPath,
        reason: hasFallbackIndex
          ? "No public/index.php exists, so the idle worker-safe process does not listen on the managed web port. The indexed public_html site was published instead."
          : "No public/index.php exists and public_html has no index file. The Laravel process can still run as backend-only/worker-safe."
      }, "warn");
    }
    if (domain && !backendOnlyLaravel) {
      const linkedDomain = domain;
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Link deployment domain", () =>
        ensureParentDomainDeploymentProxy(deployment.id, linkedDomain).then(() => ({
          domain: linkedDomain.name,
          domainId: linkedDomain.id,
          fallbackRootPath: deploymentFallbackRootPath(linkedDomain)
        }))
      );
    }
    await repairSysagentLiveCommandsForDeployment(
      deployment.id,
      releaseId,
      "before nginx proxy and SSL"
    ).catch(() => undefined);
    let proxyHttpsReady = false;
    if (domain && !backendOnlyLaravel) {
      const tlsSync = await syncDeploymentTlsWithCertificate(domain);
      domain = tlsSync.domain;
      proxyHttpsReady = tlsSync.httpsReady;
      const serverName = deploymentServerName(domain);
      const nginxResult = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config", async () =>
        sysagent.deploymentNginx(
          buildDeploymentNginxRequest({
            deploymentId: deployment.id,
            fqdn: serverName ?? domain!.name,
            upstreamPort: deployment.port,
            rootPath: appPath,
            framework: deployment.framework,
            startCommand: deployment.startCommand,
            publicDirectory: deployment.publicDirectory,
            outputDirectory: deployment.outputDirectory,
            fallbackRootPath: deploymentFallbackRootPath(domain),
            forceSsl: proxyHttpsReady,
            ...(await deploymentSslCertificatePathsWhenReady(domain))
          })
        )
      );
      assertLiveResult((nginxResult as { write?: unknown }).write, "Nginx proxy config write");
      assertLiveResult((nginxResult as { enable?: unknown }).enable, "Nginx proxy config enable");
      assertLiveResult((nginxResult as { test?: unknown }).test, "Nginx config test");
      assertLiveResult((nginxResult as { reload?: unknown }).reload, "Nginx reload");
    } else {
      await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx proxy config skipped", {
        reason: "No linked domain; deployment will remain reachable through its managed internal port."
      });
    }

    if (domain && !backendOnlyLaravel && !proxyHttpsReady) {
      const serverName = deploymentServerName(domain);
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Prepare ACME webroot", () => ensureAcmeWebroot(domain));
      const includeWww = await wwwPointsToThisVps(domain);
      const sslJob = await sslQueue.add("issue", {
        domainId: domain.id.startsWith("subdomain:") ? null : domain.id,
        subdomainId: domain.id.startsWith("subdomain:") ? domain.id.slice("subdomain:".length) : null,
        domain: domain.name,
        email: deploymentSslContactEmail(domain),
        webRoot: deploymentFallbackRootPath(domain) ?? `${env.FILE_MANAGER_ROOT}/${domain.name}/public_html`,
        includeWww,
        forceSsl: true,
        source: "deployment"
      });
      try {
        await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL certificate issue", async () => {
          await waitForQueueJob(sslJob);
          return { queued: true, jobId: sslJob.id, completed: true };
        });
        proxyHttpsReady = true;
        const httpsNginx = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx HTTPS proxy config", () =>
          publishDeploymentProxyNginx({
            deploymentId: deployment.id,
            fqdn: deploymentServerName({ ...domain!, includeWww }) ?? domain!.name,
            upstreamPort: deployment.port,
            rootPath: appPath,
            framework: deployment.framework,
            startCommand: deployment.startCommand,
            publicDirectory: deployment.publicDirectory,
            outputDirectory: deployment.outputDirectory,
            fallbackRootPath: deploymentFallbackRootPath(domain),
            forceHttps: true
          })
        );
        assertLiveResult((httpsNginx as { write?: unknown }).write, "Nginx HTTPS proxy config write");
        assertLiveResult((httpsNginx as { enable?: unknown }).enable, "Nginx HTTPS proxy config enable");
        assertLiveResult((httpsNginx as { test?: unknown }).test, "Nginx HTTPS config test");
        assertLiveResult((httpsNginx as { reload?: unknown }).reload, "Nginx HTTPS reload");
        envVars = deploymentEnvWithPublicUrl(envVars, domain, true);
        if (await deploymentRunsLaravel(deployment.framework, appPath)) {
          envVars = await ensureLaravelAppKey(deployment.id, releaseId, appPath, deployment.port, envVars);
        }
      } catch (error) {
        domain = await disableDeploymentTlsInDatabase(domain, { clearForceSsl: false });
        const sslDetail = error instanceof Error ? error.message : String(error);
        await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL certificate issue warning", {
          warning: sslDetail,
          hint: `Use http://${domain.name}/ until SSL succeeds. Check ALLOW_LIVE_SSL=true, certbot installed, and DNS A record for ${domain.name}.`
        }, "warn");
        await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Nginx HTTP fallback after SSL failure", () =>
          publishDeploymentProxyNginx({
            deploymentId: deployment.id,
            fqdn: serverName ?? domain!.name,
            upstreamPort: deployment.port,
            rootPath: appPath,
            framework: deployment.framework,
            startCommand: deployment.startCommand,
            publicDirectory: deployment.publicDirectory,
            outputDirectory: deployment.outputDirectory,
            fallbackRootPath: deploymentFallbackRootPath(domain),
            forceHttps: false
          })
        );
      }
    } else {
      await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "SSL request skipped", {
        reason: backendOnlyLaravel ? "Backend-only Laravel deployment has no public web process" : domain ? "Certificate already active" : "No linked domain"
      });
    }

    if (domain && !backendOnlyLaravel) {
      const serverName = deploymentServerName(domain);
      const tlsSync = await syncDeploymentTlsWithCertificate(domain);
      const activeDomain = tlsSync.domain ?? domain;
      domain = activeDomain;
      await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Finalize deployment proxy vhost", () =>
        publishDeploymentProxyNginx({
          deploymentId: deployment.id,
          fqdn: serverName ?? activeDomain.name,
          upstreamPort: deployment.port,
          rootPath: appPath,
          framework: deployment.framework,
          startCommand: deployment.startCommand,
          publicDirectory: deployment.publicDirectory,
          outputDirectory: deployment.outputDirectory,
          fallbackRootPath: deploymentFallbackRootPath(activeDomain),
          forceHttps: tlsSync.httpsReady
        })
      );
      const diagnose = await runStep(deployment.id, releaseId, "CONFIGURING_PROXY", "Public access diagnose", () =>
        sysagent.deploymentPublicAccessDiagnose({
          serverName: serverName ?? activeDomain.name,
          rootPath: appPath,
          framework: deployment.framework
        })
      );
      if (!tlsSync.httpsReady) {
        envVars = deploymentEnvWithPublicUrl(envVars, activeDomain, false);
        await repairDeploymentSslAccess(deployment.id, releaseId, { ...deployment, rootPath: appPath }, activeDomain).catch((error) =>
          writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "Automatic SSL repair skipped", {
            warning: error instanceof Error ? error.message : String(error)
          }, "warn")
        );
        await writeLog(deployment.id, releaseId, "CONFIGURING_PROXY", "HTTPS not active yet", {
          publicUrl: `http://${activeDomain.name}/`,
          diagnose: JSON.parse(JSON.stringify(diagnose)) as Prisma.InputJsonValue
        }, "warn");
      } else {
        envVars = deploymentEnvWithPublicUrl(envVars, activeDomain, true);
      }
    }

    const processManager = deployment.processManager ?? defaultProcessManagerByFramework[deployment.framework];
    if (await deploymentRunsLaravel(deployment.framework, appPath)) {
      envVars = await ensureLaravelAppKey(deployment.id, releaseId, appPath, deployment.port, envVars);
      await prepareLaravelForStart(deployment.id, releaseId, appPath, deployment.port, envVars);
    }
    const startResult = await runLiveDeploymentProcess(
      deployment.id,
      releaseId,
      "Process start",
      {
        deploymentId: deployment.id,
        name: deployment.slug,
        rootPath: appPath,
        action: "start",
        processManager,
        startCommand: renderStartCommand(deployment),
        port: deployment.port,
        env: envVars,
        logDir: deploymentLogDir(deployment.slug),
        framework: deployment.framework
      }
    );
    assertLiveResult(startResult, "Process start");

    const { outcome: healthOutcome } = await runHealthCheckWithGuardianRecovery(
      deployment,
      releaseId,
      appPath,
      envVars,
      processManager,
      "Health check"
    );

    const publicRouteWarning = await optionalPublicRouteWarning(deployment.id, releaseId, "Public website check", { ...deployment, domain }, appPath, envVars, processManager);

    await markRelease(releaseId, action === "rollback" ? "ROLLED_BACK" : "SUCCEEDED", startedAt);
    const healthStatus = publicRouteWarning || healthOutcome.degraded ? "DEGRADED" : "HEALTHY";
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

    return runDeploymentExclusive(data.deploymentId, async () => {
      if (["start", "stop", "restart"].includes(job.name)) {
        return processLifecycleAction(job.name, data.deploymentId!, data.releaseId);
      }

      return processDeploy(job.name, data.deploymentId!, data.releaseId);
    });
  },
  { connection: redis, concurrency: env.DEPLOY_WORKER_CONCURRENCY }
);
