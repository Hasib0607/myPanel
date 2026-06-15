CREATE TABLE "deployment_cron_jobs" (
    "id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "minute" TEXT NOT NULL DEFAULT '*',
    "hour" TEXT NOT NULL DEFAULT '*',
    "day_of_month" TEXT NOT NULL DEFAULT '*',
    "month" TEXT NOT NULL DEFAULT '*',
    "day_of_week" TEXT NOT NULL DEFAULT '*',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_cron_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployment_cron_jobs_deployment_id_enabled_idx" ON "deployment_cron_jobs"("deployment_id", "enabled");

ALTER TABLE "deployment_cron_jobs"
    ADD CONSTRAINT "deployment_cron_jobs_deployment_id_fkey"
    FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
