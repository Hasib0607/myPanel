import { AppShell } from "@/components/app-shell";
import { DomainOverviewClient } from "../domain-overview-client";

export default async function DomainOverviewPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <DomainOverviewClient domainId={domain} />
    </AppShell>
  );
}
