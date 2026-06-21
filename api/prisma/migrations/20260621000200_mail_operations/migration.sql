ALTER TABLE "domains"
  ADD COLUMN "mail_dkim_selector" TEXT NOT NULL DEFAULT 'mail',
  ADD COLUMN "mail_dmarc_policy" TEXT NOT NULL DEFAULT 'quarantine',
  ADD COLUMN "mail_spf_include" TEXT,
  ADD COLUMN "mail_spf_custom" TEXT,
  ADD COLUMN "mail_bounce_address" TEXT,
  ADD COLUMN "mail_pop3_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "mail_accounts"
  ADD COLUMN "smtp_suspended" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "daily_send_limit" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN "minute_send_limit" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "sent_today" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "send_counter_date" TIMESTAMP(3);
