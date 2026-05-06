import { AppShell } from "@/components/app-shell";
import { MailAccountsClient } from "./mail-accounts-client";

export default async function DomainMailAccountsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <MailAccountsClient domainId={domain} />
    </AppShell>
  );
}
