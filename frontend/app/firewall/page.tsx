import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { FirewallClient } from "@/app/firewall/firewall-client";

export default function FirewallPage() {
  return (
    <AppShell>
      <PageHeader title="Firewall" description="Firewall rule management, presets, allowlists, blocklists, and SSH hardening." />
      <FirewallClient />
    </AppShell>
  );
}
