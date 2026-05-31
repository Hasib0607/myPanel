CREATE TYPE "GuardianSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "GuardianIncidentStatus" AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE "GuardianActionStatus" AS ENUM ('SKIPPED', 'SUCCEEDED', 'FAILED');

CREATE TABLE "guardian_incidents" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "severity" "GuardianSeverity" NOT NULL DEFAULT 'WARNING',
  "status" "GuardianIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "metadata" JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "guardian_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "guardian_actions" (
  "id" TEXT NOT NULL,
  "incident_id" TEXT,
  "action" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "status" "GuardianActionStatus" NOT NULL,
  "reason" TEXT,
  "result" JSONB NOT NULL DEFAULT '{}',
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guardian_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guardian_incidents_fingerprint_key" ON "guardian_incidents"("fingerprint");
CREATE INDEX "guardian_incidents_status_last_seen_at_idx" ON "guardian_incidents"("status", "last_seen_at");
CREATE INDEX "guardian_incidents_category_last_seen_at_idx" ON "guardian_incidents"("category", "last_seen_at");
CREATE INDEX "guardian_actions_action_target_created_at_idx" ON "guardian_actions"("action", "target", "created_at");
CREATE INDEX "guardian_actions_status_created_at_idx" ON "guardian_actions"("status", "created_at");

ALTER TABLE "guardian_actions" ADD CONSTRAINT "guardian_actions_incident_id_fkey"
  FOREIGN KEY ("incident_id") REFERENCES "guardian_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
