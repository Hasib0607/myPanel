import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { FileManagerClient } from "@/app/files/file-manager-client";

export default function FilesPage() {
  return (
    <AppShell>
      <PageHeader title="File Manager" description="Scoped browser file manager with editor, archive tools, previews, and permissions." />
      <FileManagerClient />
    </AppShell>
  );
}
