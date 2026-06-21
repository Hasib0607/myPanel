import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailSettingsClient } from "./mail-settings-client";
import Link from "next/link";

export default async function MailSettingsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <PageHeader title={`${domain} Mail Settings`} description="Install, configure, secure, and validate the complete mail service." action={<div className="flex gap-2"><Link className="rounded-md border border-panel-line bg-white px-3 py-2 text-sm font-semibold" href={`/domains/${domain}/mail/diagnostics`}>Diagnostics</Link><Link className="rounded-md border border-panel-line bg-white px-3 py-2 text-sm font-semibold" href={`/domains/${domain}/mail/queue`}>Mail queue</Link></div>} />
      <MailSettingsClient domainId={domain} />
    </AppShell>
  );
}
