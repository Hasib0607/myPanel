"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Blocks, Database, Gauge, Globe2, HardDrive, Inbox, UserRound, Zap } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";

const nav = [
  { href: "/account", label: "Dashboard", icon: Gauge },
  { href: "/account/domains", label: "Domains", icon: Globe2 },
  { href: "/account/files", label: "Files", icon: HardDrive },
  { href: "/account/mail", label: "Mail", icon: Inbox },
  { href: "/account/deployments", label: "Deployments", icon: Blocks },
  { href: "/account/databases", label: "Databases", icon: Database },
  { href: "/account/profile", label: "Profile", icon: UserRound }
];

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[#eef3f8] grid-cols-[260px_1fr] lg:grid">
      <aside className="sticky top-0 z-30 flex max-h-screen flex-col border-b border-slate-800 bg-slate-950 px-3 py-3 text-white shadow-xl lg:h-screen lg:border-b-0 lg:border-r">
        <div className="mb-4 px-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-panel-accent text-white shadow-lg shadow-teal-950/40">
                <Zap size={18} />
              </span>
              <div className="truncate text-base font-semibold">Account Panel</div>
            </div>
            <LogoutButton />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-y-auto lg:overflow-x-visible">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/account" ? pathname === "/account" : pathname.startsWith(item.href);
            return (
              <Link
                className={`flex h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm transition-colors ${active ? "bg-white font-semibold text-slate-950 shadow-sm" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}
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
