"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Archive, Blocks, Database, Gauge, Globe2, HardDrive, Inbox, Lock, Network, Package, Radar, ServerCog, Settings, Shield, SquareTerminal, Users, Zap } from "lucide-react";
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
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/terminal", label: "Terminal", icon: SquareTerminal },
  { href: "/security", label: "Security", icon: Lock },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
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
              <div className="truncate text-base font-semibold tracking-normal">VPS Panel</div>
            </div>
            <LogoutButton />
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-y-auto lg:overflow-x-visible">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm transition-colors ${
                  pathname === item.href || pathname.startsWith(item.href + "/")
                    ? "bg-white text-slate-950 font-semibold shadow-sm"
                    : "text-slate-300 hover:bg-white/10 hover:text-white"
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
