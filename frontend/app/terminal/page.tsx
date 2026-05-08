import { AppShell } from "@/components/app-shell";
import { TerminalClient } from "./terminal-client";

export default function TerminalPage() {
  return (
    <AppShell>
      <div className="flex flex-col h-screen">
        <div className="px-8 pt-8 pb-4 border-b border-panel-line flex-shrink-0">
          <h1 className="text-xl font-semibold">Terminal</h1>
          <p className="text-sm text-panel-muted mt-1">Interactive shell session</p>
        </div>
        <div className="flex-1 p-4 min-h-0">
          <div className="h-full rounded-lg overflow-hidden border border-panel-line bg-slate-900">
            <TerminalClient />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
