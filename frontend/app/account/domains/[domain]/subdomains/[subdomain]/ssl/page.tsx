import { SslClient } from "@/app/domains/[domain]/ssl/ssl-client";
import { AccountShell } from "@/components/account-shell";

export default async function AccountSubdomainSslPage({ params }: { params: Promise<{ domain: string; subdomain: string }> }) {
  const { domain, subdomain } = await params;

  return (
    <AccountShell>
      <SslClient domainId={domain} subdomainId={subdomain} domainApiBase="/account/domains" sslApiBase="/account/ssl" />
    </AccountShell>
  );
}
