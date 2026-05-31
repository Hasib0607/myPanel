"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Blocks, Database, Gauge, Globe2, HardDrive, Inbox, UserRound } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";

const nav = [
  { href: "/account", label: "Dashboard", icon: Gauge },
  { href: "/account#domains", label: "Domains", icon: Globe2 },
  { href: "/account#files", label: "Files", icon: HardDrive },
  { href: "/account#mail", label: "Mail", icon: Inbox },
  { href: "/account#deployments", label: "Deployments", icon: Blocks },
  { href: "/account#databases", label: "Databases", icon: Database },
  { href: "/account#profile", label: "Profile", icon: UserRound }
];

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="grid min-h-screen grid-cols-[232px_1fr]">
      <aside className="sticky top-0 h-screen overflow-y-auto border-r border-panel-line bg-white px-3 py-4">
        <div className="mb-6 px-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-semibold">Account Panel</div>
              <div className="text-xs text-panel-muted">scoped hosting workspace</div>
            </div>
            <LogoutButton />
          </div>
        </div>
        <nav className="space-y-1">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = pathname === "/account" && item.href === "/account";
            return (
              <Link
                className={`flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors ${active ? "bg-slate-900 font-medium text-white" : "text-slate-700 hover:bg-slate-100"}`}
                href={item.href}
                key={item.href}
              >
                <Icon size={17} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
