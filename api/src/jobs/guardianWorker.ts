import { Worker } from "bullmq";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { expireGuardianIpBlocks, runGuardianAutoHeal, syncGuardianIncidentsOnly, type GuardianDiagnosis } from "../lib/guardianAutoHeal.js";
import { restartDeploymentProcess, runGuardianDeploymentRepair } from "../lib/deploymentGuardianRepair.js";
import { detectDeploymentSource, findDeploymentAppRoot, findLaravelAppRoot } from "../lib/deploymentDetection.js";
import { prisma } from "../lib/prisma.js";
import { sysagent } from "../lib/sysagent.js";
import { checkPanelRemoteUpdate } from "../lib/panelUpdateMonitor.js";
import { runDeploymentAutoDeployPoll } from "../lib/deploymentAutoDeployPoller.js";
import { deployQueue } from "./queues.js";
import { requiredRuntimeExecutables, runtimeInstallTargetsForMissingExecutables } from "../lib/deploymentRuntimeTools.js";
import { laravelPublicCwdMissing, nginxProxyMissingDomainFailure, permissionRepairNeeded, pythonRuntimeRepairNeeded, runtimeTargetsForFailedDeploymentLog, supervisorRepairNeeded } from "../lib/deploymentFailureRuntimeRepairs.js";
import path from "node:path";

const staleDeploymentMs = Number(process.env.GUARDIAN_STALE_DEPLOYMENT_MS ?? 15 * 60_000);
const autoDeployRepairEnabled = process.env.GUARDIAN_AUTO_DEPLOY_REPAIR !== "false";
const autoDeployCooldownMs = Number(process.env.GUARDIAN_AUTO_DEPLOY_COOLDOWN_MS ?? 30 * 60_000);
const autoDeployMaxAttempts = Number(process.env.GUARDIAN_AUTO_DEPLOY_MAX_ATTEMPTS_PER_HOUR ?? 2);

