import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "./account-client";

export default function AccountPage() {
  return (
    <AccountShell>
      <AccountClient />
    </AccountShell>
  );
}
