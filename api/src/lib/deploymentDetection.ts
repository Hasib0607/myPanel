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
  if (scripts.build) {
    const output = outputDirectory || (options?.cra ? "build" : "dist");
    return `npx serve -s ${output} -l {PORT}`;
  }
  if (scripts.preview) {
    return `${run("preview")} -- --host 127.0.0.1 --port {PORT}`;
  }
  return null;
}

export function nodeStartUsesVitePreview(startCommand: string | null | undefined) {
  const normalized = (startCommand || "").toLowerCase();
  return normalized.includes("vite preview") || normalized.includes("run preview");
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

function pythonAsgiModuleForFiles(names: Set<string>) {
  if (names.has("app.py")) return "app:app";
  if (names.has("main.py")) return "main:app";
  if (names.has("server.py")) return "server:app";
  if (names.has("api.py")) return "api:app";
  return "app.main:app";
}

function pythonStartCommandForFiles(names: Set<string>) {
  if (names.has("manage.py")) {
    return ".venv/bin/python manage.py runserver 127.0.0.1:{PORT}";
  }
  return `.venv/bin/python -m uvicorn ${pythonAsgiModuleForFiles(names)} --host 127.0.0.1 --port {PORT}`;
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

  if (names.has("requirements.txt") || names.has("pyproject.toml") || names.has("manage.py")) {
    return {
      detected: "PYTHON",
      confidence: 0.86,
      reason: "Found Python markers",
      files,
      suggestions: {
        runtime: "PYTHON",
        packageManager: names.has("pyproject.toml") ? "UV" : "PIP",
        installCommand: names.has("pyproject.toml") ? "uv sync" : ".venv/bin/python -m pip install -r requirements.txt",
        buildCommand: null,
        startCommand: pythonStartCommandForFiles(names),
        outputDirectory: null,
        processManager: "SUPERVISOR"
      }
    };
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

export async function deploymentHasLaravelPublicIndex(appPath: string) {
  try {
    await fs.access(path.join(appPath, "public", "index.php"));
    return true;
  } catch {
    return false;
  }
}

type DeploymentAppRootCandidate = {
  appPath: string;
  detection: DeploymentDetection;
  hasLaravelPublicIndex: boolean;
};

async function candidatePaths(rootPath: string, rootDirectory = ".") {
  const root = path.resolve(rootPath);
  const sourceRoot = path.resolve(root, rootDirectory || ".");
  const candidates = [sourceRoot, root];
  const skippedDirectories = new Set([
    ".git",
    ".github",
    ".next",
    ".nuxt",
    ".output",
    "bootstrap",
    "build",
    "cache",
    "dist",
    "node_modules",
    "public",
    "storage",
    "vendor"
  ]);
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  const visited = new Set<string>();
  const maxDepth = 8;
  const maxDirectories = 1500;

  if (path.basename(sourceRoot).toLowerCase() === "public") {
    candidates.push(path.dirname(sourceRoot));
  }

  while (queue.length && visited.size < maxDirectories) {
    const current = queue.shift();
    if (!current || visited.has(current.directory)) continue;
    visited.add(current.directory);
    if (current.depth >= maxDepth) continue;

    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.name.toLowerCase() === "public") {
        try {
          await fs.access(path.join(current.directory, entry.name, "index.php"));
          candidates.push(current.directory);
        } catch {
          // A public directory without index.php is not enough to make a Laravel web root.
        }
        continue;
      }
      if (skippedDirectories.has(entry.name.toLowerCase())) continue;
      const candidate = path.join(current.directory, entry.name);
      candidates.push(candidate);
      queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }

  return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
}

export async function findDeploymentAppRoot(
  rootPath: string,
  rootDirectory = ".",
  expectedFramework?: DeploymentFramework | null
): Promise<DeploymentAppRootCandidate | null> {
  const candidates = await candidatePaths(rootPath, rootDirectory);
  const detected: DeploymentAppRootCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const detection = await detectDeploymentSource(candidate, ".");
      if (detection.confidence >= 0.75 || detection.detected !== "STATIC") {
        detected.push({
          appPath: candidate,
          detection,
          hasLaravelPublicIndex: detection.detected === "LARAVEL" ? await deploymentHasLaravelPublicIndex(candidate) : false
        });
      }
    } catch {
      // Ignore unreadable or non-directory candidates.
    }
  }

  const expected = expectedFramework ?? null;
  const matching = expected ? detected.filter((candidate) => candidate.detection.detected === expected) : detected;
  const candidatesToRank = matching.length ? matching : detected;
  candidatesToRank.sort((left, right) => {
    const leftExpected = expected && left.detection.detected === expected ? 1 : 0;
    const rightExpected = expected && right.detection.detected === expected ? 1 : 0;
    if (leftExpected !== rightExpected) return rightExpected - leftExpected;

    const leftLaravelPublic = left.detection.detected === "LARAVEL" ? Number(left.hasLaravelPublicIndex) : 0;
    const rightLaravelPublic = right.detection.detected === "LARAVEL" ? Number(right.hasLaravelPublicIndex) : 0;
    if (leftLaravelPublic !== rightLaravelPublic) return rightLaravelPublic - leftLaravelPublic;

    return right.detection.confidence - left.detection.confidence;
  });

  return candidatesToRank[0] ?? null;
}

export async function findLaravelAppRoot(rootPath: string, rootDirectory = ".") {
  const detected = await findDeploymentAppRoot(rootPath, rootDirectory, "LARAVEL");
  if (detected?.detection.detected === "LARAVEL") return detected.appPath;
  return null;
}

export async function deploymentRunsLaravel(framework: DeploymentFramework, appPath: string) {
  return framework === "LARAVEL" && await deploymentHasLaravelArtisan(appPath);
}
