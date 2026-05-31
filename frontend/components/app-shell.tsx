"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Blocks, Database, Gauge, Globe2, HardDrive, Inbox, Lock, Network, Package, Radar, ServerCog, Shield, SquareTerminal, Users } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/accounts", label: "Accounts", icon: Users },
  { href: "/packages", label: "Packages", icon: Package },
  { href: "/whm-migration", label: "WHM Migration", icon: ServerCog },
  { href: "/domains", label: "Domains", icon: Globe2 },
  { href: "/guardian", label: "Guardian", icon: Radar },
  { href: "/dns", label: "DNS", icon: Network },
  { href: "/mail", label: "Mail", icon: Inbox },
  { href: "/firewall", label: "Firewall", icon: Shield },
  { href: "/files", label: "Files", icon: HardDrive },
  { href: "/deployments", label: "Deployments", icon: Blocks },
  { href: "/databases", label: "Databases", icon: Database },
  { href: "/terminal", label: "Terminal", icon: SquareTerminal },
  { href: "/security", label: "Security", icon: Lock }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen grid grid-cols-[232px_1fr]">
      <aside className="sticky top-0 h-screen border-r border-panel-line bg-white px-3 py-4 overflow-y-auto">
        <div className="mb-6 px-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-semibold">VPS Panel</div>
              <div className="text-xs text-panel-muted">single-admin control plane</div>
            </div>
            <LogoutButton />
          </div>
        </div>
        <nav className="space-y-1">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors ${
                  pathname === item.href || pathname.startsWith(item.href + "/")
                    ? "bg-slate-900 text-white font-medium"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
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
