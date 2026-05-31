ALTER TABLE "deployment_domains" DROP CONSTRAINT "deployment_domains_domain_id_fkey";

DROP INDEX "deployment_domains_deployment_id_domain_id_key";

ALTER TABLE "deployment_domains"
  ALTER COLUMN "domain_id" DROP NOT NULL,
  ADD COLUMN "subdomain_id" TEXT;

CREATE UNIQUE INDEX "deployment_domains_deployment_id_domain_id_key" ON "deployment_domains"("deployment_id", "domain_id");
CREATE UNIQUE INDEX "deployment_domains_deployment_id_subdomain_id_key" ON "deployment_domains"("deployment_id", "subdomain_id");
CREATE INDEX "deployment_domains_subdomain_id_idx" ON "deployment_domains"("subdomain_id");

ALTER TABLE "deployment_domains" ADD CONSTRAINT "deployment_domains_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_domains" ADD CONSTRAINT "deployment_domains_subdomain_id_fkey" FOREIGN KEY ("subdomain_id") REFERENCES "subdomains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_domains" ADD CONSTRAINT "deployment_domains_exactly_one_target_check" CHECK (
  ("domain_id" IS NOT NULL AND "subdomain_id" IS NULL)
  OR ("domain_id" IS NULL AND "subdomain_id" IS NOT NULL)
);
