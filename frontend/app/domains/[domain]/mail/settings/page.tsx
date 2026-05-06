import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";

export default async function MailSettingsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <PageHeader title={`${domain} Mail Settings`} description="SPF, DKIM, DMARC, PTR reminders, auto-replies, and filters." />
      <section className="p-8">
        <div className="rounded-md border border-panel-line bg-white p-6 text-sm text-panel-muted">Mail authentication status placeholder.</div>
      </section>
    </AppShell>
  );
}
