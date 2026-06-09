export type DeploymentPriorityTier = "P1" | "P2" | "P3";

export type DeploymentResourcePolicy = {
  priorityTier: DeploymentPriorityTier;
  memoryMaxMb: number;
  cpuQuotaPercent: number;
  workersMax: number;
  restartDelayMs: number;
  healthStrict: boolean;
};

export const deploymentPriorityDefaults: Record<DeploymentPriorityTier, DeploymentResourcePolicy> = {
  P1: { priorityTier: "P1", memoryMaxMb: 6144, cpuQuotaPercent: 400, workersMax: 5, restartDelayMs: 1000, healthStrict: true },
  P2: { priorityTier: "P2", memoryMaxMb: 2048, cpuQuotaPercent: 200, workersMax: 2, restartDelayMs: 3000, healthStrict: false },
  P3: { priorityTier: "P3", memoryMaxMb: 1024, cpuQuotaPercent: 100, workersMax: 1, restartDelayMs: 8000, healthStrict: false }
};

function numberInRange(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function normalizeDeploymentResourcePolicy(processConfig: unknown): DeploymentResourcePolicy {
  const rawConfig = processConfig && typeof processConfig === "object" && !Array.isArray(processConfig) ? processConfig as Record<string, unknown> : {};
  const rawPolicy = rawConfig.resourcePolicy && typeof rawConfig.resourcePolicy === "object" && !Array.isArray(rawConfig.resourcePolicy)
    ? rawConfig.resourcePolicy as Record<string, unknown>
    : {};
  const tier = rawPolicy.priorityTier === "P1" || rawPolicy.priorityTier === "P3" ? rawPolicy.priorityTier : "P2";
  const defaults = deploymentPriorityDefaults[tier];
  return {
    priorityTier: tier,
    memoryMaxMb: numberInRange(rawPolicy.memoryMaxMb, defaults.memoryMaxMb, 256, 16384),
    cpuQuotaPercent: numberInRange(rawPolicy.cpuQuotaPercent, defaults.cpuQuotaPercent, 25, 1600),
    workersMax: numberInRange(rawPolicy.workersMax, defaults.workersMax, 0, 16),
    restartDelayMs: numberInRange(rawPolicy.restartDelayMs, defaults.restartDelayMs, 500, 60000),
    healthStrict: typeof rawPolicy.healthStrict === "boolean" ? rawPolicy.healthStrict : defaults.healthStrict
  };
}

export function processConfigWithResourcePolicy(processConfig: unknown, patch: Partial<DeploymentResourcePolicy>) {
  const rawConfig = processConfig && typeof processConfig === "object" && !Array.isArray(processConfig) ? processConfig as Record<string, unknown> : {};
  const current = normalizeDeploymentResourcePolicy(rawConfig);
  return {
    ...rawConfig,
    resourcePolicy: {
      ...current,
      ...patch
    }
  };
}
