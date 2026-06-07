import { AppShell } from "@/components/app-shell";
import { DeploymentsClient } from "./deployments-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DeploymentsPage() {
  return (
    <AppShell>
      <DeploymentsClient />
    </AppShell>
  );
}
