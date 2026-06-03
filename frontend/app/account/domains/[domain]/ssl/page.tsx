import { SslClient } from "@/app/domains/[domain]/ssl/ssl-client";
import { AccountShell } from "@/components/account-shell";

export default async function AccountDomainSslPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;

  return (
    <AccountShell>
      <SslClient domainId={domain} domainApiBase="/account/domains" sslApiBase="/account/ssl" />
    </AccountShell>
  );
}
