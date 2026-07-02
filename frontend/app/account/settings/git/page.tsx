import { AccountShell } from "@/components/account-shell";
import { GitConnectionSettings } from "@/components/git-connection-settings";

export default function AccountGitSettingsPage() {
  return (
    <AccountShell>
      <GitConnectionSettings apiBase="/account/deployments/github" scopeLabel="Account GitHub access for this account's deployments." />
    </AccountShell>
  );
}
