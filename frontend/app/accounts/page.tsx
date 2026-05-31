import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { AccountsClient } from "./accounts-client";

export default function AccountsPage() {
  return (
    <AppShell>
      <PageHeader title="Accounts" description="Create and manage cPanel-style hosting accounts from the WHM-style control plane." />
      <AccountsClient />
    </AppShell>
  );
}
