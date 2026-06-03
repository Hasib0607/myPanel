import { AccountShell } from "@/components/account-shell";
import { FileManagerClient } from "@/app/files/file-manager-client";

export default function AccountFilesPage() {
  return (
    <AccountShell>
      <FileManagerClient
        apiBase="/account/files"
        domainsApiBase="/account/domains"
        editorBase="/account/files/editor"
        enableGithubPull={false}
        rootHintPrefix="/account"
      />
    </AccountShell>
  );
}
