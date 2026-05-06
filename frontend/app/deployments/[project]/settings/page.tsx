import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DeploymentSettingsClient } from "./settings-client";

export default async function DeploymentSettingsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <AppShell>
      <PageHeader title={`${project} settings`} description="Edit source connection, runtime commands, paths, port, domain binding, and destructive project actions." />
      <DeploymentSettingsClient project={project} />
    </AppShell>
  );
}
