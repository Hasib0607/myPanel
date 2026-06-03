import { AccountShell } from "@/components/account-shell";
import { DeploymentsClient } from "@/app/deployments/deployments-client";

export default function AccountDeploymentsPage() {
  return (
    <AccountShell>
      <DeploymentsClient
        apiBase="/account/deployments"
        databasesApiBase="/account/databases"
        domainsApiBase="/account/domains"
        enableGithub={false}
        showPanelUpdate={false}
      />
    </AccountShell>
  );
}
