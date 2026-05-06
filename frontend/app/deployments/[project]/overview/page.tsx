import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DeploymentOverviewClient } from "./overview-client";

export default async function DeploymentOverviewPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <AppShell>
      <PageHeader title={project} description="Deployment status, linked domain, process manager, build pipeline, releases, and actions." />
      <DeploymentOverviewClient project={project} />
    </AppShell>
  );
}
