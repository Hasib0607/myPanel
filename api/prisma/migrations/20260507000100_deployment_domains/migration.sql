CREATE TABLE "deployment_domains" (
  "id" TEXT NOT NULL,
  "deployment_id" TEXT NOT NULL,
  "domain_id" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'alias',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deployment_domains_pkey" PRIMARY KEY ("id")
);

INSERT INTO "deployment_domains" ("id", "deployment_id", "domain_id", "role", "created_at")
SELECT 'dd_' || "id", "id", "domain_id", 'primary', CURRENT_TIMESTAMP
FROM "deployments"
WHERE "domain_id" IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "deployment_domains_deployment_id_domain_id_key" ON "deployment_domains"("deployment_id", "domain_id");
CREATE INDEX "deployment_domains_domain_id_idx" ON "deployment_domains"("domain_id");

ALTER TABLE "deployment_domains"
  ADD CONSTRAINT "deployment_domains_deployment_id_fkey"
  FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployment_domains"
  ADD CONSTRAINT "deployment_domains_domain_id_fkey"
  FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
