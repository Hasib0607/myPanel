import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "../account-client";

export default function AccountMailPage() {
  return (
    <AccountShell>
      <AccountClient view="mail" />
    </AccountShell>
  );
}
