import { AccountShell } from "@/components/account-shell";
import { AccountClient } from "../account-client";

export default function AccountFilesPage() {
  return (
    <AccountShell>
      <AccountClient view="files" />
    </AccountShell>
  );
}
