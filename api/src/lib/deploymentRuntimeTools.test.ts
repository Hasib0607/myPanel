import test from "node:test";
import assert from "node:assert/strict";
import { detectComposerPlatformIssue, isComposerPlatformCheckInconclusive, requiredRuntimeExecutables, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables } from "./deploymentRuntimeTools.js";
import { pythonRuntimeRepairNeeded, runtimeTargetsForFailedDeploymentLog, supervisorRepairNeeded } from "./deploymentFailureRuntimeRepairs.js";

test("composer PHP 8.1 requirement on PHP 8.0 queues PHP 8.2 runtime repair", () => {
  const targets = runtimeInstallTargetsForComposerPlatformIssue(`
    carbonphp/carbon-doctrine-types 3.2.0 requires php ^8.1 -> your php version (8.0.30) does not satisfy that requirement.
    maennchen/zipstream-php 3.1.2 requires php-64bit ^8.2 -> your php-64bit version (8.0.30) does not satisfy that requirement.
  `);

  assert.deepEqual(targets.map((target) => target.actionKey), ["install-php82"]);
});

test("composer lock warning with PHP mismatch still queues PHP runtime repair", () => {
  const text = `
    Warning: The lock file is not up to date with the latest changes in composer.json.
    Your lock file does not contain a compatible set of packages. Please run composer update.
    carbonphp/carbon-doctrine-types 3.2.0 requires php ^8.1 -> your php version (8.0.30) does not satisfy that requirement.
    maennchen/zipstream-php 3.1.2 requires php-64bit ^8.2 -> your php-64bit version (8.0.30) does not satisfy that requirement.
    symfony/http-client v7.3.4 requires php >=8.2 -> your php version (8.0.30) does not satisfy that requirement.
  `;

  const issue = detectComposerPlatformIssue(text);
  assert.equal(issue?.composerLockOutdated, true);
  assert.equal(issue?.requiredPhpVersion, "8.2");
  assert.equal(issue?.currentPhpVersion, "8.0.30");
  assert.deepEqual(runtimeInstallTargetsForComposerPlatformIssue(text).map((target) => target.actionKey), ["install-php82"]);
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

test("composer platform check without vendor and without actionable details is inconclusive", () => {
  const text = "Composer platform requirements check failed with exit code 1: No vendor dir present, checking platform requirements from the lock file";

  assert.equal(isComposerPlatformCheckInconclusive(text), true);
  assert.deepEqual(runtimeInstallTargetsForComposerPlatformIssue(text), []);
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

test("required runtime tools are selected per framework", () => {
  const cases = [
    {
      name: "Laravel/PHP",
      input: { framework: "LARAVEL", packageManager: "COMPOSER", runtime: "PHP", processManager: "SUPERVISOR" },
      expected: ["php", "php-fpm", "composer", "php-ext-gd", "supervisorctl"]
    },
    {
      name: "React/Node",
      input: { framework: "NODEJS", packageManager: "NPM", runtime: "NODE", processManager: "PM2" },
      expected: ["node", "npm", "pm2"]
    },
    {
      name: "Next.js/pnpm",
      input: { framework: "NEXTJS", packageManager: "PNPM", runtime: "NODE", processManager: "PM2" },
      expected: ["node", "npm", "pnpm", "pm2"]
    },
    {
      name: "Python/Supervisor",
      input: { framework: "PYTHON", packageManager: "PIP", runtime: "PYTHON", processManager: "SUPERVISOR" },
      expected: ["python3", "python3.10+", "pip3", "python-venv", "supervisorctl"]
    },
    {
      name: "Go/Supervisor",
      input: { framework: "GO", packageManager: "GO", runtime: "GO", processManager: "SUPERVISOR" },
      expected: ["go", "supervisorctl"]
    }
  ] as const;

  for (const item of cases) {
    const tools = requiredRuntimeExecutables({
      ...item.input,
      installCommand: null,
      buildCommand: null,
      startCommand: null
    });
    for (const tool of item.expected) {
      assert.ok(tools.includes(tool), `${item.name} missing ${tool}`);
    }
  }
});

test("missing runtime matrix entries map to small install targets", () => {
  const targets = runtimeInstallTargetsForMissingExecutables([
    "php",
    "php-ext-gd",
    "php-ext-pgsql",
    "composer",
    "node",
    "python3.10+",
    "python-venv",
    "pm2",
    "supervisorctl",
    "go"
  ]);

  assert.deepEqual(targets.map((target) => target.actionKey), [
    "install-composer",
    "install-php-runtime",
    "install-php-extension-gd",
    "install-php-extension-pgsql",
    "install-python",
    "install-python311",
    "install-nodejs",
    "install-go",
    "install-supervisor",
    "install-pm2"
  ]);
});

test("composer missing extensions queue extension-specific repairs", () => {
  const targets = runtimeInstallTargetsForComposerPlatformIssue(`
    intervention/image requires ext-gd * -> it is missing from your system.
    some/soap-client requires ext-soap * -> it is missing from your system.
  `);

  assert.deepEqual(targets.map((target) => target.actionKey), [
    "install-php-extension-gd",
    "install-php-extension-soap"
  ]);
});

test("failed deploy parser maps Python 3.9 type-union crash to Python 3.10+ repair", () => {
  const log = `
    File "/var/www/deployments/ecommercex-store-bot/app/config.py", line 10, in <module>
      def _safe_int(raw: str | None, default: int) -> int:
    TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
    Runtime executable: /usr/bin/python3.9
  `;

  assert.equal(pythonRuntimeRepairNeeded(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log).map((target) => target.actionKey), ["install-python311"]);
});

test("failed deploy parser maps missing process/runtime commands to exact repairs", () => {
  const log = `
    npm: command not found
    pm2: command not found
    supervisorctl: command not found
    go: command not found
  `;

  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log).map((target) => target.actionKey), [
    "install-nodejs",
    "install-go",
    "install-supervisor",
    "install-pm2"
  ]);
});

test("failed deploy parser detects Supervisor spawn repair separately from tool install", () => {
  const log = "start: my-app: ERROR (spawn error); Supervisor status: BACKOFF Exited too quickly";

  assert.equal(supervisorRepairNeeded(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log).map((target) => target.actionKey), ["install-supervisor"]);
});
