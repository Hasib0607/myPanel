import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { DeploymentEnvClient } from "./env-client";

export default async function DeploymentEnvPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <AppShell>
      <PageHeader title={`${project} Environment`} description="Edit deployment variables, secret references, and .env imports without leaving the project." />
      <DeploymentEnvClient project={project} />
    </AppShell>
  );
}
