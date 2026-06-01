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
  tool: "composer" | "php" | "php82" | "php-gd" | "php-soap" | "python" | "nodejs" | "pnpm" | "yarn" | "uv" | "go" | "supervisor" | "pm2";
  label: string;
  command: string;
  reason: string;
  executables: string[];
};

export type ComposerPlatformIssue = {
  requiredPhpVersion: string | null;
  currentPhpVersion: string | null;
  missingExtensions: string[];
  composerRootWarning: boolean;
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
  if (executable === "next" || executable === "vite" || executable === "react-scripts") return ["node", "npm"];
  if (executable === "pnpm") return ["node", "pnpm"];
  if (executable === "yarn") return ["node", "yarn"];
  if (executable === "composer") return ["php", "composer"];
  if (executable === "php" || executable === "php-fpm") return ["php"];
  if (executable === "python" || executable === "python3" || executable === "uvicorn" || executable === "gunicorn" || executable === "flask") return ["python3"];
  if (executable === "pip" || executable === "pip3") return ["python3", "pip3"];
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
  if (input.packageManager === "PIP") {
    tools.add("python3");
    tools.add("pip3");
  }
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
    actionKey: "install-php82",
    tool: "php82",
    label: "Upgrade PHP runtime to 8.2",
    command: "Install PHP 8.2 runtime, common Laravel extensions, and switch the CLI default to php8.2",
    reason: "Composer reported that the project lockfile requires PHP 8.2 or newer.",
    executables: ["php"]
  },
  {
    actionKey: "install-php-gd",
    tool: "php-gd",
    label: "Install PHP GD extension",
    command: "Install the PHP GD extension via panel runtime-tools",
    reason: "Composer reported that the GD extension is required by this deployment.",
    executables: ["php"]
  },
  {
    actionKey: "install-php-soap",
    tool: "php-soap",
    label: "Install PHP SOAP extension",
    command: "Install the PHP SOAP extension via panel runtime-tools",
    reason: "Composer reported that the SOAP extension is required by this deployment.",
    executables: ["php"]
  },
  {
    actionKey: "install-python",
    tool: "python",
    label: "Install Python runtime",
    command: "Install Python 3 and pip via panel runtime-tools",
    reason: "Python 3 and pip are required for this deployment.",
    executables: ["python3", "pip3"]
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

function compareMajorMinorVersions(left: string, right: string) {
  const [leftMajor = "0", leftMinor = "0"] = left.split(".");
  const [rightMajor = "0", rightMinor = "0"] = right.split(".");
  const majorDelta = Number(leftMajor) - Number(rightMajor);
  if (majorDelta !== 0) return majorDelta;
  return Number(leftMinor) - Number(rightMinor);
}

export function detectComposerPlatformIssue(text: string): ComposerPlatformIssue | null {
  const requiredPhpVersion = text.match(/requires php(?:-[a-z0-9]+)?\s*(?:\^|>=|>|~)?\s*([0-9]+\.[0-9]+)/i)?.[1] ?? null;
  const currentPhpVersion = text.match(/your php(?:-[a-z0-9]+)? version \(([\d.]+)\)/i)?.[1] ?? null;
  const missingExtensions = [...text.matchAll(/requires ext-([a-z0-9_]+)/ig)].map((match) => match[1].toLowerCase());
  const composerRootWarning = /do not run composer as root\/super user/i.test(text);

  if (!requiredPhpVersion && !currentPhpVersion && missingExtensions.length === 0 && !composerRootWarning) return null;
  return {
    requiredPhpVersion,
    currentPhpVersion,
    missingExtensions: [...new Set(missingExtensions)],
    composerRootWarning
  };
}

export function runtimeInstallTargetsForComposerPlatformIssue(text: string) {
  const issue = detectComposerPlatformIssue(text);
  if (!issue) return [];

  const targets: RuntimeInstallTarget[] = [];
  const addTarget = (actionKey: RuntimeInstallTarget["actionKey"]) => {
    const target = installTargetCatalog.find((item) => item.actionKey === actionKey);
    if (target && !targets.some((item) => item.actionKey === target.actionKey)) targets.push(target);
  };

  if (issue.requiredPhpVersion) {
    const needsUpgrade = !issue.currentPhpVersion || compareMajorMinorVersions(issue.currentPhpVersion, issue.requiredPhpVersion) < 0;
    if (needsUpgrade && compareMajorMinorVersions(issue.requiredPhpVersion, "8.2") >= 0) {
      addTarget("install-php82");
    }
  }

  if (issue.missingExtensions.includes("gd")) {
    addTarget(targets.some((item) => item.actionKey === "install-php82") ? "install-php82" : "install-php-gd");
  }
  if (issue.missingExtensions.includes("soap")) {
    addTarget(targets.some((item) => item.actionKey === "install-php82") ? "install-php82" : "install-php-soap");
  }

  return targets;
}
