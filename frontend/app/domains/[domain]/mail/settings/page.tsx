import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailSettingsClient } from "./mail-settings-client";

export default async function MailSettingsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <PageHeader title={`${domain} Mail Settings`} description="SPF, DKIM, DMARC, PTR reminders, auto-replies, and filters." />
      <MailSettingsClient domainId={domain} />
    </AppShell>
  );
}