function deploymentAppPath(rootPath: string, rootDirectory: string | null | undefined) {
  const cleanRootDirectory = (rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanRootDirectory && cleanRootDirectory !== "." ? `${rootPath.replace(/\/+$/, "")}/${cleanRootDirectory}` : rootPath;
}

function deploymentRootWithoutPublicSuffix(rootPath: string) {
  return rootPath.replace(/\/+$/, "").replace(/\/public$/i, "");
}

function defaultProcessManager(framework: string) {
  if (framework === "NEXTJS" || framework === "NODEJS") return "PM2";
  if (framework === "STATIC") return "STATIC";
  return "SUPERVISOR";
}

async function recentlyQueuedAutoRepair(deploymentId: string) {
  const since = new Date(Date.now() - autoDeployCooldownMs);
  return prisma.deploymentLog.findFirst({
    where: {
      deploymentId,
      step: "QUEUED",
      message: { startsWith: "Guardian queued auto" },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" }
  });
}

async function hourlyAutoRepairAttempts(deploymentId: string) {
  return prisma.deploymentLog.count({
    where: {
      deploymentId,
      step: "QUEUED",
      message: { startsWith: "Guardian queued auto" },
      createdAt: { gte: new Date(Date.now() - 60 * 60_000) }
    }
  });
}

async function hasPendingDoctorApproval(deploymentId: string) {
  const pending = await prisma.deploymentDoctorApproval.findFirst({
    where: { deploymentId, status: "PENDING" },
    select: { id: true, actionKey: true }
  });
  return pending;
}

function deploymentLogDir(slug: string) {
  return `${process.env.DEPLOYMENT_LOG_ROOT ?? "/var/log/vps-panel/deployments"}/${slug}`;
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

function metadataText(metadata: unknown) {
  if (!metadata) return "";
  if (typeof metadata === "string") return metadata;
  try {
    return JSON.stringify(metadata);
  } catch {
    return "";
  }
}

function deploymentFailureText(logs: Array<{ message: string; stdout: string | null; stderr: string | null; metadata: unknown }>) {
  return logs.map((log) => [log.message, log.stderr, log.stdout, metadataText(log.metadata)].filter(Boolean).join("\n")).join("\n");
}

async function ensureDoctorApprovalExists(deploymentId: string, target: { actionKey: string; label: string; command: string; reason: string }) {
  const existing = await prisma.deploymentDoctorApproval.findFirst({
    where: { deploymentId, actionKey: target.actionKey, status: { in: ["PENDING", "APPROVED"] } }
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

async function guardianApplyFailureRepairs(
  deployment: Awaited<ReturnType<typeof prisma.deployment.findMany>>[number],
  failureText: string,
  appPath: string
) {
  if (!failureText.trim()) return { identified: false, applied: [], approvalsCreated: 0 };

  const applied: string[] = [];
  let approvalsCreated = 0;
  const runtimeTargets = runtimeTargetsForFailedDeploymentLog(failureText);
  const publicCwdMissing = laravelPublicCwdMissing(failureText);
  const proxyMissingDomain = nginxProxyMissingDomainFailure(failureText);

  await prisma.deploymentLog.create({
    data: {
      deploymentId: deployment.id,
      step: "PREFLIGHT",
      level: runtimeTargets.length || publicCwdMissing || proxyMissingDomain || supervisorRepairNeeded(failureText) || permissionRepairNeeded(failureText) || pythonRuntimeRepairNeeded(failureText) ? "warn" : "info",
      message: "Guardian parsed failed deployment logs",
      metadata: {
        runtimeTargets: runtimeTargets.map((target) => target.actionKey),
        laravelPublicCwdMissing: publicCwdMissing,
        nginxProxyMissingDomain: proxyMissingDomain,
        supervisorRepair: supervisorRepairNeeded(failureText),
        permissionRepair: permissionRepairNeeded(failureText),
        pythonRuntimeRepair: pythonRuntimeRepairNeeded(failureText),
        evidence: failureText.slice(0, 4000)
      } as any
    }
  });

  if (publicCwdMissing && deployment.framework === "LARAVEL") {
    const correctedRootPath = deploymentRootWithoutPublicSuffix(deployment.rootPath);
    if (correctedRootPath !== deployment.rootPath || deployment.rootDirectory !== ".") {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          rootPath: correctedRootPath,
          rootDirectory: ".",
          publicDirectory: deployment.publicDirectory || "public"
        }
      });
      applied.push("correct-laravel-root-cwd");
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "PREFLIGHT",
          level: "warn",
          message: "Guardian corrected Laravel deployment root after missing public cwd",
          metadata: {
            previousRootPath: deployment.rootPath,
            previousRootDirectory: deployment.rootDirectory,
            rootPath: correctedRootPath,
            publicDirectory: deployment.publicDirectory || "public"
          } as any
        }
      });
    }

    const nestedAppRoot = await findLaravelAppRoot(correctedRootPath, ".");
    const relativeRootDirectory = nestedAppRoot ? path.relative(correctedRootPath, nestedAppRoot) : null;
    if (
      nestedAppRoot
      && relativeRootDirectory
      && !relativeRootDirectory.startsWith("..")
      && !path.isAbsolute(relativeRootDirectory)
    ) {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          rootPath: correctedRootPath,
          rootDirectory: relativeRootDirectory,
          publicDirectory: deployment.publicDirectory || "public"
        }
      });
      applied.push("correct-nested-laravel-root");
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "PREFLIGHT",
          level: "warn",
          message: "Guardian corrected nested Laravel app root after missing public cwd",
          metadata: {
            previousRootPath: deployment.rootPath,
            previousRootDirectory: deployment.rootDirectory,
            rootPath: correctedRootPath,
            rootDirectory: relativeRootDirectory,
            appPath: nestedAppRoot,
            publicDirectory: deployment.publicDirectory || "public"
          } as any
        }
      });
    }
  }

  for (const target of runtimeTargets) {
    try {
      const install = await sysagent.deploymentInstallRuntimeTool({ tool: target.tool });
      const failed = install.dryRun || (typeof install.returncode === "number" && install.returncode !== 0);
      if (failed) throw new Error(install.stderr || install.stdout || `exit ${install.returncode ?? "unknown"}`);
      applied.push(target.actionKey);
    } catch (error) {
      await ensureDoctorApprovalExists(deployment.id, target);
      approvalsCreated += 1;
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "PREFLIGHT",
          level: "warn",
          message: `Guardian could not auto-apply ${target.actionKey}; approval queued`,
          metadata: { error: error instanceof Error ? error.message : String(error), target } as any
        }
      });
    }
  }

  if (pythonRuntimeRepairNeeded(failureText)) {
    try {
      const repair = await sysagent.deploymentRepairPythonRuntime({ rootPath: appPath });
      const failed = repair.dryRun || (typeof repair.returncode === "number" && repair.returncode !== 0);
      if (failed) throw new Error(repair.stderr || repair.stdout || `exit ${repair.returncode ?? "unknown"}`);
      applied.push("repair-python-venv-runtime");
    } catch (error) {
      await ensureDoctorApprovalExists(deployment.id, {
        actionKey: "install-python311",
        label: "Install Python 3.10+ runtime",
        command: "Install Python 3.10+/3.11 via panel runtime-tools, rebuild .venv, and redeploy",
        reason: "The app uses Python 3.10+ syntax but the VPS started it with Python 3.9."
      });
      approvalsCreated += 1;
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "PREFLIGHT",
          level: "warn",
          message: "Guardian Python runtime repair needs approval",
          metadata: { error: error instanceof Error ? error.message : String(error) } as any
        }
      });
    }
  }

  if (!publicCwdMissing && (permissionRepairNeeded(failureText) || supervisorRepairNeeded(failureText))) {
    try {
      const repair = await sysagent.deploymentRepairPermissions({ rootPath: appPath, logDir: deploymentLogDir(deployment.slug) });
      const failed = repair.dryRun || (typeof repair.returncode === "number" && repair.returncode !== 0);
      if (failed) throw new Error(repair.stderr || repair.stdout || `exit ${repair.returncode ?? "unknown"}`);
      applied.push("repair-permissions");
    } catch (error) {
      await ensureDoctorApprovalExists(deployment.id, {
        actionKey: "repair-permissions",
        label: "Repair deployment ownership",
        command: `chown -R panel:panel ${appPath} ${deploymentLogDir(deployment.slug)}`,
        reason: "Ownership/permission repairs affect deployment files and logs."
      });
      approvalsCreated += 1;
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "PREFLIGHT",
          level: "warn",
          message: "Guardian permission repair needs approval",
          metadata: { error: error instanceof Error ? error.message : String(error) } as any
        }
      });
    }
  }

  if (!publicCwdMissing && supervisorRepairNeeded(failureText)) {
    try {
      const repair = await sysagent.deploymentRepairSupervisor({ name: deployment.slug });
      const failed = repair.dryRun || (typeof repair.returncode === "number" && repair.returncode !== 0);
      if (failed) throw new Error(repair.stderr || repair.stdout || `exit ${repair.returncode ?? "unknown"}`);
      applied.push("supervisor-config");
    } catch (error) {
      await ensureDoctorApprovalExists(deployment.id, {
        actionKey: "supervisor-config",
        label: "Rewrite Supervisor config",
        command: `supervisorctl reread && supervisorctl update && supervisorctl restart ${deployment.slug}`,
        reason: "Supervisor spawn/backoff errors may need a regenerated process config."
      });
      approvalsCreated += 1;
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "PREFLIGHT",
          level: "warn",
          message: "Guardian Supervisor repair needs approval",
          metadata: { error: error instanceof Error ? error.message : String(error) } as any
        }
      });
    }
  }

  return { identified: runtimeTargets.length > 0 || publicCwdMissing || proxyMissingDomain || supervisorRepairNeeded(failureText) || permissionRepairNeeded(failureText) || pythonRuntimeRepairNeeded(failureText), applied, approvalsCreated };
}

