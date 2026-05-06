-- Phase 11 deployment engine foundation.

-- Extend existing enums.
ALTER TYPE "DeploymentFramework" ADD VALUE IF NOT EXISTS 'STATIC';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "DeploymentStatus" ADD VALUE IF NOT EXISTS 'BUILDING';

-- Create new deployment foundation enums.
CREATE TYPE "DeploymentSourceProvider" AS ENUM ('MANUAL', 'GIT_URL', 'GITHUB', 'FILE_MANAGER', 'UPLOAD');
CREATE TYPE "DeploymentRuntime" AS ENUM ('NODE', 'PHP', 'PYTHON', 'GO', 'STATIC');
CREATE TYPE "DeploymentPackageManager" AS ENUM ('NPM', 'PNPM', 'YARN', 'COMPOSER', 'PIP', 'UV', 'GO', 'NONE');
CREATE TYPE "DeploymentProcessManager" AS ENUM ('PM2', 'SUPERVISOR', 'SYSTEMD', 'STATIC', 'NONE');
CREATE TYPE "DeploymentHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'DOWN');
CREATE TYPE "DeploymentReleaseStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK');
CREATE TYPE "DeploymentStep" AS ENUM ('QUEUED', 'PREFLIGHT', 'CLONING', 'INSTALLING', 'MIGRATING', 'BUILDING', 'CONFIGURING_PROXY', 'STARTING', 'HEALTH_CHECK', 'SUCCEEDED', 'FAILED', 'ROLLBACK');

-- Make domain binding optional and one-domain-to-many-deployments ready.
ALTER TABLE "deployments" DROP CONSTRAINT IF EXISTS "deployments_domain_id_fkey";
DROP INDEX IF EXISTS "deployments_domain_id_key";
ALTER TABLE "deployments" ALTER COLUMN "domain_id" DROP NOT NULL;

-- Add expanded project/source/build/runtime fields.
ALTER TABLE "deployments"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "runtime" "DeploymentRuntime",
  ADD COLUMN "source_provider" "DeploymentSourceProvider" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "git_url" TEXT,
  ADD COLUMN "github_owner" TEXT,
  ADD COLUMN "github_repo" TEXT,
  ADD COLUMN "github_repo_id" TEXT,
  ADD COLUMN "github_visibility" TEXT,
  ADD COLUMN "commit_sha" TEXT,
  ADD COLUMN "root_directory" TEXT NOT NULL DEFAULT '.',
  ADD COLUMN "package_manager" "DeploymentPackageManager",
  ADD COLUMN "install_command" TEXT,
  ADD COLUMN "build_command" TEXT,
  ADD COLUMN "start_command" TEXT,
  ADD COLUMN "output_directory" TEXT,
  ADD COLUMN "public_directory" TEXT,
  ADD COLUMN "runtime_version" TEXT,
  ADD COLUMN "process_manager" "DeploymentProcessManager",
  ADD COLUMN "health_status" "DeploymentHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "health_url" TEXT,
  ADD COLUMN "last_health_check_at" TIMESTAMP(3),
  ADD COLUMN "last_deploy_at" TIMESTAMP(3),
  ADD COLUMN "db_user" TEXT,
  ADD COLUMN "db_password_secret_ref" TEXT,
  ADD COLUMN "db_connection_secret_ref" TEXT,
  ADD COLUMN "persistent_paths" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "auto_deploy_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "webhook_secret_hash" TEXT;

-- Backfill slug for existing rows before making it required.
UPDATE "deployments"
SET "slug" = lower(regexp_replace(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))
WHERE "slug" IS NULL;

UPDATE "deployments"
SET "slug" = 'deployment-' || substr("id", 1, 8)
WHERE "slug" IS NULL OR "slug" = '';

ALTER TABLE "deployments" ALTER COLUMN "slug" SET NOT NULL;

-- Create supporting tables.
CREATE TABLE "deployment_env_vars" (
  "id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT,
  "secret_ref" TEXT,
  "is_secret" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deployment_env_vars_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deployment_releases" (
  "id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "status" "DeploymentReleaseStatus" NOT NULL DEFAULT 'QUEUED',
  "commit_sha" TEXT,
  "commit_message" TEXT,
  "commit_author" TEXT,
  "source_path" TEXT,
  "artifact_path" TEXT,
  "env_snapshot" JSONB NOT NULL DEFAULT '{}',
  "process_config" JSONB NOT NULL DEFAULT '{}',
  "nginx_config_path" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "duration_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deployment_releases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deployment_logs" (
  "id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "release_id" TEXT,
  "step" "DeploymentStep" NOT NULL,
  "level" TEXT NOT NULL DEFAULT 'info',
  "message" TEXT NOT NULL,
  "stdout" TEXT,
  "stderr" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "github_connections" (
  "id" TEXT NOT NULL DEFAULT 'superadmin',
  "username" TEXT,
  "token_secret_ref" TEXT,
  "installation_id" TEXT,
  "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "connected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- Indexes.
CREATE UNIQUE INDEX "deployments_slug_key" ON "deployments"("slug");
CREATE INDEX "deployments_domain_id_idx" ON "deployments"("domain_id");
CREATE INDEX "deployments_source_provider_idx" ON "deployments"("source_provider");
CREATE INDEX "deployments_github_owner_github_repo_idx" ON "deployments"("github_owner", "github_repo");
CREATE UNIQUE INDEX "deployment_env_vars_deployment_id_key_key" ON "deployment_env_vars"("deployment_id", "key");
CREATE INDEX "deployment_env_vars_key_idx" ON "deployment_env_vars"("key");
CREATE INDEX "deployment_releases_deployment_id_created_at_idx" ON "deployment_releases"("deployment_id", "created_at");
CREATE INDEX "deployment_releases_status_idx" ON "deployment_releases"("status");
CREATE INDEX "deployment_logs_deployment_id_created_at_idx" ON "deployment_logs"("deployment_id", "created_at");
CREATE INDEX "deployment_logs_release_id_step_idx" ON "deployment_logs"("release_id", "step");

-- Foreign keys.
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deployment_env_vars" ADD CONSTRAINT "deployment_env_vars_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_releases" ADD CONSTRAINT "deployment_releases_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "deployment_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
