import { AppShell } from "@/components/app-shell";
import { DeploymentEnvClient } from "./env-client";

export default async function DeploymentEnvPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return (
    <AppShell>
      <DeploymentEnvClient project={project} />
    </AppShell>
  );
}
