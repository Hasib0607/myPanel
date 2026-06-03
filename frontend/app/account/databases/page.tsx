import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "../account-client";

export default function AccountDatabasesPage() {
  return (
    <AccountShell>
      <AccountClient view="databases" />
    </AccountShell>
  );
}
