CREATE TABLE "account_packages" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "disk_limit_mb" INTEGER,
  "domain_limit" INTEGER,
  "mailbox_limit" INTEGER,
  "database_limit" INTEGER,
  "deployment_limit" INTEGER,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "account_packages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_databases" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "engine" "DatabaseType" NOT NULL,
  "database" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "account_databases_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "accounts" ADD COLUMN "package_id" TEXT;

CREATE UNIQUE INDEX "account_packages_name_key" ON "account_packages"("name");
CREATE INDEX "account_packages_is_default_name_idx" ON "account_packages"("is_default", "name");
CREATE UNIQUE INDEX "account_databases_engine_database_key" ON "account_databases"("engine", "database");
CREATE INDEX "account_databases_account_id_engine_idx" ON "account_databases"("account_id", "engine");
CREATE INDEX "accounts_package_id_idx" ON "accounts"("package_id");

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_package_id_fkey"
  FOREIGN KEY ("package_id") REFERENCES "account_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "account_databases"
  ADD CONSTRAINT "account_databases_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
