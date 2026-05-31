CREATE TYPE "DeploymentDoctorApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED');

CREATE TABLE "deployment_doctor_approvals" (
  "id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "action_key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "command" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "DeploymentDoctorApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "result" JSONB NOT NULL DEFAULT '{}',
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  "executed_at" TIMESTAMP(3),

  CONSTRAINT "deployment_doctor_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deployment_doctor_approvals_deployment_id_status_requested_at_idx"
  ON "deployment_doctor_approvals"("deployment_id", "status", "requested_at");

ALTER TABLE "deployment_doctor_approvals"
  ADD CONSTRAINT "deployment_doctor_approvals_deployment_id_fkey"
  FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
