import { AppShell } from "@/components/app-shell";
import { DeploymentsClient } from "./deployments-client";

export default function DeploymentsPage() {
  return (
    <AppShell>
      <DeploymentsClient />
    </AppShell>
  );
}
