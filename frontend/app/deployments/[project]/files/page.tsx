import { DeploymentFilesClient } from "./files-client";

export default async function DeploymentFilesPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return <DeploymentFilesClient project={project} />;
}
