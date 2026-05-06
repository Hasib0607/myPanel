import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TwoFactorPanel } from "./two-factor-panel";

export default function SecurityPage() {
  return (
    <AppShell>
      <PageHeader title="Security" description="SSH login monitoring, Fail2Ban status, root login posture, and certificate alerts." />
      <section className="space-y-6 p-8">
        <TwoFactorPanel />
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Failed SSH 24h" value="0" />
          <StatCard label="Active Bans" value="0" />
          <StatCard label="Open Ports" value="0" />
          <StatCard label="SSL Expiring" value="0" />
        </div>
        <div className="rounded-md border border-panel-line bg-white p-4">
          <div className="mb-4 text-sm font-semibold">Login Attempts</div>
          <div className="rounded-md border border-dashed border-panel-line p-8 text-center text-sm text-panel-muted">Auth log parser pending VPS connection</div>
        </div>
      </section>
    </AppShell>
  );
}
