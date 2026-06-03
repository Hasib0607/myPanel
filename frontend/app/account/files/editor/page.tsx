import { AccountShell } from "@/components/account-shell";
import { FileEditorClient } from "@/app/files/editor/file-editor-client";

type EditorPageProps = {
  searchParams: Promise<{ path?: string }>;
};

export default async function AccountFileEditorPage({ searchParams }: EditorPageProps) {
  const params = await searchParams;
  return (
    <AccountShell>
      <FileEditorClient apiBase="/account/files" initialPath={params.path ?? ""} />
    </AccountShell>
  );
}
