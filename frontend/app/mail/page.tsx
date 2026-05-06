import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailClient } from "@/app/mail/mail-client";

export default function MailPage() {
  return (
    <AppShell>
      <PageHeader title="Mail Server" description="Mailbox accounts, aliases, authentication status, and webmail queues." />
      <MailClient />
    </AppShell>
  );
}
