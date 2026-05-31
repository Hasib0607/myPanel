CREATE TYPE "PanelBackupStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "panel_backups" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "PanelBackupStatus" NOT NULL DEFAULT 'QUEUED',
    "archive_path" TEXT,
    "size_bytes" INTEGER,
    "includes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "result" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "panel_backups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "panel_backups_status_created_at_idx" ON "panel_backups"("status", "created_at");
