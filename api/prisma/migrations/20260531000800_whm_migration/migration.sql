CREATE TYPE "WhmMigrationStatus" AS ENUM ('DRAFT', 'CONNECTED', 'SCANNING', 'SCANNED', 'IMPORTING', 'IMPORTED', 'MIGRATING', 'COMPLETED', 'FAILED');

CREATE TYPE "WhmMigrationItemType" AS ENUM ('ACCOUNT', 'DOMAIN', 'DNS_ZONE', 'DNS_RECORD', 'PACKAGE', 'MAILBOX', 'DATABASE', 'SSL', 'FILES');

CREATE TYPE "WhmMigrationItemStatus" AS ENUM ('DISCOVERED', 'MAPPED', 'IMPORTED', 'APPROVED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

CREATE TYPE "WhmMigrationTaskType" AS ENUM ('FILE_SYNC', 'DATABASE_DUMP', 'MAIL_SYNC', 'DNS_CUTOVER', 'ROLLBACK');

CREATE TABLE "whm_migrations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 2087,
    "username" TEXT NOT NULL,
    "token_secret_ref" TEXT NOT NULL,
    "verify_ssl" BOOLEAN NOT NULL DEFAULT true,
    "status" "WhmMigrationStatus" NOT NULL DEFAULT 'DRAFT',
    "server_info" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "last_scan_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whm_migrations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whm_migration_items" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "type" "WhmMigrationItemType" NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_account" TEXT,
    "name" TEXT NOT NULL,
    "status" "WhmMigrationItemStatus" NOT NULL DEFAULT 'DISCOVERED',
    "target_type" TEXT,
    "target_id" TEXT,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whm_migration_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whm_migration_tasks" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "type" "WhmMigrationTaskType" NOT NULL,
    "account" TEXT,
    "domain" TEXT,
    "status" "WhmMigrationItemStatus" NOT NULL DEFAULT 'QUEUED',
    "command" TEXT,
    "result" JSONB NOT NULL DEFAULT '{}',
    "log" TEXT,
    "approved_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whm_migration_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "whm_migrations_status_updated_at_idx" ON "whm_migrations"("status", "updated_at");

CREATE UNIQUE INDEX "whm_migration_items_migration_id_type_source_id_key" ON "whm_migration_items"("migration_id", "type", "source_id");

CREATE INDEX "whm_migration_items_migration_id_type_status_idx" ON "whm_migration_items"("migration_id", "type", "status");

CREATE INDEX "whm_migration_items_source_account_idx" ON "whm_migration_items"("source_account");

CREATE INDEX "whm_migration_tasks_migration_id_type_status_idx" ON "whm_migration_tasks"("migration_id", "type", "status");

ALTER TABLE "whm_migration_items" ADD CONSTRAINT "whm_migration_items_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "whm_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whm_migration_tasks" ADD CONSTRAINT "whm_migration_tasks_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "whm_migrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
