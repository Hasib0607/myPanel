import { AppShell } from "@/components/app-shell";
import { TerminalClient } from "./terminal-client";

export default function TerminalPage() {
  return (
    <AppShell>
      <div className="flex h-[calc(100vh-56px)] lg:h-screen flex-col">
        <div className="flex-shrink-0 border-b border-panel-line px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6 lg:px-8 lg:pt-8">
          <h1 className="text-lg sm:text-xl font-semibold text-panel-ink">Terminal</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-panel-muted">Interactive shell session</p>
        </div>
        <div className="flex-1 p-2 sm:p-4 min-h-0">
          <div className="h-full rounded-lg overflow-hidden border border-panel-line bg-slate-900 shadow-sm">
            <TerminalClient />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
