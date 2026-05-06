import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailClient } from "@/app/mail/mail-client";

export default async function DomainInboxPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <PageHeader title={`${domain} Webmail`} description="Inbox, folders, search, bulk actions, and threaded conversation views." />
      <MailClient domainId={domain} />
    </AppShell>
  );
}
