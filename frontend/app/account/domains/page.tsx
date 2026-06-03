import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "../account-client";

export default function AccountDomainsPage() {
  return (
    <AccountShell>
      <AccountClient view="domains" />
    </AccountShell>
  );
}
