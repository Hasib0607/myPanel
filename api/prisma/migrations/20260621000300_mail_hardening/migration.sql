CREATE TABLE "mail_bounces" (
    "id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "account_id" TEXT,
    "recipient" TEXT NOT NULL,
    "status" TEXT,
    "diagnostic" TEXT,
    "source_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_bounces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_bounces_domain_id_source_message_id_key" ON "mail_bounces"("domain_id", "source_message_id");
CREATE INDEX "mail_bounces_domain_id_created_at_idx" ON "mail_bounces"("domain_id", "created_at");
CREATE INDEX "mail_bounces_recipient_idx" ON "mail_bounces"("recipient");

ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_bounces" ADD CONSTRAINT "mail_bounces_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "mail_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
