CREATE TYPE "AuditAction" AS ENUM (
  'CREATE',
  'UPDATE',
  'DELETE',
  'DEPLOY',
  'START',
  'STOP',
  'RESTART',
  'ROLLBACK',
  'APPLY',
  'LOGIN',
  'LOGOUT'
);

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "actor" TEXT NOT NULL DEFAULT 'superadmin',
  "action" "AuditAction" NOT NULL,
  "resource" TEXT NOT NULL,
  "resource_id" TEXT,
  "description" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_resource_created_at_idx" ON "audit_logs"("resource", "created_at");
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");
