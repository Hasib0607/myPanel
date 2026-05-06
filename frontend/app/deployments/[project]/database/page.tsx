import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DeploymentDatabaseClient } from "./database-client";

export default async function DeploymentDatabasePage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <AppShell>
      <PageHeader title={`${project} Database`} description="Database metadata, secret references, runtime connection material, and staged provisioning controls." />
      <DeploymentDatabaseClient project={project} />
    </AppShell>
  );
}
