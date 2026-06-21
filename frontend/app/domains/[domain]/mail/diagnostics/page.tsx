import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { MailDiagnosticsClient } from "./mail-diagnostics-client";

export default async function MailDiagnosticsPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  return <AppShell><PageHeader title="Mail Diagnostics" description="Live service, listener, TLS, authentication protection, and DNS checks." /><MailDiagnosticsClient domainId={domain} /></AppShell>;
}
