import { AppShell } from "@/components/app-shell";
import { SubdomainsClient } from "./subdomains-client";

export default async function SubdomainsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <SubdomainsClient domainId={domain} />
    </AppShell>
  );
}
