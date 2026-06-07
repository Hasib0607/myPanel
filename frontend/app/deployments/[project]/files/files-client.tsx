"use client";

import { useQuery } from "@tanstack/react-query";
import { FileManagerClient } from "@/app/files/file-manager-client";
import { apiGet } from "@/lib/api";
import type { Deployment } from "../../deployment-types";
import { EmptyState, ProjectTabs } from "../../deployment-ui";

export function DeploymentFilesClient({ project }: { project: string }) {
  const detail = useQuery({
    queryKey: ["deployment", project],
    queryFn: () => apiGet<Deployment>(`/deployments/${project}`),
    refetchInterval: 8000
  });
  const deployment = detail.data;
  const projectPath = deployment ? deploymentAppStoragePath(deployment) : "";
  const relativePath = deployment ? projectStorageRelativePath(projectPath, "/var/www") : null;

  return (
    <>
      <ProjectTabs active="files" project={project} />
      <section className="space-y-5 p-8">
        {deployment && relativePath ? (
          <div className="overflow-hidden rounded-md border border-panel-line bg-white">
            <FileManagerClient
              apiBase="/files"
              editorBase={null}
              embedded
              enableGithubPull={false}
              fixedRoot={{
                id: `deployment:${deployment.id}`,
                label: deployment.name,
                path: relativePath,
                hint: projectPath
              }}
            />
          </div>
        ) : detail.isLoading ? (
          <div className="rounded-md border border-panel-line bg-white p-8 text-sm text-panel-muted">Loading deployment files...</div>
        ) : deployment ? (
          <EmptyState title="Storage unavailable" detail="Project storage is outside the configured file manager root." />
        ) : (
          <EmptyState title="Deployment not found" detail="The project slug or id did not return a deployment." />
        )}
      </section>
    </>
  );
}

function deploymentAppStoragePath(deployment: Deployment) {
  const cleanRoot = deployment.rootPath.replace(/\/+$/, "");
  const cleanDirectory = (deployment.rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return cleanDirectory && cleanDirectory !== "." ? `${cleanRoot}/${cleanDirectory}` : cleanRoot;
}

function projectStorageRelativePath(projectPath: string, rootPrefix: string) {
  const cleanPath = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const cleanRoot = rootPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
  if (cleanPath === cleanRoot) return ".";
  if (!cleanPath.startsWith(`${cleanRoot}/`)) return null;
  return cleanPath.slice(cleanRoot.length + 1) || ".";
}
