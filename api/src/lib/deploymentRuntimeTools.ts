import type { DeploymentFramework, DeploymentPackageManager, DeploymentProcessManager, DeploymentRuntime } from "@prisma/client";

type RuntimeToolInput = {
  framework: DeploymentFramework;
  packageManager: DeploymentPackageManager | null;
  runtime: DeploymentRuntime | null;
  processManager: DeploymentProcessManager | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
};

export type RuntimeInstallTarget = {
  actionKey: string;
  tool: "composer" | "php" | "nodejs" | "pnpm" | "yarn" | "uv" | "go" | "supervisor" | "pm2";
  label: string;
  command: string;
  reason: string;
  executables: string[];
};

function firstExecutable(command: string | null | undefined) {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  const token = trimmed.split(/\s+/)[0]?.trim();
  return token || null;
}

function executablesForCommand(command: string | null | undefined) {
  const executable = firstExecutable(command);
  if (!executable) return [];
  if (executable === "npm" || executable === "npx") return ["node", "npm"];
  if (executable === "pnpm") return ["node", "pnpm"];
  if (executable === "yarn") return ["node", "yarn"];
  if (executable === "composer") return ["php", "composer"];
  if (executable === "php" || executable === "php-fpm") return ["php"];
  if (executable === "python" || executable === "python3" || executable === "pip" || executable === "pip3" || executable === "uvicorn") return ["python3"];
  if (executable === "uv") return ["python3", "uv"];
  if (executable === "go") return ["go"];
  if (executable === "pm2") return ["node", "pm2"];
  if (executable === "supervisorctl") return ["supervisorctl"];
  return [executable];
}

export function requiredRuntimeExecutables(input: RuntimeToolInput) {
  const tools = new Set<string>();

  if (input.packageManager === "NPM") {
    tools.add("node");
    tools.add("npm");
  }
  if (input.packageManager === "PNPM") {
    tools.add("node");
    tools.add("pnpm");
  }
  if (input.packageManager === "YARN") {
    tools.add("node");
    tools.add("yarn");
  }
  if (input.packageManager === "COMPOSER") {
    tools.add("php");
    tools.add("composer");
  }
  if (input.packageManager === "PIP") tools.add("python3");
  if (input.packageManager === "UV") {
    tools.add("python3");
    tools.add("uv");
  }
  if (input.packageManager === "GO") tools.add("go");

  if (input.runtime === "NODE") tools.add("node");
  if (input.runtime === "PHP") tools.add("php");
  if (input.runtime === "PYTHON") tools.add("python3");
  if (input.runtime === "GO") tools.add("go");

  if ((input.processManager ?? (input.framework === "LARAVEL" || input.framework === "PYTHON" || input.framework === "GO" ? "SUPERVISOR" : input.framework === "STATIC" ? "STATIC" : "PM2")) === "PM2") {
    tools.add("pm2");
  }
  if ((input.processManager ?? (input.framework === "LARAVEL" || input.framework === "PYTHON" || input.framework === "GO" ? "SUPERVISOR" : input.framework === "STATIC" ? "STATIC" : "PM2")) === "SUPERVISOR") {
    tools.add("supervisorctl");
  }

  if (input.framework === "LARAVEL") {
    tools.add("php");
    tools.add("composer");
    tools.add("supervisorctl");
  }

  for (const executable of [
    ...executablesForCommand(input.installCommand),
    ...executablesForCommand(input.buildCommand),
    ...executablesForCommand(input.startCommand)
  ]) {
    tools.add(executable);
  }

  return [...tools];
}

const installTargetCatalog: RuntimeInstallTarget[] = [
  {
    actionKey: "install-composer",
    tool: "composer",
    label: "Install Composer",
    command: "Install Composer via panel runtime-tools",
    reason: "Composer is required for Laravel/PHP dependency installs.",
    executables: ["composer"]
  },
  {
    actionKey: "install-php",
    tool: "php",
    label: "Install PHP runtime",
    command: "Install PHP, php-fpm, and common Laravel extensions via panel runtime-tools",
    reason: "PHP runtime and php-fpm are required for Laravel apps.",
    executables: ["php"]
  },
  {
    actionKey: "install-nodejs",
    tool: "nodejs",
    label: "Install Node.js + npm",
    command: "Install Node.js and npm via panel runtime-tools",
    reason: "Node.js tooling is required for npm/npx-based asset builds.",
    executables: ["node", "npm"]
  },
  {
    actionKey: "install-pnpm",
    tool: "pnpm",
    label: "Install pnpm",
    command: "Install pnpm globally via npm",
    reason: "pnpm is required by this deployment.",
    executables: ["pnpm"]
  },
  {
    actionKey: "install-yarn",
    tool: "yarn",
    label: "Install Yarn",
    command: "Install Yarn globally via npm",
    reason: "Yarn is required by this deployment.",
    executables: ["yarn"]
  },
  {
    actionKey: "install-uv",
    tool: "uv",
    label: "Install uv",
    command: "Install uv via pip3",
    reason: "uv is required by this Python deployment.",
    executables: ["uv"]
  },
  {
    actionKey: "install-go",
    tool: "go",
    label: "Install Go",
    command: "Install Go via panel runtime-tools",
    reason: "Go toolchain is required by this deployment.",
    executables: ["go"]
  },
  {
    actionKey: "install-supervisor",
    tool: "supervisor",
    label: "Install Supervisor",
    command: "Install Supervisor via panel runtime-tools",
    reason: "Supervisor is required for this deployment process manager.",
    executables: ["supervisorctl"]
  },
  {
    actionKey: "install-pm2",
    tool: "pm2",
    label: "Install PM2",
    command: "Install PM2 globally via npm",
    reason: "PM2 is required for this deployment process manager.",
    executables: ["pm2"]
  }
];

export function runtimeInstallTargetsForMissingExecutables(missingExecutables: string[]) {
  const missing = new Set(missingExecutables);
  return installTargetCatalog.filter((target) => target.executables.some((executable) => missing.has(executable)));
}
