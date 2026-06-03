import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "../account-client";

export default function AccountDeploymentsPage() {
  return (
    <AccountShell>
      <AccountClient view="deployments" />
    </AccountShell>
  );
}
