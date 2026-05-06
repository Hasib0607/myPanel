import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DeploymentsClient } from "./deployments-client";

export default function DeploymentsPage() {
  return (
    <AppShell>
      <PageHeader title="Deployments" description="Import, configure, deploy, monitor, and operate projects from one production-focused cockpit." />
      <DeploymentsClient />
    </AppShell>
  );
}
