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

type ComposerJson = {
  require?: Record<string, string>;
  "require-dev"?: Record<string, string>;
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

function hasScript(pkg: PackageJson, name: string) {
  return Boolean(pkg.scripts?.[name]);
}

function readPackageJson(raw: string | null | undefined): PackageJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function readComposerJson(raw: string | null | undefined): ComposerJson | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ComposerJson;
  } catch {
    return null;
  }
}

function isLaravelComposerPackage(composer: ComposerJson | null) {
  if (!composer) return false;
  const requirements = { ...composer.require, ...composer["require-dev"] };
  return Boolean(
    requirements["laravel/framework"]
      || requirements["laravel/lumen-framework"]
      || requirements["illuminate/support"]
  );
}

function isNodeFrontendPackage(pkg: PackageJson) {
  return (
    hasDependency(pkg, "react")
    || hasDependency(pkg, "react-dom")
    || hasDependency(pkg, "vite")
    || hasDependency(pkg, "next")
    || hasDependency(pkg, "@vitejs/plugin-react")
    || hasDependency(pkg, "react-scripts")
  );
}

function resolveNodeStartCommand(
  packageManager: DeploymentPackageManager,
  pkg: PackageJson,
  outputDirectory: string | null,
  options?: { vite?: boolean; cra?: boolean }
) {
  const scripts = pkg.scripts ?? {};
  const run = (script: string) => packageRun(packageManager, script);

  if (scripts.start) {
    return run("start");
  }
  if (pkg.main) {
    return `node ${pkg.main}`;
  }
  if (scripts.preview) {
    return `${run("preview")} -- --host 127.0.0.1 --port {PORT}`;
  }
  if (options?.vite || scripts.build) {
    const output = outputDirectory || (options?.cra ? "build" : "dist");
    return `npx serve -s ${output} -l {PORT}`;
  }
  return null;
}

function nodeJsDetection(
  files: string[],
  names: Set<string>,
  packageManager: DeploymentPackageManager,
  pkg: PackageJson,
  reason: string,
  confidence: number,
  outputDirectory: string | null,
  options?: { vite?: boolean; cra?: boolean }
): DeploymentDetection {
  const scripts = pkg.scripts ?? {};
  const hasScriptName = (name: string) => Boolean(scripts[name]);
  const startCommand = resolveNodeStartCommand(packageManager, pkg, outputDirectory, options);

  return {
    detected: "NODEJS",
    confidence,
    reason,
    files,
    suggestions: {
      runtime: "NODE",
      packageManager,
      installCommand: packageInstall(packageManager),
      buildCommand: hasScriptName("build") ? packageRun(packageManager, "build") : null,
      startCommand,
      outputDirectory,
      processManager: startCommand ? "PM2" : "NONE"
    }
  };
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export function detectDeploymentFiles(
  files: string[],
  packageJsonText?: string | null,
  composerJsonText?: string | null
): DeploymentDetection {
  const names = new Set(files.map((file) => file.toLowerCase()));
  const packageManager = packageManagerFor(names);
  const pkg = readPackageJson(packageJsonText);
  const composer = readComposerJson(composerJsonText);
  const scripts = pkg?.scripts ?? {};
  const hasPkgScript = (name: string) => Boolean(scripts[name]);

  if (names.has("artisan")) {
    return {
      detected: "LARAVEL",
      confidence: 0.98,
      reason: "Found artisan",
      files,
      suggestions: {
        runtime: "PHP",
        packageManager: "COMPOSER",
        installCommand: "composer install --no-dev --optimize-autoloader --no-interaction --no-scripts",
        buildCommand: null,
        startCommand: "php artisan serve --host=127.0.0.1 --port {PORT}",
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
        buildCommand: hasPkgScript("build") ? packageRun(packageManager, "build") : null,
        startCommand: "npx next start -p {PORT} -H 127.0.0.1",
        outputDirectory: ".next",
        processManager: "PM2"
      }
    };
  }

  const viteDetected = names.has("vite.config.js") || names.has("vite.config.ts") || names.has("vite.config.mjs") || (pkg ? hasDependency(pkg, "vite") : false);
  const craDetected = pkg ? hasDependency(pkg, "react-scripts") : false;
  if (viteDetected && pkg) {
    return nodeJsDetection(files, names, packageManager, pkg, "Found Vite markers", 0.9, "dist", { vite: true });
  }

  if (pkg && isNodeFrontendPackage(pkg)) {
    return nodeJsDetection(
      files,
      names,
      packageManager,
      pkg,
      "Found package.json with React/Vite/Node frontend markers",
      0.92,
      craDetected ? "build" : hasPkgScript("build") ? "dist" : "dist",
      { cra: craDetected }
    );
  }

  if (pkg && (hasPkgScript("start") || pkg.main || hasPkgScript("build") || hasPkgScript("preview"))) {
    return nodeJsDetection(
      files,
      names,
      packageManager,
      pkg,
      hasPkgScript("start")
        ? "Found package.json with a start script"
        : hasPkgScript("preview")
          ? "Found package.json with a preview script"
          : hasPkgScript("build")
            ? "Found package.json with a build script"
            : "Found package.json with a main entry",
      hasPkgScript("start") ? 0.84 : 0.78,
      hasPkgScript("build") ? (craDetected ? "build" : "dist") : null,
      { cra: craDetected }
    );
  }

  if (names.has("composer.json") && isLaravelComposerPackage(composer)) {
    return {
      detected: "LARAVEL",
      confidence: 0.9,
      reason: "Found Laravel composer dependencies",
      files,
      suggestions: {
        runtime: "PHP",
        packageManager: "COMPOSER",
        installCommand: "composer install --no-dev --optimize-autoloader --no-interaction --no-scripts",
        buildCommand: null,
        startCommand: "php artisan serve --host=127.0.0.1 --port {PORT}",
        outputDirectory: "public",
        processManager: "SUPERVISOR"
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
  const composerJson = await readTextIfExists(path.join(sourceRoot, "composer.json"));
  return { ...(detectDeploymentFiles(files, packageJson, composerJson)), rootPath: sourceRoot };
}

export async function deploymentHasLaravelArtisan(appPath: string) {
  try {
    await fs.access(path.join(appPath, "artisan"));
    return true;
  } catch {
    return false;
  }
}
