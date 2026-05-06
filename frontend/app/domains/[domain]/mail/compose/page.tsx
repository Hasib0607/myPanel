import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailClient } from "@/app/mail/mail-client";

export default async function ComposeMailPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <PageHeader title={`Compose from ${domain}`} description="Rich-text outgoing mail through the BullMQ SMTP send queue." />
      <MailClient composeFirst domainId={domain} />
    </AppShell>
  );
}
