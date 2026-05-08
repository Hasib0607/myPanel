CREATE TYPE "DomainHostingMode" AS ENUM ('PUBLIC_HTML', 'DEPLOYMENT_PROXY', 'REDIRECT');

ALTER TABLE "domains"
  ADD COLUMN "hosting_mode" "DomainHostingMode" NOT NULL DEFAULT 'PUBLIC_HTML',
  ADD COLUMN "document_root" TEXT NOT NULL DEFAULT 'public_html',
  ADD COLUMN "redirect_url" TEXT,
  ADD COLUMN "hosting_deployment_id" TEXT;

CREATE INDEX "domains_hosting_mode_idx" ON "domains"("hosting_mode");
CREATE INDEX "domains_hosting_deployment_id_idx" ON "domains"("hosting_deployment_id");
