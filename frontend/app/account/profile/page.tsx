import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "../account-client";

export default function AccountProfilePage() {
  return (
    <AccountShell>
      <AccountClient view="profile" />
    </AccountShell>
  );
}
