import { AppShell } from "@/components/app-shell";
import { TerminalClient } from "@/app/terminal/terminal-client";

export default async function AccountTerminalPage({ params }: { params: Promise<{ account: string }> }) {
  const { account } = await params;

  return (
    <AppShell>
      <div className="flex h-[calc(100vh-56px)] lg:h-screen flex-col">
        <div className="flex-shrink-0 border-b border-panel-line px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6 lg:px-8 lg:pt-8">
          <h1 className="text-lg sm:text-xl font-semibold text-panel-ink">Account Terminal</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-panel-muted">Interactive shell session scoped to this account home.</p>
        </div>
        <div className="min-h-0 flex-1 p-2 sm:p-4">
          <div className="h-full overflow-hidden rounded-lg border border-panel-line bg-slate-900 shadow-sm">
            <TerminalClient accountId={account} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