async function queueGuardianDeployRepair(deployment: Awaited<ReturnType<typeof prisma.deployment.findMany>>[number], action: "restart" | "deploy", reason: string) {
  if (!autoDeployRepairEnabled) return { queued: false, reason: "auto deploy repair disabled" };

  const pendingApproval = await hasPendingDoctorApproval(deployment.id);
  if (pendingApproval) return { queued: false, reason: `pending approval ${pendingApproval.actionKey}` };

  const recent = await recentlyQueuedAutoRepair(deployment.id);
  if (recent) return { queued: false, reason: "cooldown active", recentLogId: recent.id };

  const attempts = await hourlyAutoRepairAttempts(deployment.id);
  if (attempts >= autoDeployMaxAttempts) return { queued: false, reason: `max hourly attempts reached (${attempts}/${autoDeployMaxAttempts})` };

  let releaseId: string | undefined;
  if (action === "deploy") {
    const release = await prisma.deploymentRelease.create({
      data: {
        deploymentId: deployment.id,
        status: "QUEUED",
        commitSha: null,
        sourcePath: deployment.rootPath,
        envSnapshot: deployment.envVars as any,
        processConfig: { port: deployment.port, processManager: deployment.processManager, startCommand: deployment.startCommand }
      }
    });
    releaseId = release.id;
  }

  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { status: action === "deploy" ? "QUEUED" : "DEPLOYING", healthStatus: "UNKNOWN" }
  });
  await prisma.deploymentLog.create({
    data: {
      deploymentId: deployment.id,
      releaseId,
      step: "QUEUED",
      message: action === "deploy" ? "Guardian queued auto redeploy" : "Guardian queued auto restart",
      metadata: { reason, attempts: attempts + 1, cooldownMs: autoDeployCooldownMs } as any
    }
  });
  const job = await deployQueue.add(action, { deploymentId: deployment.id, releaseId });
  return { queued: true, action, releaseId, jobId: job.id };
}

