import { FileEditorClient } from "@/app/files/editor/file-editor-client";

type DeploymentFileEditorPageProps = {
  searchParams: Promise<{ path?: string }>;
};

export default async function DeploymentFileEditorPage({ searchParams }: DeploymentFileEditorPageProps) {
  const params = await searchParams;
  return <FileEditorClient initialPath={params.path ?? ""} />;
}
