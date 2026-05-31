import { AppShell } from "@/components/app-shell";
import { WhmMigrationClient } from "./whm-migration-client";

export default function WhmMigrationPage() {
  return (
    <AppShell>
      <WhmMigrationClient />
    </AppShell>
  );
}
