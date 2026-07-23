ALTER TABLE "domain_hosts" ADD COLUMN "subdomain_id" TEXT;

CREATE INDEX "domain_hosts_subdomain_id_idx" ON "domain_hosts"("subdomain_id");

ALTER TABLE "domain_hosts"
  ADD CONSTRAINT "domain_hosts_subdomain_id_fkey"
  FOREIGN KEY ("subdomain_id") REFERENCES "subdomains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "domain_hosts" (
  "id",
  "domain_id",
  "subdomain_id",
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
  concat('dh_', md5("subdomains"."id" || ':subdomain')),
  "subdomains"."domain_id",
  "subdomains"."id",
  concat("subdomains"."name", '.', "domains"."name"),
  'CUSTOM'::"DomainHostKind",
  'UNKNOWN'::"DomainHostDnsStatus",
  CASE WHEN "subdomains"."ssl_enabled" THEN 'PENDING'::"DomainHostSslStatus" ELSE 'MISSING'::"DomainHostSslStatus" END,
  "subdomains"."ssl_enabled",
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "subdomains"
INNER JOIN "domains" ON "domains"."id" = "subdomains"."domain_id"
ON CONFLICT ("domain_id", "hostname") DO UPDATE SET
  "subdomain_id" = EXCLUDED."subdomain_id",
  "updated_at" = CURRENT_TIMESTAMP;
