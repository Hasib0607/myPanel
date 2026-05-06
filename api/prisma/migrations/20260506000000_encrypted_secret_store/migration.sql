CREATE TYPE "SecretKind" AS ENUM (
  'GITHUB_TOKEN',
  'DEPLOYMENT_ENV',
  'DATABASE_PASSWORD',
  'DATABASE_URL',
  'MAIL_PASSWORD',
  'WEBHOOK_SECRET',
  'GENERIC'
);

CREATE TABLE "secrets" (
  "id" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "kind" "SecretKind" NOT NULL DEFAULT 'GENERIC',
  "label" TEXT,
  "encrypted_value" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "secrets_ref_key" ON "secrets"("ref");
CREATE INDEX "secrets_kind_idx" ON "secrets"("kind");
