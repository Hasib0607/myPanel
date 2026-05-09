import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DatabasesClient } from "./databases-client";

export default function DatabasesPage() {
  return (
    <AppShell>
      <PageHeader title="Databases" description="Create databases, manage users, rotate passwords, and grant app access." />
      <DatabasesClient />
    </AppShell>
  );
}
