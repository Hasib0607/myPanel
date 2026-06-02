import test from "node:test";
import assert from "node:assert/strict";
import { detectComposerPlatformIssue, requiredRuntimeExecutables, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables } from "./deploymentRuntimeTools.js";

test("composer PHP 8.1 requirement on PHP 8.0 queues PHP 8.2 runtime repair", () => {
  const targets = runtimeInstallTargetsForComposerPlatformIssue(`
    carbonphp/carbon-doctrine-types 3.2.0 requires php ^8.1 -> your php version (8.0.30) does not satisfy that requirement.
    maennchen/zipstream-php 3.1.2 requires php-64bit ^8.2 -> your php-64bit version (8.0.30) does not satisfy that requirement.
  `);

  assert.deepEqual(targets.map((target) => target.actionKey), ["install-php82"]);
});

test("composer platform parser keeps highest required PHP and lockfile-outdated signal", () => {
  const issue = detectComposerPlatformIssue(`
    Warning: The lock file is not up to date with the latest changes in composer.json.
    carbonphp/carbon-doctrine-types 3.2.0 requires php ^8.1 -> your php version (8.0.30) does not satisfy that requirement.
    maennchen/zipstream-php 3.1.2 requires php-64bit ^8.2 -> your php-64bit version (8.0.30) does not satisfy that requirement.
  `);

  assert.ok(issue);
  assert.equal(issue?.requiredPhpVersion, "8.2");
  assert.equal(issue?.currentPhpVersion, "8.0.30");
  assert.equal(issue?.composerLockOutdated, true);
});

test("runtime matrix includes Laravel/PHP server requirements", () => {
  const tools = requiredRuntimeExecutables({
    framework: "LARAVEL",
    packageManager: "COMPOSER",
    runtime: "PHP",
    processManager: "SUPERVISOR",
    installCommand: null,
    buildCommand: null,
    startCommand: null
  });

  for (const tool of [
    "php",
    "php-fpm",
    "composer",
    "supervisorctl",
    "php-ext-mbstring",
    "php-ext-xml",
    "php-ext-curl",
    "php-ext-zip",
    "php-ext-gd",
    "php-ext-redis",
    "php-ext-soap",
    "php-ext-mysql",
    "php-ext-pgsql"
  ]) {
    assert.ok(tools.includes(tool), `${tool} missing`);
  }
});

test("runtime matrix includes Node/Next process manager requirements", () => {
  const tools = requiredRuntimeExecutables({
    framework: "NEXTJS",
    packageManager: "PNPM",
    runtime: "NODE",
    processManager: "PM2",
    installCommand: null,
    buildCommand: null,
    startCommand: null
  });

  for (const tool of ["node", "npm", "pnpm", "pm2"]) {
    assert.ok(tools.includes(tool), `${tool} missing`);
  }
});

test("runtime matrix includes Python and Go supervisor requirements", () => {
  const pythonTools = requiredRuntimeExecutables({
    framework: "PYTHON",
    packageManager: "PIP",
    runtime: "PYTHON",
    processManager: "SUPERVISOR",
    installCommand: null,
    buildCommand: null,
    startCommand: "uvicorn app.main:app --host 127.0.0.1 --port {PORT}"
  });

  for (const tool of ["python3", "python3.10+", "pip3", "python-venv", "supervisorctl"]) {
    assert.ok(pythonTools.includes(tool), `${tool} missing`);
  }

  const goTools = requiredRuntimeExecutables({
    framework: "GO",
    packageManager: "GO",
    runtime: "GO",
    processManager: "SUPERVISOR",
    installCommand: null,
    buildCommand: null,
    startCommand: null
  });

  for (const tool of ["go", "supervisorctl"]) {
    assert.ok(goTools.includes(tool), `${tool} missing`);
  }
});

test("missing runtime matrix entries map to small install targets", () => {
  const targets = runtimeInstallTargetsForMissingExecutables([
    "php-ext-gd",
    "php-ext-pgsql",
    "python3.10+",
    "python-venv",
    "pm2",
    "supervisorctl",
    "go"
  ]);

  assert.deepEqual(targets.map((target) => target.actionKey), [
    "install-php",
    "install-python",
    "install-python311",
    "install-go",
    "install-supervisor",
    "install-pm2"
  ]);
});