function renderStartCommand(deployment: { framework: string; startCommand: string | null; port: number }) {
  if (deployment.framework === "NEXTJS") {
    return `npx next start -p ${deployment.port} -H 127.0.0.1`;
  }
  const normalized = deployment.startCommand?.trim().toLowerCase() ?? "";
  if (
    deployment.framework === "LARAVEL"
    && (!normalized || normalized === "php-fpm" || /^php(\d+(?:\.\d+)?)?-fpm$/.test(normalized))
  ) {
    return `php artisan serve --host=127.0.0.1 --port ${deployment.port}`;
  }
  return deployment.startCommand?.replaceAll("{PORT}", String(deployment.port)).replaceAll("$PORT", String(deployment.port)) ?? null;
}

async function guardianSyncRuntimeIfMissingStart(
  deployment: Awaited<ReturnType<typeof prisma.deployment.findMany>>[number]
) {
  if (deployment.framework === "STATIC" || deployment.startCommand?.trim()) {
    return deployment;
  }

  deployment = await guardianCorrectNestedDeploymentRoot(deployment);
  const detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
  const startCommand = detection.suggestions.startCommand;
  if (!startCommand) {
    return deployment;
  }

  return prisma.deployment.update({
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
    }
  });
}

async function guardianCorrectNestedDeploymentRoot(
  deployment: Awaited<ReturnType<typeof prisma.deployment.findMany>>[number]
) {
  const currentAppPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
  const detected = await findDeploymentAppRoot(deployment.rootPath, deployment.rootDirectory, deployment.framework);
  if (!detected || detected.appPath === currentAppPath) {
    return deployment;
  }

  const relativeRootDirectory = path.relative(deployment.rootPath, detected.appPath);
  if (!relativeRootDirectory || relativeRootDirectory.startsWith("..") || path.isAbsolute(relativeRootDirectory)) {
    return deployment;
  }

  const updated = await prisma.deployment.update({
    where: { id: deployment.id },
    data: {
      rootDirectory: relativeRootDirectory,
      publicDirectory: detected.detection.detected === "LARAVEL" ? deployment.publicDirectory || "public" : deployment.publicDirectory
    }
  });

  await prisma.deploymentLog.create({
    data: {
      deploymentId: deployment.id,
      step: "PREFLIGHT",
      level: "warn",
      message: "Guardian corrected nested deployment app root directory",
      metadata: {
        framework: detected.detection.detected,
        previousRootDirectory: deployment.rootDirectory,
        previousAppPath: currentAppPath,
        appPath: detected.appPath,
        rootDirectory: relativeRootDirectory,
        reason: detected.detection.reason
      } as any
    }
  });

  return { ...deployment, ...updated };
}

async function guardianInlineDeploymentRepair(
  deployment: Awaited<ReturnType<typeof prisma.deployment.findMany>>[number] & {
    env?: Array<{ key: string; value: string | null; secretRef: string | null }>;
  },
  appPath: string
) {
  const envVars = Object.fromEntries(
    (deployment.env ?? [])
      .filter((item) => item.value)
      .map((item) => [item.key, item.value as string])
  );
  await runGuardianDeploymentRepair({ rootPath: appPath, framework: deployment.framework, envVars });
  await restartDeploymentProcess({
    deploymentId: deployment.id,
    slug: deployment.slug,
    appPath,
    port: deployment.port,
    processManager: (deployment.processManager ?? defaultProcessManager(deployment.framework)) as any,
    startCommand: renderStartCommand(deployment),
    envVars,
    logDir: `${process.env.DEPLOYMENT_LOG_ROOT ?? "/var/log/vps-panel/deployments"}/${deployment.slug}`
  });
}

