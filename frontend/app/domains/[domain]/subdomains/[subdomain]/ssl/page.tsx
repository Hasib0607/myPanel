import { AppShell } from "@/components/app-shell";
import { SslClient } from "../../../ssl/ssl-client";

export default async function SubdomainSslPage({ params }: { params: Promise<{ domain: string; subdomain: string }> }) {
  const { domain, subdomain } = await params;

  return (
    <AppShell>
      <SslClient domainId={domain} subdomainId={subdomain} />
    </AppShell>
  );
}
