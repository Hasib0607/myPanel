import { AppShell } from "@/components/app-shell";
import { SslClient } from "./ssl-client";

export default async function DomainSslPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AppShell>
      <SslClient domainId={domain} />
    </AppShell>
  );
}
