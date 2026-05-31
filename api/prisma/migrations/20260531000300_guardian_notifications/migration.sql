CREATE TABLE "guardian_notifications" (
  "id" TEXT NOT NULL,
  "level" "GuardianSeverity" NOT NULL DEFAULT 'INFO',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guardian_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "guardian_notifications_read_created_at_idx" ON "guardian_notifications"("read", "created_at");

CREATE TABLE "guardian_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "guardian_settings_pkey" PRIMARY KEY ("key")
);
