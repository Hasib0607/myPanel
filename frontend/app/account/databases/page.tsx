import { DatabasesClient } from "@/app/databases/databases-client";
import { AccountShell } from "@/components/account-shell";

export default function AccountDatabasesPage() {
  return (
    <AccountShell>
      <DatabasesClient apiBase="/account/databases" />
    </AccountShell>
  );
}
