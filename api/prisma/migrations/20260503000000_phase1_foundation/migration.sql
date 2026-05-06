-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DnsRecordType" AS ENUM ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA');

-- CreateEnum
CREATE TYPE "MailFolder" AS ENUM ('INBOX', 'SENT', 'DRAFTS', 'SPAM', 'TRASH');

-- CreateEnum
CREATE TYPE "DeploymentFramework" AS ENUM ('LARAVEL', 'NEXTJS', 'NODEJS', 'PYTHON', 'GO');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('RUNNING', 'STOPPED', 'DEPLOYING', 'FAILED');

-- CreateEnum
CREATE TYPE "DatabaseType" AS ENUM ('POSTGRESQL', 'MYSQL');

-- CreateEnum
CREATE TYPE "FirewallAction" AS ENUM ('ALLOW', 'DENY', 'LIMIT');

-- CreateEnum
CREATE TYPE "FirewallDirection" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "ssl_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ssl_expiry" TIMESTAMP(3),
    "force_ssl" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subdomains" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "ssl_enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "subdomains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_records" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "type" "DnsRecordType" NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "ttl" INTEGER NOT NULL DEFAULT 3600,
    "priority" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dns_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_accounts" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "quota_mb" INTEGER NOT NULL DEFAULT 1024,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_aliases" (
    "id" TEXT NOT NULL,
    "account_id" TEXT,
    "domain_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,

    CONSTRAINT "mail_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mails" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "folder" "MailFolder" NOT NULL DEFAULT 'INBOX',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_starred" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "framework" "DeploymentFramework" NOT NULL,
    "repo_url" TEXT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "root_path" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'STOPPED',
    "port" INTEGER NOT NULL,
    "env_vars" JSONB NOT NULL DEFAULT '{}',
    "db_type" "DatabaseType",
    "db_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firewall_rules" (
    "id" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'tcp',
    "direction" "FirewallDirection" NOT NULL DEFAULT 'IN',
    "action" "FirewallAction" NOT NULL,
    "source_ip" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firewall_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "superadmin_security" (
    "id" TEXT NOT NULL DEFAULT 'superadmin',
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "totp_secret_encrypted" TEXT,
    "recovery_codes_hash" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_totp_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "superadmin_security_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domains_name_key" ON "domains"("name");

-- CreateIndex
CREATE INDEX "domains_name_idx" ON "domains"("name");

-- CreateIndex
CREATE UNIQUE INDEX "subdomains_domain_id_name_key" ON "subdomains"("domain_id", "name");

-- CreateIndex
CREATE INDEX "dns_records_domain_id_type_idx" ON "dns_records"("domain_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "mail_accounts_domain_id_username_key" ON "mail_accounts"("domain_id", "username");

-- CreateIndex
CREATE INDEX "mail_aliases_domain_id_idx" ON "mail_aliases"("domain_id");

-- CreateIndex
CREATE UNIQUE INDEX "mails_message_id_key" ON "mails"("message_id");

-- CreateIndex
CREATE INDEX "mails_account_id_folder_idx" ON "mails"("account_id", "folder");

-- CreateIndex
CREATE INDEX "mails_received_at_idx" ON "mails"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "deployments_domain_id_key" ON "deployments"("domain_id");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "firewall_rules_port_protocol_idx" ON "firewall_rules"("port", "protocol");

-- AddForeignKey
ALTER TABLE "subdomains" ADD CONSTRAINT "subdomains_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mail_aliases" ADD CONSTRAINT "mail_aliases_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mails" ADD CONSTRAINT "mails_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
