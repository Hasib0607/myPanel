import test from "node:test";
import assert from "node:assert/strict";
import { appendFrontendModuleNotFoundHint, detectComposerPlatformIssue, detectFrontendModuleNotFound, envDrivenRuntimeExecutables, isComposerPlatformCheckInconclusive, requiredRuntimeExecutables, runtimeInstallTargetsForComposerPlatformIssue, runtimeInstallTargetsForMissingExecutables } from "./deploymentRuntimeTools.js";
import { frontendModuleNotFound, laravelPublicCwdMissing, nodePackageBinaryMissing, pythonRuntimeRepairNeeded, runtimeTargetsForFailedDeploymentLog, supervisorRepairNeeded, supervisorStartStillStarting } from "./deploymentFailureRuntimeRepairs.js";

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

test("composer PHP 8.3 and sodium requirements queue matching repairs", () => {
  const text = `
    Your lock file does not contain a compatible set of packages.
    lcobucci/clock 3.5.0 requires php ~8.3.0 || ~8.4.0 -> your php version (8.2.31) does not satisfy that requirement.
    lcobucci/jwt 4.3.0 requires ext-sodium * -> it is missing from your system.
    maennchen/zipstream-php 3.2.0 requires php-64bit ^8.3 -> your php-64bit version (8.2.31) does not satisfy that requirement.
  `;

  const issue = detectComposerPlatformIssue(text);
  assert.equal(issue?.requiredPhpVersion, "8.3");
  assert.equal(issue?.currentPhpVersion, "8.2.31");
  assert.deepEqual(issue?.missingExtensions, ["sodium"]);
  assert.deepEqual(runtimeInstallTargetsForComposerPlatformIssue(text).map((target) => target.actionKey), ["install-php83", "install-php-extension-sodium"]);
});

test("composer lockfile with PHP 8.2 upper bound on PHP 8.3 queues PHP 8.2 repair", () => {
  const text = `
    Your lock file does not contain a compatible set of packages. Please run composer update.
    lcobucci/clock 2.3.0 requires php ~8.1.0 || ~8.2.0 -> your php version (8.3.31) does not satisfy that requirement.
    lcobucci/jwt 4.0.4 requires lcobucci/clock ^2.0 -> satisfiable by lcobucci/clock[2.3.0].
  `;

  const issue = detectComposerPlatformIssue(text);
  assert.equal(issue?.requiredPhpVersion, "8.1");
  assert.equal(issue?.maxSupportedPhpVersion, "8.2");
  assert.equal(issue?.currentPhpVersion, "8.3.31");
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
  assert.equal(tools.includes("php-ext-swoole"), false);
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

test("runtime matrix treats cross-env as a local Node package wrapper", () => {
  const tools = requiredRuntimeExecutables({
    framework: "NODEJS",
    packageManager: "NPM",
    runtime: "NODE",
    processManager: "PM2",
    installCommand: "npm install",
    buildCommand: "cross-env NODE_ENV=production vite build",
    startCommand: "npm run start"
  });

  assert.ok(tools.includes("node"));
  assert.ok(tools.includes("npm"));
  assert.ok(tools.includes("pm2"));
  assert.equal(tools.includes("cross-env"), false);
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
  assert.equal(pythonTools.includes(".venv/bin/python"), false);
  assert.equal(pythonTools.includes(".venv/bin/uvicorn"), false);

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

test("Horizon environment requires Redis runtime tools", () => {
  const tools = envDrivenRuntimeExecutables({ HORIZON_ENABLED: "true" });
  assert.deepEqual(tools, ["redis-server", "redis-cli", "php-ext-redis"]);
});

test("Google Drive environment only requires common PHP transport extensions", () => {
  const tools = envDrivenRuntimeExecutables({ GOOGLE_DRIVE_CLIENT_ID: "client", GOOGLE_DRIVE_REFRESH_TOKEN: "token" });
  assert.deepEqual(tools, ["php-ext-curl", "php-ext-zip", "php-ext-mbstring"]);
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

test("failed deploy parser maps explicit missing runtime tools list to approvals", () => {
  const log = "Missing runtime tools on the server: composer, php-ext-redis, php-ext-bcmath, php-ext-intl, supervisorctl. Installation requires explicit approval.";

  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log).map((target) => target.actionKey), [
    "install-composer",
    "install-php-extension-bcmath",
    "install-php-extension-intl",
    "install-php-extension-redis",
    "install-supervisor"
  ]);
});

test("failed deploy parser maps Swoole on old PHP to PHP 8.2 and Swoole repairs", () => {
  const log = "pecl/swoole requires PHP version >= 8.2.0, installed version is 8.0.30";
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log).map((target) => target.actionKey), [
    "install-php82",
    "install-php-extension-swoole"
  ]);
});

test("failed deploy parser detects Supervisor spawn repair separately from tool install", () => {
  const log = "start: my-app: ERROR (spawn error); Supervisor status: BACKOFF Exited too quickly";

  assert.equal(supervisorRepairNeeded(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log).map((target) => target.actionKey), ["install-supervisor"]);
});

test("failed deploy parser detects transient Supervisor STARTING race", () => {
  const log = "Process start failed with exit code 1: start: ecommercex-admin: ERROR (abnormal termination); Supervisor status: ecommercex-admin STARTING";

  assert.equal(supervisorStartStillStarting(log), true);
});

test("failed deploy parser detects Laravel public cwd missing", () => {
  const log = 'The provided cwd "/var/www/deployments/ecommercex-admin/public" does not exist.';

  assert.equal(laravelPublicCwdMissing(log), true);
});

test("failed deploy parser treats missing Vite as project dependency repair", () => {
  const log = "Build failed with exit code 127: sh: line 1: vite: command not found";

  assert.equal(nodePackageBinaryMissing(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log), []);
});

test("failed deploy parser treats missing Laravel Mix as project dependency repair", () => {
  const log = "Laravel frontend asset build failed with exit code 127: sh: line 1: mix: command not found";

  assert.equal(nodePackageBinaryMissing(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log), []);
});

test("failed deploy parser treats missing cross-env as project dependency repair", () => {
  const log = "Build failed with exit code 127: sh: line 1: cross-env: command not found";

  assert.equal(nodePackageBinaryMissing(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log), []);
});

test("detects Laravel Mix missing Vue source files", () => {
  const log = `
    Laravel frontend asset build failed with exit code 1:
    ERROR in ./resources/js/Pos.vue?vue&type=script&setup=true&lang=js
    Module not found: Error: Can't resolve './components/HeaderTop.vue' in '/var/www/deployments/ebitans-admin-final/resources/js'
    webpack compiled with 1 error
  `;

  const issue = detectFrontendModuleNotFound(log);
  assert.ok(issue);
  assert.equal(issue?.missingImport, "./components/HeaderTop.vue");
  assert.equal(issue?.importerDirectory, "/var/www/deployments/ebitans-admin-final/resources/js");
  assert.equal(issue?.importerFile, "./resources/js/Pos.vue");
  assert.equal(frontendModuleNotFound(log), true);
  assert.deepEqual(runtimeTargetsForFailedDeploymentLog(log), []);
  assert.match(appendFrontendModuleNotFoundHint(log), /HeaderTop\.vue/);
  assert.match(appendFrontendModuleNotFoundHint(log), /cannot create missing application source files/i);
});
