ALTER TABLE "trusted_login_devices"
  ADD COLUMN "webauthn_credential_id" TEXT,
  ADD COLUMN "webauthn_public_key" TEXT,
  ADD COLUMN "webauthn_sign_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "webauthn_registered_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "trusted_login_devices_webauthn_credential_id_key"
  ON "trusted_login_devices"("webauthn_credential_id");
