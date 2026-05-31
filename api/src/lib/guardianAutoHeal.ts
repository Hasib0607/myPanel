import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { sysagent } from "./sysagent.js";

const safeRestartServices = new Set(["nginx", "panel-api", "panel-frontend", "panel-workers"]);
const cooldownMs = Number(process.env.GUARDIAN_ACTION_COOLDOWN_MS ?? 10 * 60_000);
const maxRetries = Number(process.env.GUARDIAN_MAX_RETRIES ?? 3);

type GuardianIncidentInput = {
  severity?: string;
  category?: string;
  title?: string;
  detail?: string;
  safeAction?: string;
};

export type GuardianDiagnosis = {
  unavailable?: true;
  incidents?: GuardianIncidentInput[];
  services?: Array<{ key: string; name: string; status: string; optional?: boolean }>;
  pm2?: { items?: Array<{ name: string; pmId?: number; status: string; healthy: boolean }> };
  logs?: { nginxErrors?: number; badHttpResponses?: number };
};

function severity(value: string | undefined) {
  if (value === "critical") return "CRITICAL";
  if (value === "info") return "INFO";
  return "WARNING";
}

function fingerprint(input: GuardianIncidentInput) {
  return createHash("sha256")
    .update([input.category ?? "unknown", input.title ?? "", input.detail ?? ""].join("|"))
    .digest("hex")
    .slice(0, 32);
}

async function syncIncidents(diagnosis: GuardianDiagnosis) {
  const active = diagnosis.incidents ?? [];
  const activeFingerprints = new Set<string>();
  const records = new Map<string, { id: string }>();

  for (const incident of active) {
    const fp = fingerprint(incident);
    activeFingerprints.add(fp);
    const record = await prisma.guardianIncident.upsert({
      where: { fingerprint: fp },
      update: {
        category: incident.category ?? "unknown",
        title: incident.title ?? "Guardian incident",
        detail: incident.detail ?? "",
        severity: severity(incident.severity) as any,
        status: "OPEN",
        lastSeenAt: new Date(),
        resolvedAt: null,
        metadata: { safeAction: incident.safeAction ?? null } as Prisma.InputJsonObject
      },
      create: {
        fingerprint: fp,
        category: incident.category ?? "unknown",
        title: incident.title ?? "Guardian incident",
        detail: incident.detail ?? "",
        severity: severity(incident.severity) as any,
        metadata: { safeAction: incident.safeAction ?? null } as Prisma.InputJsonObject
      },
      select: { id: true }
    });
    records.set(fp, record);
  }

  await prisma.guardianIncident.updateMany({
    where: {
      status: "OPEN",
      fingerprint: { notIn: [...activeFingerprints] }
    },
    data: {
      status: "RESOLVED",
      resolvedAt: new Date()
    }
  });

  return records;
}

async function recentAction(action: string, target: string) {
  return prisma.guardianAction.findFirst({
    where: { action, target, createdAt: { gte: new Date(Date.now() - cooldownMs) } },
    orderBy: { createdAt: "desc" }
  });
}

async function actionCount(action: string, target: string) {
  return prisma.guardianAction.count({
    where: { action, target, createdAt: { gte: new Date(Date.now() - 60 * 60_000) }, status: { in: ["SUCCEEDED", "FAILED"] } }
  });
}

async function recordAction(input: {
  incidentId?: string | null;
  action: string;
  target: string;
  status: "SKIPPED" | "SUCCEEDED" | "FAILED";
  reason?: string;
  result?: unknown;
  retryCount?: number;
}) {
  return prisma.guardianAction.create({
    data: {
      incidentId: input.incidentId ?? null,
      action: input.action,
      target: input.target,
      status: input.status,
      reason: input.reason,
      result: (input.result ?? {}) as Prisma.InputJsonValue,
      retryCount: input.retryCount ?? 0
    }
  });
}

async function guardedAction(action: string, target: string, incidentId: string | null, fn: () => Promise<unknown>) {
  const recent = await recentAction(action, target);
  if (recent) {
    return recordAction({ incidentId, action, target, status: "SKIPPED", reason: `cooldown active until ${new Date(recent.createdAt.getTime() + cooldownMs).toISOString()}` });
  }

  const retries = await actionCount(action, target);
  if (retries >= maxRetries) {
    return recordAction({ incidentId, action, target, status: "SKIPPED", reason: `max retry limit reached (${maxRetries}/hour)`, retryCount: retries });
  }

  try {
    const result = await fn();
    const failed = typeof result === "object" && result !== null && JSON.stringify(result).includes('"returncode":');
    const hasBadReturn = failed && /"returncode":(?!0\b)\d+/.test(JSON.stringify(result));
    return recordAction({ incidentId, action, target, status: hasBadReturn ? "FAILED" : "SUCCEEDED", result, retryCount: retries + 1 });
  } catch (error) {
    return recordAction({ incidentId, action, target, status: "FAILED", reason: error instanceof Error ? error.message : String(error), retryCount: retries + 1 });
  }
}

function incidentFor(records: Map<string, { id: string }>, input: GuardianIncidentInput) {
  return records.get(fingerprint(input))?.id ?? null;
}

export async function runGuardianAutoHeal(diagnosis: GuardianDiagnosis) {
  const records = await syncIncidents(diagnosis);
  const actions = [];

  for (const service of diagnosis.services ?? []) {
    if (service.status !== "down" || service.optional) continue;
    const incident = (diagnosis.incidents ?? []).find((item) => item.category === "service" && item.title?.includes(service.name));
    const incidentId = incident ? incidentFor(records, incident) : null;
    if (!safeRestartServices.has(service.key)) {
      actions.push(await recordAction({ incidentId, action: "restart-service", target: service.key, status: "SKIPPED", reason: "not in safe restart allowlist" }));
      continue;
    }
    actions.push(await guardedAction("restart-service", service.key, incidentId, async () => {
      const restart = await sysagent.guardianRestartService(service.key);
      const recheck = await sysagent.guardianDiagnosis();
      return { restart, recheck };
    }));
  }

  for (const app of diagnosis.pm2?.items ?? []) {
    if (app.healthy) continue;
    const incident = (diagnosis.incidents ?? []).find((item) => item.category === "pm2" && item.title?.includes(app.name));
    actions.push(await guardedAction("restart-pm2", app.pmId !== undefined ? String(app.pmId) : app.name, incident ? incidentFor(records, incident) : null, async () => {
      const restart = await sysagent.guardianRestartPm2(app.pmId !== undefined ? { pmId: app.pmId } : { name: app.name });
      const recheck = await sysagent.guardianDiagnosis();
      return { restart, recheck };
    }));
  }

  if ((diagnosis.logs?.nginxErrors ?? 0) > 0 || (diagnosis.logs?.badHttpResponses ?? 0) > 10) {
    const incident = (diagnosis.incidents ?? []).find((item) => item.category === "nginx");
    actions.push(await guardedAction("reload-nginx", "nginx", incident ? incidentFor(records, incident) : null, async () => sysagent.guardianReloadNginx()));
  }

  actions.push(await guardedAction("cleanup-logs", "deployment-logs", null, async () => sysagent.guardianCleanupLogs(1)));
  return { actions };
}

export async function syncGuardianIncidentsOnly(diagnosis: GuardianDiagnosis) {
  return syncIncidents(diagnosis);
}
