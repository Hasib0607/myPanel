import { AppShell } from "@/components/app-shell";
import { AccountDetailClient } from "./account-detail-client";

export default async function AccountDetailPage({ params }: { params: Promise<{ account: string }> }) {
  const { account } = await params;
  return (
    <AppShell>
      <AccountDetailClient accountId={account} />
    </AppShell>
  );
}
