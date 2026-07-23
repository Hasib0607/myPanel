CREATE TYPE "DomainHostKind" AS ENUM ('APEX', 'WWW', 'CUSTOM');

CREATE TYPE "DomainHostDnsStatus" AS ENUM ('UNKNOWN', 'PENDING', 'READY', 'MISMATCH');

CREATE TYPE "DomainHostSslStatus" AS ENUM ('MISSING', 'PENDING', 'VALID', 'EXPIRED', 'MISMATCH');

CREATE TABLE "domain_hosts" (
  "id" TEXT NOT NULL,
  "domain_id" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "kind" "DomainHostKind" NOT NULL DEFAULT 'CUSTOM',
  "dns_status" "DomainHostDnsStatus" NOT NULL DEFAULT 'UNKNOWN',
  "dns_records" JSONB NOT NULL DEFAULT '[]',
  "ssl_status" "DomainHostSslStatus" NOT NULL DEFAULT 'MISSING',
  "ssl_enabled" BOOLEAN NOT NULL DEFAULT false,
  "ssl_expiry" TIMESTAMP(3),
  "last_checked_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "domain_hosts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domain_hosts_domain_id_hostname_key" ON "domain_hosts"("domain_id", "hostname");
CREATE INDEX "domain_hosts_hostname_idx" ON "domain_hosts"("hostname");
CREATE INDEX "domain_hosts_dns_status_ssl_status_idx" ON "domain_hosts"("dns_status", "ssl_status");

ALTER TABLE "domain_hosts"
  ADD CONSTRAINT "domain_hosts_domain_id_fkey"
  FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "domain_hosts" (
  "id",
  "domain_id",
  "hostname",
  "kind",
  "dns_status",
  "ssl_status",
  "ssl_enabled",
  "ssl_expiry",
  "created_at",
  "updated_at"
)
SELECT
  concat('dh_', md5("id" || ':apex')),
  "id",
  "name",
  'APEX'::"DomainHostKind",
  'UNKNOWN'::"DomainHostDnsStatus",
  CASE WHEN "ssl_enabled" THEN 'PENDING'::"DomainHostSslStatus" ELSE 'MISSING'::"DomainHostSslStatus" END,
  "ssl_enabled",
  "ssl_expiry",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "domains"
ON CONFLICT ("domain_id", "hostname") DO NOTHING;

INSERT INTO "domain_hosts" (
  "id",
  "domain_id",
  "hostname",
  "kind",
  "dns_status",
  "ssl_status",
  "ssl_enabled",
  "ssl_expiry",
  "created_at",
  "updated_at"
)
SELECT
  concat('dh_', md5("id" || ':www')),
  "id",
  concat('www.', "name"),
  'WWW'::"DomainHostKind",
  'UNKNOWN'::"DomainHostDnsStatus",
  CASE WHEN "ssl_enabled" THEN 'PENDING'::"DomainHostSslStatus" ELSE 'MISSING'::"DomainHostSslStatus" END,
  "ssl_enabled",
  "ssl_expiry",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "domains"
WHERE "name" NOT LIKE '*.%'
  AND array_length(string_to_array("name", '.'), 1) = 2
ON CONFLICT ("domain_id", "hostname") DO NOTHING;
