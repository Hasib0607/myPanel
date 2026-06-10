import { logger } from "./lib/logger.js";
import { guardianQueue } from "./jobs/queues.js";

const intervalMs = Number(process.env.GUARDIAN_INTERVAL_MS ?? 60_000);
const deploymentDoctorIntervalMs = Number(process.env.GUARDIAN_DEPLOYMENT_DOCTOR_INTERVAL_MS ?? 5 * 60_000);
const deploymentGuardIntervalMs = Number(process.env.GUARDIAN_DEPLOYMENT_GUARD_INTERVAL_MS ?? 10 * 60_000);
const webRuntimeIntervalMs = Number(process.env.GUARDIAN_WEB_RUNTIME_INTERVAL_MS ?? 5 * 60_000);
const laravelProductionIntervalMs = Number(process.env.GUARDIAN_LARAVEL_PRODUCTION_INTERVAL_MS ?? 5 * 60_000);
const autoDeployPollIntervalMs = Number(process.env.GUARDIAN_AUTO_DEPLOY_POLL_INTERVAL_MS ?? 60_000);
const panelUpdatePollIntervalMs = Number(process.env.PANEL_UPDATE_POLL_INTERVAL_MS ?? 60_000);
const sslRenewIntervalMs = Number(process.env.GUARDIAN_SSL_RENEW_INTERVAL_MS ?? 12 * 60 * 60_000);
const autoHealEnabled = process.env.GUARDIAN_AUTO_HEAL === "true";
const autoDeployPollEnabled = process.env.GUARDIAN_AUTO_DEPLOY_POLL_ENABLED !== "false";
const panelUpdatePollEnabled = process.env.PANEL_UPDATE_POLL_ENABLED !== "false";
const sslRenewEnabled = process.env.GUARDIAN_SSL_RENEW_ENABLED !== "false";

async function scheduleGuardian() {
  try {
    const name = autoHealEnabled ? "auto-heal" : "diagnose";
    await guardianQueue.add(name, {}, {
      jobId: `guardian-${name}`,
      repeat: { every: intervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    await guardianQueue.add("deployment-watch", {}, {
      jobId: "guardian-deployment-watch",
      repeat: { every: deploymentDoctorIntervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    await guardianQueue.add("deployment-guard-watch", {}, {
      jobId: "guardian-deployment-guard-watch",
      repeat: { every: deploymentGuardIntervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    await guardianQueue.add("web-runtime-watch", {}, {
      jobId: "guardian-web-runtime-watch",
      repeat: { every: webRuntimeIntervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    await guardianQueue.add("laravel-production-watch", {}, {
      jobId: "guardian-laravel-production-watch",
      repeat: { every: laravelProductionIntervalMs },
      removeOnComplete: 100,
      removeOnFail: 100
    });
    if (autoDeployPollEnabled) {
      await guardianQueue.add("deployment-auto-deploy-watch", {}, {
        jobId: "guardian-deployment-auto-deploy-watch",
        repeat: { every: autoDeployPollIntervalMs },
        removeOnComplete: 100,
        removeOnFail: 100
      });
    }
    if (panelUpdatePollEnabled) {
      await guardianQueue.add("panel-update-watch", {}, {
        jobId: "guardian-panel-update-watch",
        repeat: { every: panelUpdatePollIntervalMs },
        removeOnComplete: 100,
        removeOnFail: 100
      });
    }
    if (sslRenewEnabled) {
      await guardianQueue.add("ssl-renew-watch", {}, {
        jobId: "guardian-ssl-renew-watch",
        repeat: { every: sslRenewIntervalMs },
        removeOnComplete: 100,
        removeOnFail: 100
      });
    }
    logger.info("guardian repeat job scheduled", {
      name,
      autoHealEnabled,
      intervalMs,
      deploymentDoctorIntervalMs,
      webRuntimeIntervalMs,
      laravelProductionIntervalMs,
      autoDeployPollEnabled,
      autoDeployPollIntervalMs,
      panelUpdatePollEnabled,
      panelUpdatePollIntervalMs,
      sslRenewEnabled,
      sslRenewIntervalMs
    });
  } catch (error) {
    logger.warn("guardian repeat schedule failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

await scheduleGuardian();
