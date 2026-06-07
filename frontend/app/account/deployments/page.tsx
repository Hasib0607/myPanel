import { AccountShell } from "@/components/account-shell";
import { DeploymentsClient } from "@/app/deployments/deployments-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function AccountDeploymentsPage() {
  return (
    <AccountShell>
      <DeploymentsClient
        apiBase="/account/deployments"
        databasesApiBase="/account/databases"
        domainsApiBase="/account/domains"
        githubApiBase="/account/deployments/github"
        enableGithub
        showPanelUpdate={false}
      />
    </AccountShell>
  );
}