async function runDeploymentWatch() {
  const deployments = await prisma.deployment.findMany({
    where: {
      OR: [
        { status: "FAILED" },
        { healthStatus: { in: ["DOWN", "DEGRADED", "UNKNOWN"] } },
        { status: { in: ["DEPLOYING", "BUILDING", "QUEUED"] }, updatedAt: { lte: new Date(Date.now() - staleDeploymentMs) } }
      ]
    },
    include: { env: true },
    orderBy: { updatedAt: "desc" },
    take: 25
  });
  const results = [];
  for (const deployment of deployments) {
    try {
      const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
      let result = await sysagent.deploymentHealth({
        deploymentId: deployment.id,
        port: deployment.port,
        healthUrl: deployment.healthUrl,
        processName: deployment.slug,
        processManager: deployment.processManager ?? defaultProcessManager(deployment.framework),
        rootPath: appPath,
        framework: deployment.framework
      }) as { dryRun?: boolean; returncode?: number; degraded?: boolean; stderr?: string; stdout?: string };
      let healthy = !result.dryRun && (result.returncode === 0 || Boolean(result.degraded));
      if (!healthy && (deployment.framework === "LARAVEL" || result.returncode === 23 || result.returncode === 22)) {
        try {
          await guardianInlineDeploymentRepair(deployment, appPath);
          result = await sysagent.deploymentHealth({
            deploymentId: deployment.id,
            port: deployment.port,
            healthUrl: deployment.healthUrl,
            processName: deployment.slug,
            processManager: deployment.processManager ?? defaultProcessManager(deployment.framework),
            rootPath: appPath,
            framework: deployment.framework
          }) as typeof result;
          healthy = !result.dryRun && (result.returncode === 0 || Boolean(result.degraded));
        } catch (repairError) {
          result = {
            ...result,
            stderr: `${result.stderr ?? ""} Guardian inline repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`.trim()
          };
        }
      }
      const stalePending = ["DEPLOYING", "BUILDING", "QUEUED"].includes(deployment.status) && Date.now() - deployment.updatedAt.getTime() >= staleDeploymentMs;
      const keepFailedStatus = deployment.status === "FAILED" && healthy && !(result as { backendOnly?: boolean }).backendOnly;
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: {
          status: keepFailedStatus ? "FAILED" : healthy ? "RUNNING" : stalePending ? "FAILED" : deployment.status,
          healthStatus: healthy ? (result.degraded ? "DEGRADED" : "HEALTHY") : "DOWN",
          lastHealthCheckAt: new Date()
        }
      });
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "HEALTH_CHECK",
          level: healthy ? "info" : "warn",
          message: healthy
            ? keepFailedStatus
              ? "Scheduled deployment watch passed but kept failed deploy status"
              : "Scheduled deployment watch passed"
            : stalePending
              ? "Scheduled deployment watch marked stale deployment as failed"
              : "Scheduled deployment watch failed",
          metadata: { result, stalePending, keptFailedStatus: keepFailedStatus } as any
        }
      });
      let autoRepair = null;
      if (!healthy) {
        const shouldRedeploy = stalePending || deployment.status === "FAILED";
        const shouldRestart = !shouldRedeploy && deployment.status === "RUNNING";
        if (shouldRedeploy || shouldRestart) {
          if (shouldRedeploy && !deployment.startCommand?.trim() && deployment.framework !== "STATIC") {
            await guardianSyncRuntimeIfMissingStart(deployment);
          }
          if (shouldRedeploy) {
            const recentFailureLogs = await prisma.deploymentLog.findMany({
              where: {
                deploymentId: deployment.id,
                OR: [{ level: "error" }, { step: "FAILED" }, { step: "PREFLIGHT" }, { step: "STARTING" }, { step: "INSTALLING" }, { step: "BUILDING" }]
              },
              orderBy: { createdAt: "desc" },
              take: 12
            });
            const failureRepair = await guardianApplyFailureRepairs(deployment, deploymentFailureText(recentFailureLogs), appPath);
            if (failureRepair.identified) {
              await prisma.deploymentLog.create({
                data: {
                  deploymentId: deployment.id,
                  step: "PREFLIGHT",
                  level: failureRepair.approvalsCreated ? "warn" : "info",
                  message: "Guardian assigned failed-deploy auto-repair",
                  metadata: failureRepair as any
                }
              });
            }
          }
          autoRepair = await queueGuardianDeployRepair(
            deployment,
            shouldRedeploy ? "deploy" : "restart",
            stalePending ? "stale deployment did not finish" : deployment.status === "FAILED" ? "deployment is failed" : "running deployment health check failed"
          );
        }
      }
      results.push({ deploymentId: deployment.id, healthy, stalePending, autoRepair });
    } catch (error) {
      const stalePending = ["DEPLOYING", "BUILDING", "QUEUED"].includes(deployment.status) && Date.now() - deployment.updatedAt.getTime() >= staleDeploymentMs;
      if (stalePending) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: "FAILED", healthStatus: "DOWN", lastHealthCheckAt: new Date() }
        });
      }
      await prisma.deploymentLog.create({
        data: {
          deploymentId: deployment.id,
          step: "HEALTH_CHECK",
          level: "error",
          message: stalePending ? "Scheduled deployment watch marked stale deployment as failed after error" : "Scheduled deployment watch errored",
          metadata: { error: error instanceof Error ? error.message : String(error), stalePending } as any
        }
      });
      let autoRepair = null;
      if (stalePending || deployment.status === "FAILED") {
        const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
        const recentFailureLogs = await prisma.deploymentLog.findMany({
          where: {
            deploymentId: deployment.id,
            OR: [{ level: "error" }, { step: "FAILED" }, { step: "PREFLIGHT" }, { step: "STARTING" }, { step: "INSTALLING" }, { step: "BUILDING" }]
          },
          orderBy: { createdAt: "desc" },
          take: 12
        });
        const failureRepair = await guardianApplyFailureRepairs(deployment, deploymentFailureText(recentFailureLogs), appPath);
        if (failureRepair.identified) {
          await prisma.deploymentLog.create({
            data: {
              deploymentId: deployment.id,
              step: "PREFLIGHT",
              level: failureRepair.approvalsCreated ? "warn" : "info",
              message: "Guardian assigned failed-deploy auto-repair after watch error",
              metadata: failureRepair as any
            }
          });
        }
        autoRepair = await queueGuardianDeployRepair(
          deployment,
          "deploy",
          stalePending ? "stale deployment watch errored" : "failed deployment watch errored"
        );
      }
      results.push({ deploymentId: deployment.id, healthy: false, stalePending, autoRepair });
    }
  }
  return { checked: results.length, results };
}

