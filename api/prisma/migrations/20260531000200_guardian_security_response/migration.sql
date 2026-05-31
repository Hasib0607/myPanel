CREATE TYPE "GuardianBlockStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REMOVED');
CREATE TYPE "GuardianFileFindingStatus" AS ENUM ('OPEN', 'TRUSTED', 'RESOLVED');

CREATE TABLE "guardian_ip_allowlist" (
  "id" TEXT NOT NULL,
  "cidr" TEXT NOT NULL,
  "label" TEXT,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guardian_ip_allowlist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "guardian_ip_blocks" (
  "id" TEXT NOT NULL,
  "ip" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "status" "GuardianBlockStatus" NOT NULL DEFAULT 'ACTIVE',
  "expires_at" TIMESTAMP(3),
  "result" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removed_at" TIMESTAMP(3),

  CONSTRAINT "guardian_ip_blocks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "guardian_file_findings" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "risk" "GuardianSeverity" NOT NULL DEFAULT 'WARNING',
  "status" "GuardianFileFindingStatus" NOT NULL DEFAULT 'OPEN',
  "size_bytes" INTEGER NOT NULL DEFAULT 0,
  "mode" TEXT,
  "owner" TEXT,
  "modified_at" TIMESTAMP(3),
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB NOT NULL DEFAULT '{}',

  CONSTRAINT "guardian_file_findings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guardian_ip_allowlist_cidr_key" ON "guardian_ip_allowlist"("cidr");
CREATE INDEX "guardian_ip_allowlist_expires_at_idx" ON "guardian_ip_allowlist"("expires_at");
CREATE INDEX "guardian_ip_blocks_ip_status_idx" ON "guardian_ip_blocks"("ip", "status");
CREATE INDEX "guardian_ip_blocks_status_expires_at_idx" ON "guardian_ip_blocks"("status", "expires_at");
CREATE UNIQUE INDEX "guardian_file_findings_fingerprint_key" ON "guardian_file_findings"("fingerprint");
CREATE INDEX "guardian_file_findings_status_risk_last_seen_at_idx" ON "guardian_file_findings"("status", "risk", "last_seen_at");
