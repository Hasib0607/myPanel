CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE "accounts" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "email" TEXT,
  "owner_name" TEXT,
  "password_hash" TEXT NOT NULL,
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "home_root" TEXT NOT NULL,
  "package_name" TEXT,
  "disk_limit_mb" INTEGER,
  "domain_limit" INTEGER,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounts_username_key" ON "accounts"("username");
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");
CREATE INDEX "accounts_status_created_at_idx" ON "accounts"("status", "created_at");

ALTER TABLE "domains" ADD COLUMN "account_id" TEXT;
ALTER TABLE "deployments" ADD COLUMN "account_id" TEXT;
ALTER TABLE "mail_accounts" ADD COLUMN "account_id" TEXT;

CREATE INDEX "deployments_account_id_idx" ON "deployments"("account_id");
CREATE INDEX "mail_accounts_account_id_idx" ON "mail_accounts"("account_id");

ALTER TABLE "domains"
  ADD CONSTRAINT "domains_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "deployments"
  ADD CONSTRAINT "deployments_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "mail_accounts"
  ADD CONSTRAINT "mail_accounts_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
