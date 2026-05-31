import { AppShell } from "@/components/app-shell";
import { GuardianClient } from "./guardian-client";

export default function GuardianPage() {
  return (
    <AppShell>
      <GuardianClient />
    </AppShell>
  );
}
