import { AccountShell } from "@/components/account-shell";
import { TerminalClient } from "@/app/terminal/terminal-client";

export default function AccountTerminalPage() {
  return (
    <AccountShell>
      <div className="flex h-screen flex-col">
        <div className="flex-shrink-0 border-b border-panel-line px-8 pb-4 pt-8">
          <h1 className="text-xl font-semibold">Terminal</h1>
          <p className="mt-1 text-sm text-panel-muted">Interactive shell session scoped to your account home.</p>
        </div>
        <div className="min-h-0 flex-1 p-4">
          <div className="h-full overflow-hidden rounded-lg border border-panel-line bg-slate-900">
            <TerminalClient endpointPath="/terminal/account/ws" />
          </div>
        </div>
      </div>
    </AccountShell>
  );
}
