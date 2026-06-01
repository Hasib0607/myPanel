import { AppShell } from "@/components/app-shell";
import { DeploymentHistoryClient } from "./history-client";

export default async function DeploymentHistoryPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <AppShell>
      <DeploymentHistoryClient project={project} />
    </AppShell>
  );
}