async function runLaravelWorkerAutoscale() {
  const deployments = await prisma.deployment.findMany({
    where: {
      framework: "LARAVEL",
      status: { in: ["RUNNING", "DEPLOYING", "BUILDING"] }
    },
    include: { env: true },
    orderBy: { updatedAt: "desc" },
    take: 50
  });
  const results = [];
  for (const deployment of deployments) {
    const processConfig = deploymentProcessConfig(deployment.processConfig);
    const config = laravelWorkerConfig(processConfig.laravelWorkers);
    if (!config.enabled) continue;

    const appPath = deploymentAppPath(deployment.rootPath, deployment.rootDirectory);
    const status = await sysagent.deploymentLaravelWorkers({
      name: laravelWorkerProgramName(deployment.slug),
      rootPath: appPath,
      action: "status",
      desiredWorkers: config.desiredWorkers,
      queueCommand: config.queueCommand,
      logDir: deploymentLogDir(deployment.slug)
    }).catch((error) => ({ error: error instanceof Error ? error.message : String(error), status: { running: config.currentWorkers } })) as { status?: { running?: number }; runningWorkers?: number; error?: string };
    const runningWorkers = status.runningWorkers ?? status.status?.running ?? config.currentWorkers;
    let nextWorkers = config.autoscale ? Math.max(config.minWorkers, runningWorkers || config.desiredWorkers || config.minWorkers) : config.desiredWorkers;
    let reason = config.autoscale ? "steady" : "manual desired count";

    if (config.autoscale) {
      const recentLogs = await prisma.deploymentLog.findMany({
        where: { deploymentId: deployment.id, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } },
        orderBy: { createdAt: "desc" },
        take: 40
      });
      const text = recentLogs.map((log) => `${log.message}\n${metadataText(log.metadata)}`).join("\n").toLowerCase();
      const pressure = deployment.healthStatus === "DOWN"
        || deployment.healthStatus === "DEGRADED"
        || /timeout|timed out|too many connections|connection refused|queue backlog|queue busy|http 5\d\d|502|503|504|slow|overload/.test(text);
      const quietHealthy = deployment.healthStatus === "HEALTHY"
        && !pressure
        && recentLogs.every((log) => log.level !== "warn" && log.level !== "error");
      const scaledRecently = config.lastScaledAt ? Date.now() - new Date(config.lastScaledAt).getTime() < 10 * 60_000 : false;

      if (pressure) {
        nextWorkers = Math.min(config.maxWorkers, Math.max(nextWorkers + 1, config.minWorkers || 1));
        reason = `traffic/health pressure (${deployment.healthStatus})`;
      } else if (quietHealthy && !scaledRecently && nextWorkers > config.minWorkers) {
        nextWorkers = Math.max(config.minWorkers, nextWorkers - 1);
        reason = "quiet healthy cooldown";
      }
    }

    if (nextWorkers === runningWorkers && nextWorkers === config.currentWorkers && nextWorkers === config.desiredWorkers) {
      results.push({ deploymentId: deployment.id, changed: false, workers: nextWorkers, reason });
      continue;
    }

    const envVars = Object.fromEntries(deployment.env.filter((item) => item.value).map((item) => [item.key, item.value as string]));
    const apply = await sysagent.deploymentLaravelWorkers({
      name: laravelWorkerProgramName(deployment.slug),
      rootPath: appPath,
      action: nextWorkers > 0 ? "apply" : "stop",
      desiredWorkers: nextWorkers,
      queueCommand: config.queueCommand,
      env: envVars,
      logDir: deploymentLogDir(deployment.slug)
    });
    const appliedWorkers = (apply as { runningWorkers?: number; status?: { running?: number } }).runningWorkers ?? (apply as { status?: { running?: number } }).status?.running ?? nextWorkers;
    const nextConfig = {
      ...processConfig,
      laravelWorkers: {
        ...config,
        desiredWorkers: nextWorkers,
        currentWorkers: appliedWorkers,
        lastScaledAt: new Date().toISOString(),
        lastScaleReason: reason
      }
    };
    await prisma.deployment.update({ where: { id: deployment.id }, data: { processConfig: nextConfig as any } });
    await prisma.deploymentLog.create({
      data: {
        deploymentId: deployment.id,
        step: "STARTING",
        level: "info",
        message: `Guardian adjusted Laravel queue workers to ${nextWorkers}`,
        metadata: { reason, previousWorkers: runningWorkers, configuredWorkers: appliedWorkers, apply } as any
      }
    });
    results.push({ deploymentId: deployment.id, changed: true, workers: appliedWorkers, reason });
  }
  return { checked: deployments.length, results };
}

