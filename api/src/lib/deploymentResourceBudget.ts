export type DeployMemoryBudgetInput = {
  totalMemoryMb: number;
  availableMemoryMb: number;
  runningAppsMemoryMb: number;
  systemReserveMb: number;
  minAppReserveMb: number;
  appReserveMultiplier: number;
  minDeployMemoryMb: number;
  maxDeployMemoryMb: number;
  fallbackMemoryMb: number;
};

export type DeployMemoryBudget = {
  appReserveMb: number;
  budgetByTotal: number;
  budgetByAvailable: number;
  rawDeployMemoryMb: number;
  deployMemoryMb: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function calculateDeployMemoryBudget(input: DeployMemoryBudgetInput): DeployMemoryBudget {
  const appReserveMb = Math.max(
    input.minAppReserveMb,
    Math.ceil(input.runningAppsMemoryMb * input.appReserveMultiplier)
  );
  const budgetByTotal = input.totalMemoryMb > 0
    ? input.totalMemoryMb - appReserveMb - input.systemReserveMb
    : input.fallbackMemoryMb;
  const budgetByAvailable = input.availableMemoryMb > 0
    ? input.availableMemoryMb - input.systemReserveMb
    : budgetByTotal;

  // runningAppsMemoryMb is already reflected in available memory. The app reserve
  // multiplier projects future growth, so do not let that projection reduce a
  // deploy below its configured minimum while the OS has enough available memory.
  const totalBudgetWithSafeFloor = budgetByAvailable >= input.minDeployMemoryMb
    ? Math.max(budgetByTotal, input.minDeployMemoryMb)
    : budgetByTotal;
  const rawDeployMemoryMb = Math.min(totalBudgetWithSafeFloor, budgetByAvailable);
  const deployMemoryMb = rawDeployMemoryMb >= input.minDeployMemoryMb
    ? clamp(Math.floor(rawDeployMemoryMb), input.minDeployMemoryMb, input.maxDeployMemoryMb)
    : Math.max(1536, Math.floor(rawDeployMemoryMb || input.fallbackMemoryMb));

  return {
    appReserveMb,
    budgetByTotal,
    budgetByAvailable,
    rawDeployMemoryMb,
    deployMemoryMb
  };
}
