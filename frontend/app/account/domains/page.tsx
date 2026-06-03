import { AccountShell } from "@/components/account-shell";
import { DomainsClient } from "@/app/domains/domains-client";

export default function AccountDomainsPage() {
  return (
    <AccountShell>
      <DomainsClient
        apiBase="/account/domains"
        deploymentApiBase="/account/deployments"
        headerDescription="Manage this account's domains with the same controls as the main panel, scoped to this account only."
        linkBase="/account/domains"
      />
    </AccountShell>
  );
}