async function runDeploymentGuardWatch() {
  const deployments = await prisma.deployment.findMany({
    where: {
      framework: { in: ["LARAVEL", "NEXTJS", "NODEJS", "PYTHON", "GO"] },
      status: { in: ["STOPPED", "QUEUED"] }
    },
    take: 40,
    orderBy: { updatedAt: "desc" }
  });

  const guarded: Array<{ deploymentId: string; missingBefore: number; missingAfter: number; approvalsCreated: number }> = [];

  for (let deployment of deployments) {
    try {
      deployment = await guardianCorrectNestedDeploymentRoot(deployment);
      const detection = await detectDeploymentSource(deployment.rootPath, deployment.rootDirectory);
      const effectiveFramework = detection.detected;

      const requiredTools = requiredRuntimeExecutables({
        framework: effectiveFramework,
        packageManager: detection.suggestions.packageManager ?? deployment.packageManager ?? null,
        runtime: detection.suggestions.runtime ?? deployment.runtime ?? null,
        processManager: deployment.processManager ?? null,
        installCommand: deployment.installCommand ?? detection.suggestions.installCommand,
        buildCommand: deployment.buildCommand ?? detection.suggestions.buildCommand,
        startCommand: deployment.startCommand ?? detection.suggestions.startCommand
      });

      const toolsResult = await sysagent.deploymentRuntimeTools({ tools: requiredTools });
      let missing = toolsResult.items.filter((tool) => !tool.installed).map((tool) => tool.name);
      if (missing.length === 0) continue;
      const missingBeforeCount = missing.length;

      const installTargets = runtimeInstallTargetsForMissingExecutables(missing);
      const installFailures: Array<{ tool: string; error: string }> = [];
      for (const target of installTargets) {
        try {
          const result = await sysagent.deploymentInstallRuntimeTool({ tool: target.tool }) as { dryRun?: boolean; returncode?: number; stderr?: string; stdout?: string };
          if (result.dryRun || (typeof result.returncode === "number" && result.returncode !== 0)) {
            throw new Error(result.stderr || result.stdout || `exit ${result.returncode ?? "unknown"}`);
          }
        } catch (error) {
          installFailures.push({ tool: target.tool, error: error instanceof Error ? error.message : String(error) });
        }
      }

      const recheck = await sysagent.deploymentRuntimeTools({ tools: requiredTools });
      missing = recheck.items.filter((tool) => !tool.installed).map((tool) => tool.name);
      const approvalTargets = runtimeInstallTargetsForMissingExecutables(missing);

      let approvalsCreated = 0;
      for (const target of approvalTargets) {
        const existing = await prisma.deploymentDoctorApproval.findFirst({
          where: { deploymentId: deployment.id, actionKey: target.actionKey, status: { in: ["PENDING", "APPROVED"] } }
        });
        if (existing) continue;

        await prisma.deploymentDoctorApproval.create({
          data: {
            deploymentId: deployment.id,
            actionKey: target.actionKey,
            label: target.label,
            command: target.command,
            reason: target.reason
          }
        });
        approvalsCreated += 1;
      }

      if (installFailures.length > 0) {
        await prisma.deploymentLog.create({
          data: {
            deploymentId: deployment.id,
            step: "PREFLIGHT",
            level: "warn",
            message: "Guardian runtime auto-install could not finish all tools",
            metadata: { installFailures, missing } as any
          }
        });
      }

      guarded.push({ deploymentId: deployment.id, missingBefore: missingBeforeCount, missingAfter: missing.length, approvalsCreated });
    } catch (error) {
      logger.warn("deployment-guard-watch failed for deployment", {
        deploymentId: deployment.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { checked: deployments.length, guarded };
}

async function runSslRenewWatch() {
  const renew = await sysagent.renewAllCertificates() as { dryRun?: boolean; returncode?: number; stderr?: string; stdout?: string };
  if (renew.dryRun || renew.returncode !== 0) {
    throw new Error(`Certbot auto-renew failed${renew.returncode !== undefined ? ` with exit code ${renew.returncode}` : ""}: ${[renew.stderr, renew.stdout].filter(Boolean).join("\n").trim()}`);
  }

  const domains = await prisma.domain.findMany({
    where: { sslEnabled: true },
    select: { id: true, name: true, sslExpiry: true }
  });
  const updated = [];
  for (const domain of domains) {
    try {
      const status = await sysagent.certificateStatus(domain.name) as { exists: boolean; expiry: string | null };
      if (status.exists && status.expiry) {
        const sslExpiry = new Date(status.expiry);
        await prisma.domain.update({ where: { id: domain.id }, data: { sslExpiry } });
        updated.push({ domain: domain.name, sslExpiry });
      }
    } catch (error) {
      logger.warn("ssl renew watch failed to sync certificate status", {
        domain: domain.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { renew, checked: domains.length, updated };
}

export const guardianWorker = new Worker(
  "guardian",
  async (job) => {
    logger.info("guardian job received", { id: job.id, name: job.name });
    if (job.name === "deployment-watch") {
      const [deploymentWatch, laravelWorkers] = await Promise.all([
        runDeploymentWatch(),
        runLaravelWorkerAutoscale()
      ]);
      return { deploymentWatch, laravelWorkers };
    }
    if (job.name === "deployment-guard-watch") {
      return runDeploymentGuardWatch();
    }
    if (job.name === "deployment-auto-deploy-watch") {
      return runDeploymentAutoDeployPoll();
    }
    if (job.name === "panel-update-watch") {
      return checkPanelRemoteUpdate();
    }
    if (job.name === "ssl-renew-watch") {
      return runSslRenewWatch();
    }

    const diagnosis = await sysagent.guardianDiagnosis() as GuardianDiagnosis;
    if (diagnosis.unavailable) throw new Error("Guardian diagnosis is unavailable");

    if (job.name === "diagnose") {
      await syncGuardianIncidentsOnly(diagnosis);
      const expired = await expireGuardianIpBlocks();
      return { incidents: diagnosis.incidents?.length ?? 0, expiredBlocks: expired.length };
    }

    if (job.name === "auto-heal") {
      const [healing, expired] = await Promise.all([
        runGuardianAutoHeal(diagnosis),
        expireGuardianIpBlocks()
      ]);
      return { ...healing, expiredBlocks: expired.length };
    }

    throw new Error(`Unknown guardian job: ${job.name}`);
  },
  { connection: redis }
);
