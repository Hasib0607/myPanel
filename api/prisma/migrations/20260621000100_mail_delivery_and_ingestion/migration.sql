ALTER TABLE "mails"
  ADD COLUMN "body_text" TEXT,
  ADD COLUMN "body_html" TEXT,
  ADD COLUMN "delivery_status" TEXT NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "delivery_error" TEXT,
  ADD COLUMN "sent_at" TIMESTAMP(3);

UPDATE "mails"
SET "delivery_status" = 'SENT', "sent_at" = "received_at"
WHERE "folder" = 'SENT';

DROP INDEX IF EXISTS "mails_message_id_key";
CREATE UNIQUE INDEX "mails_account_id_message_id_key" ON "mails"("account_id", "message_id");
