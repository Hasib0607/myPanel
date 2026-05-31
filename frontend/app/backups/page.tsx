import { AppShell } from "@/components/app-shell";
import { BackupsClient } from "./backups-client";

export default function BackupsPage() {
  return (
    <AppShell>
      <BackupsClient />
    </AppShell>
  );
}
