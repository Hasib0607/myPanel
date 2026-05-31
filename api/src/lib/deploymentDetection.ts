import fs from "node:fs/promises";
import path from "node:path";
import {
  DeploymentFramework,
  DeploymentPackageManager,
  DeploymentProcessManager,
  DeploymentRuntime
} from "@prisma/client";

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
};

export type DetectionSuggestion = {
  runtime: DeploymentRuntime | null;
  packageManager: DeploymentPackageManager | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  processManager: DeploymentProcessManager | null;
};

export type DeploymentDetection = {
  detected: DeploymentFramework;
  confidence: number;
  reason: string;
  rootPath?: string;
  files?: string[];
  suggestions: DetectionSuggestion;
};

const staticSuggestion: DetectionSuggestion = {
  runtime: "STATIC",
  packageManager: "NONE",
  installCommand: null,
  buildCommand: null,
  startCommand: null,
  outputDirectory: ".",
  processManager: "STATIC"
};

function packageManagerFor(files: Set<string>): DeploymentPackageManager {
  if (files.has("pnpm-lock.yaml")) return "PNPM";
  if (files.has("yarn.lock")) return "YARN";
  return "NPM";
}

function packageRun(packageManager: DeploymentPackageManager, script: string) {
  if (packageManager === "PNPM") return `pnpm run ${script}`;
  if (packageManager === "YARN") return `yarn ${script}`;
  return `npm run ${script}`;
}

function packageInstall(packageManager: DeploymentPackageManager) {
  if (packageManager === "PNPM") return "pnpm install";
  if (packageManager === "YARN") return "yarn install";
  return "npm install";
}

function hasDependency(pkg: PackageJson, name: string) {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function readPackageJson(raw: string | null | undefined): PackageJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function detectDeploymentFiles(files: string[], packageJsonText?: string | null): DeploymentDetection {
  const names = new Set(files.map((file) => file.toLowerCase()));
  const packageManager = packageManagerFor(names);
  const pkg = readPackageJson(packageJsonText);
  const scripts = pkg?.scripts ?? {};
  const hasScript = (name: string) => Boolean(scripts[name]);

  if (names.has("artisan") || names.has("composer.json")) {
    return {
      detected: "LARAVEL",
      confidence: 0.9,
      reason: "Found Laravel/PHP markers",
      files,
      suggestions: {
        runtime: "PHP",
        packageManager: "COMPOSER",
        installCommand: "composer install --no-dev --optimize-autoloader --no-interaction --no-scripts",
        buildCommand: null,
        startCommand: "php-fpm",
        outputDirectory: "public",
        processManager: "SUPERVISOR"
      }
    };
  }

  const nextDetected = names.has("next.config.js") || names.has("next.config.mjs") || names.has("next.config.ts") || (pkg ? hasDependency(pkg, "next") : false);
  if (nextDetected) {
    return {
      detected: "NEXTJS",
      confidence: names.has("next.config.js") || names.has("next.config.mjs") || names.has("next.config.ts") ? 0.98 : 0.9,
      reason: "Found Next.js markers",
      files,
      suggestions: {
        runtime: "NODE",
        packageManager,
        installCommand: packageInstall(packageManager),
        buildCommand: hasScript("build") ? packageRun(packageManager, "build") : null,
        startCommand: "npx next start -p {PORT} -H 127.0.0.1",
        outputDirectory: ".next",
        processManager: "PM2"
      }
    };
  }

  const viteDetected = names.has("vite.config.js") || names.has("vite.config.ts") || names.has("vite.config.mjs") || (pkg ? hasDependency(pkg, "vite") : false);
  if (viteDetected) {
    return {
      detected: "NODEJS",
      confidence: 0.9,
      reason: "Found Vite markers",
      files,
      suggestions: {
        runtime: "NODE",
        packageManager,
        installCommand: packageInstall(packageManager),
        buildCommand: hasScript("build") ? packageRun(packageManager, "build") : null,
        startCommand: hasScript("preview") ? `${packageRun(packageManager, "preview")} -- --host 127.0.0.1 --port {PORT}` : "npx serve -s dist -l {PORT}",
        outputDirectory: "dist",
        processManager: "PM2"
      }
    };
  }

  if (pkg) {
    const startCommand = hasScript("start") ? packageRun(packageManager, "start") : pkg.main ? `node ${pkg.main}` : null;
    return {
      detected: "NODEJS",
      confidence: startCommand ? 0.8 : 0.55,
      reason: startCommand ? "Found package.json with a runnable Node command" : "Found package.json but no start script or main entry",
      files,
      suggestions: {
        runtime: "NODE",
        packageManager,
        installCommand: packageInstall(packageManager),
        buildCommand: hasScript("build") ? packageRun(packageManager, "build") : null,
        startCommand,
        outputDirectory: hasScript("build") ? "dist" : null,
        processManager: startCommand ? "PM2" : "NONE"
      }
    };
  }

  if (names.has("requirements.txt") || names.has("pyproject.toml") || names.has("manage.py")) {
    return {
      detected: "PYTHON",
      confidence: 0.82,
      reason: "Found Python markers",
      files,
      suggestions: {
        runtime: "PYTHON",
        packageManager: names.has("pyproject.toml") ? "UV" : "PIP",
        installCommand: names.has("pyproject.toml") ? "uv sync" : "pip3 install -r requirements.txt",
        buildCommand: null,
        startCommand: names.has("manage.py") ? "python3 manage.py runserver 127.0.0.1:{PORT}" : "uvicorn app.main:app --host 127.0.0.1 --port {PORT}",
        outputDirectory: null,
        processManager: "SUPERVISOR"
      }
    };
  }

  if (names.has("go.mod")) {
    return {
      detected: "GO",
      confidence: 0.9,
      reason: "Found Go module",
      files,
      suggestions: {
        runtime: "GO",
        packageManager: "GO",
        installCommand: "go mod download",
        buildCommand: "go build -o app",
        startCommand: "./app",
        outputDirectory: ".",
        processManager: "SUPERVISOR"
      }
    };
  }

  if (names.has("index.html")) {
    return { detected: "STATIC", confidence: 0.88, reason: "Found static index.html", files, suggestions: staticSuggestion };
  }

  return {
    detected: "STATIC",
    confidence: 0.25,
    reason: "No known runtime markers found",
    files,
    suggestions: staticSuggestion
  };
}

export async function detectDeploymentSource(rootPath: string, rootDirectory = "."): Promise<DeploymentDetection> {
  const sourceRoot = path.resolve(rootPath, rootDirectory || ".");
  const files = await fs.readdir(sourceRoot);
  const packageJson = await readTextIfExists(path.join(sourceRoot, "package.json"));
  return { ...(detectDeploymentFiles(files, packageJson)), rootPath: sourceRoot };
}
