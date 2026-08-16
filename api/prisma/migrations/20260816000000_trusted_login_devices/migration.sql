CREATE TABLE "trusted_login_devices" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'superadmin',
    "fingerprint_hash" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "label" TEXT,
    "user_agent" TEXT,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trusted_login_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trusted_login_devices_role_username_fingerprint_hash_key" ON "trusted_login_devices"("role", "username", "fingerprint_hash");
CREATE INDEX "trusted_login_devices_role_username_revoked_at_idx" ON "trusted_login_devices"("role", "username", "revoked_at");
