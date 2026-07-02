import { AppShell } from "@/components/app-shell";
import { GitConnectionSettings } from "@/components/git-connection-settings";

export default function GitSettingsPage() {
  return (
    <AppShell>
      <GitConnectionSettings apiBase="/deployments/github" scopeLabel="Panel-wide GitHub access for admin deployments and file operations." />
    </AppShell>
  );
}
