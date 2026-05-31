import { logger } from "./lib/logger.js";
import { sysagent } from "./lib/sysagent.js";

const intervalMs = Number(process.env.GUARDIAN_INTERVAL_MS ?? 60_000);
const autoHealEnabled = process.env.GUARDIAN_AUTO_HEAL === "true";
const safeRestartServices = new Set(["nginx", "panel-api", "panel-frontend", "panel-workers"]);

type GuardianDiagnosis = {
  incidents?: unknown[];
  generatedAt?: string;
  services?: Array<{ key: string; status: string; optional?: boolean }>;
  pm2?: { items?: Array<{ name: string; pmId?: number; healthy: boolean }> };
  logs?: { nginxErrors?: number; badHttpResponses?: number };
};

async function runSafeAutoHeal(diagnosis: GuardianDiagnosis) {
  const actions = [];
  for (const service of diagnosis.services ?? []) {
    if (service.status !== "down" || service.optional || !safeRestartServices.has(service.key)) continue;
    actions.push(await sysagent.guardianRestartService(service.key));
  }
  for (const app of diagnosis.pm2?.items ?? []) {
    if (app.healthy) continue;
    actions.push(await sysagent.guardianRestartPm2(app.pmId !== undefined ? { pmId: app.pmId } : { name: app.name }));
  }
  if ((diagnosis.logs?.nginxErrors ?? 0) > 0 || (diagnosis.logs?.badHttpResponses ?? 0) > 10) {
    actions.push(await sysagent.guardianReloadNginx());
  }
  actions.push(await sysagent.guardianCleanupLogs(1));
  return actions;
}

async function runDiagnosis() {
  try {
    const diagnosis = await sysagent.guardianDiagnosis() as GuardianDiagnosis;
    const actions = autoHealEnabled ? await runSafeAutoHeal(diagnosis) : [];
    logger.info("guardian diagnosis completed", {
      generatedAt: diagnosis.generatedAt,
      incidents: diagnosis.incidents?.length ?? 0,
      autoHealEnabled,
      actions: actions.length
    });
  } catch (error) {
    logger.warn("guardian diagnosis failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

await runDiagnosis();
setInterval(runDiagnosis, intervalMs);
