import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildApp } from "../app.js";
import { deployQueue, mailQueue, sslQueue } from "../jobs/queues.js";
import { createCsrfToken, csrfCookieName, csrfHeaderName } from "../lib/csrf.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

type HttpMethod = "GET" | "POST" | "PATCH";

const migrationPath = path.join(process.cwd(), "prisma", "migrations", "20260505000000_phase11_deployment_foundation", "migration.sql");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyMigration() {
  const migration = await readFile(migrationPath, "utf8");
  const requiredSql = [
    "CREATE TYPE \"DeploymentSourceProvider\"",
    "CREATE TYPE \"DeploymentRuntime\"",
    "CREATE TYPE \"DeploymentPackageManager\"",
    "CREATE TYPE \"DeploymentProcessManager\"",
    "CREATE TYPE \"DeploymentHealthStatus\"",
    "CREATE TYPE \"DeploymentReleaseStatus\"",
    "CREATE TYPE \"DeploymentStep\"",
    "CREATE TABLE \"deployment_env_vars\"",
    "CREATE TABLE \"deployment_releases\"",
    "CREATE TABLE \"deployment_logs\"",
    "CREATE TABLE \"github_connections\"",
    "ALTER TABLE \"deployments\"\n  ADD COLUMN"
  ];

  for (const fragment of requiredSql) {
    assert(migration.includes(fragment), `Phase 11 migration is missing: ${fragment}`);
  }
}

async function verifySeedData() {
  const deployment = await prisma.deployment.findUnique({
    where: { slug: "example-nextjs-app" },
    include: {
      domain: true,
      env: true,
      releases: true,
      logs: true
    }
  });
  assert(deployment, "Seed deployment example-nextjs-app is missing");
  assert(deployment.sourceProvider === "GITHUB", "Seed deployment source provider was not expanded");
  assert(deployment.runtime === "NODE", "Seed deployment runtime is missing");
  assert(deployment.packageManager === "NPM", "Seed deployment package manager is missing");
  assert(deployment.processManager === "PM2", "Seed deployment process manager is missing");
  assert(deployment.env.length > 0, "Seed deployment env var is missing");
  assert(deployment.releases.length > 0, "Seed deployment release is missing");
  assert(deployment.logs.length > 0, "Seed deployment log is missing");
  assert(deployment.domain, "Seed deployment domain relation is missing");

  const githubConnection = await prisma.gitHubConnection.findUnique({ where: { id: "superadmin" } });
  assert(githubConnection, "Superadmin GitHub connection placeholder is missing");
}

async function main() {
  console.log("Checking Phase 11 migration SQL...");
  await verifyMigration();
  console.log("Checking Phase 11 seed data...");
  await verifySeedData();

  const app = buildApp();
  await app.ready();
  const token = app.jwt.sign({ sub: "superadmin" });
  const csrfToken = createCsrfToken();

  async function request(method: HttpMethod, url: string, payload?: unknown) {
    const unsafe = method !== "GET";
    const response = await app.inject({
      method,
      url,
      cookies: { panel_session: token, [csrfCookieName]: csrfToken },
      headers: {
        ...(unsafe ? { [csrfHeaderName]: csrfToken } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json" })
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
    } as any);
    assert(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url} returned ${response.statusCode}: ${response.body}`);
    return response.json();
  }

  console.log("Checking deployment list/detail routes...");
  const list = await request("GET", "/api/v1/deployments?page=1&pageSize=10");
  assert(Array.isArray(list.items), "Deployment list did not return items");
  assert(list.items.length > 0, "Deployment list is empty");

  const deployment = await request("GET", "/api/v1/deployments/example-nextjs-app");
  assert(deployment.slug === "example-nextjs-app", "Deployment detail route returned the wrong project");

  console.log("Checking env/log/release/preflight/health routes...");
  await request("GET", "/api/v1/deployments/example-nextjs-app/env");
  const logs = await request("GET", "/api/v1/deployments/example-nextjs-app/logs?limit=20");
  assert(Array.isArray(logs) && logs.length > 0, "Deployment logs route did not return persisted logs");
  await request("GET", "/api/v1/deployments/example-nextjs-app/releases");
  await request("POST", "/api/v1/deployments/example-nextjs-app/preflight");
  await request("POST", "/api/v1/deployments/example-nextjs-app/health");

  console.log("Checking framework detection...");
  const frameworks = [
    { marker: ["artisan", "composer.json"], expected: "LARAVEL" },
    { marker: ["next.config.mjs", "package.json"], expected: "NEXTJS" },
    { marker: ["package.json"], expected: "NODEJS" },
    { marker: ["requirements.txt"], expected: "PYTHON" },
    { marker: ["go.mod"], expected: "GO" },
    { marker: ["index.html"], expected: "STATIC" }
  ];
  for (const framework of frameworks) {
    const detected = await request("POST", "/api/v1/deployments/detect", { files: framework.marker });
    assert(detected.detected === framework.expected, `Framework detection expected ${framework.expected}, got ${detected.detected}`);
  }

  console.log("Checking dry-run GitHub routes and settings update surface...");
  const githubRepos = await request("GET", "/api/v1/deployments/github/repos?search=phase11");
  assert(Array.isArray(githubRepos.items), "GitHub repository route did not return items");

  await prisma.deployment.deleteMany({ where: { slug: "phase11-verify-import" } });
  const imported = await request("POST", "/api/v1/deployments/github/import", {
    name: "Phase 11 Verify Import",
    slug: "phase11-verify-import",
    framework: "NEXTJS",
    sourceProvider: "GITHUB",
    githubOwner: "example",
    githubRepo: "phase11-verify-import",
    branch: "main",
    rootDirectory: ".",
    rootPath: "D:/Projects/Cpanel/.local-www/phase11-verify-import",
    runtime: "NODE",
    packageManager: "NPM",
    processManager: "PM2",
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm run start",
    port: 3998,
    envVars: {},
    persistentPaths: []
  });
  assert(imported.slug === "phase11-verify-import", "GitHub dry-run import did not create the verification project");

  await request("PATCH", "/api/v1/deployments/phase11-verify-import", {
    name: "Phase 11 Verify Import",
    slug: "phase11-verify-import",
    rootPath: "D:/Projects/Cpanel/.local-www/phase11-verify-import",
    rootDirectory: ".",
    port: 3998,
    framework: "NEXTJS",
    sourceProvider: "GITHUB",
    branch: "main"
  });

  await prisma.deployment.delete({ where: { slug: "phase11-verify-import" } });
  await app.close();
  await Promise.all([deployQueue.close(), mailQueue.close(), sslQueue.close()]);
  redis.disconnect();
  await prisma.$disconnect();

  console.log("Phase 11 verification passed");
}

main().catch(async (error) => {
  console.error(error);
  await Promise.allSettled([deployQueue.close(), mailQueue.close(), sslQueue.close()]);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(1);
});
