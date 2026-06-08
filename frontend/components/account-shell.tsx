"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Blocks, Database, Gauge, Globe2, HardDrive, Inbox, Network, PanelLeftClose, PanelLeftOpen, SquareTerminal, UserRound, Zap } from "lucide-react";
import { LogoutButton } from "@/components/logout-button";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";

const nav = [
  { href: "/account", label: "Dashboard", icon: Gauge },
  { href: "/account/domains", label: "Domains", icon: Globe2 },
  { href: "/account/dns", label: "DNS", icon: Network },
  { href: "/account/files", label: "Files", icon: HardDrive },
  { href: "/account/mail", label: "Mail", icon: Inbox },
  { href: "/account/deployments", label: "Deployments", icon: Blocks },
  { href: "/account/databases", label: "Databases", icon: Database },
  { href: "/account/terminal", label: "Terminal", icon: SquareTerminal },
  { href: "/account/profile", label: "Profile", icon: UserRound }
];

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed } = useSidebarCollapsed();

  return (
    <div className={`min-h-screen bg-[#eef3f8] lg:grid ${collapsed ? "lg:grid-cols-[72px_1fr]" : "lg:grid-cols-[260px_1fr]"}`}>
      <aside className={`sticky top-0 z-30 flex max-h-screen flex-col border-b border-slate-800 bg-slate-950 py-3 text-white shadow-xl transition-[width,padding] duration-200 lg:h-screen lg:border-b-0 lg:border-r ${collapsed ? "px-2 lg:px-2" : "px-3"}`}>
        <div className={`mb-4 ${collapsed ? "px-0 lg:px-0" : "px-2"}`}>
          <div className={`flex items-center gap-2 ${collapsed ? "lg:flex-col lg:gap-3" : "justify-between"}`}>
            <div className={`flex min-w-0 items-center gap-2 ${collapsed ? "lg:w-full lg:justify-center" : ""}`}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-panel-accent text-white shadow-lg shadow-teal-950/40">
                <Zap size={18} />
              </span>
              <div className={`truncate text-base font-semibold ${collapsed ? "lg:hidden" : ""}`}>Account Panel</div>
            </div>
            <div className={`flex items-center gap-2 ${collapsed ? "lg:w-full lg:flex-col" : ""}`}>
              <button
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="hidden h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white/10 text-current hover:bg-white/15 lg:flex"
                onClick={toggleCollapsed}
                title={collapsed ? "Expand menu" : "Collapse menu"}
                type="button"
              >
                {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </button>
              <LogoutButton />
            </div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-y-auto lg:overflow-x-visible">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/account" ? pathname === "/account" : pathname.startsWith(item.href);
            return (
              <Link
                className={`flex h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm transition-colors ${
                  collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
                } ${active ? "bg-white font-semibold text-slate-950 shadow-sm" : "text-slate-300 hover:bg-white/10 hover:text-white"}`}
                href={item.href}
                key={item.href}
                title={item.label}
              >
                <Icon className="shrink-0" size={17} />
                <span className={collapsed ? "lg:hidden" : ""}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}
