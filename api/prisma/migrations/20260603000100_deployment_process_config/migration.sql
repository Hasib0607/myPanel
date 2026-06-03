ALTER TABLE "deployments"
  ADD COLUMN "process_config" JSONB NOT NULL DEFAULT '{}';
