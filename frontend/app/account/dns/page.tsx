import { AccountShell } from "@/components/account-shell";
import { AccountDnsClient } from "./account-dns-client";

export default function AccountDnsPage() {
  return (
    <AccountShell>
      <AccountDnsClient />
    </AccountShell>
  );
}
