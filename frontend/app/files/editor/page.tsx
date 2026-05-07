import { AppShell } from "@/components/app-shell";
import { FileEditorClient } from "@/app/files/editor/file-editor-client";

type EditorPageProps = {
  searchParams: Promise<{ path?: string }>;
};

export default async function FileEditorPage({ searchParams }: EditorPageProps) {
  const params = await searchParams;
  return (
    <AppShell>
      <FileEditorClient initialPath={params.path ?? ""} />
    </AppShell>
  );
}
