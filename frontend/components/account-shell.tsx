"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Blocks,
  Database,
  Gauge,
  Github,
  Globe2,
  HardDrive,
  Inbox,
  Menu,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  SquareTerminal,
  UserRound,
  X,
  Zap
} from "lucide-react";
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
  { href: "/account/settings/git", label: "Git", icon: Github },
  { href: "/account/profile", label: "Profile", icon: UserRound }
];

const mobileQuickNav = [
  { href: "/account", label: "Dashboard", icon: Gauge },
  { href: "/account/domains", label: "Domains", icon: Globe2 },
  { href: "/account/files", label: "Files", icon: HardDrive },
  { href: "/account/deployments", label: "Deploy", icon: Blocks }
];

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed } = useSidebarCollapsed();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    if (mobileDrawerOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileDrawerOpen]);

  const currentItem = nav.find((item) =>
    item.href === "/account"
      ? pathname === "/account"
      : pathname === item.href || pathname.startsWith(item.href + "/")
  );

  return (
    <div className={`min-h-screen bg-[#eef3f8] lg:grid ${collapsed ? "lg:grid-cols-[72px_1fr]" : "lg:grid-cols-[260px_1fr]"}`}>
      {/* Mobile & Tablet Header (< lg) */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950 px-4 text-white shadow-md lg:hidden">
        <div className="flex items-center gap-3">
          <button
            aria-label="Open navigation menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95"
            onClick={() => setMobileDrawerOpen(true)}
            type="button"
          >
            <Menu size={19} />
          </button>
          <Link className="flex items-center gap-2" href="/account">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-panel-accent text-white shadow-sm shadow-teal-900/50">
              <Zap size={16} />
            </span>
            <span className="font-semibold text-sm tracking-tight sm:text-base">Account Panel</span>
          </Link>
          {currentItem ? (
            <span className="hidden items-center rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-slate-300 sm:inline-flex">
              {currentItem.label}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {currentItem ? (
            <span className="inline-flex rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-slate-300 sm:hidden">
              {currentItem.label}
            </span>
          ) : null}
          <LogoutButton />
        </div>
      </header>

      {/* Mobile Drawer (Slide-out navigation for mobile and tablet) */}
      {mobileDrawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Backdrop */}
          <div
            aria-hidden="true"
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm transition-opacity"
            onClick={() => setMobileDrawerOpen(false)}
          />

          {/* Drawer Content */}
          <div className="fixed inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-slate-800 bg-slate-950 text-white shadow-2xl transition-transform">
            {/* Drawer Header */}
            <div className="flex h-14 items-center justify-between border-b border-slate-800/80 px-4">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-panel-accent text-white shadow-md shadow-teal-900/50">
                  <Zap size={16} />
                </span>
                <span className="text-base font-semibold tracking-tight">Account Panel</span>
              </div>
              <button
                aria-label="Close navigation menu"
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/10 text-slate-300 hover:bg-white/20 hover:text-white"
                onClick={() => setMobileDrawerOpen(false)}
                type="button"
              >
                <X size={17} />
              </button>
            </div>

            {/* Drawer Links */}
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
              <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Menu
              </div>
              {nav.map((item) => {
                const Icon = item.icon;
                const active =
                  item.href === "/account"
                    ? pathname === "/account"
                    : pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileDrawerOpen(false)}
                    className={`flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${
                      active
                        ? "bg-panel-accent text-white shadow-sm font-semibold"
                        : "text-slate-300 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <Icon className="shrink-0" size={18} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            {/* Drawer Footer */}
            <div className="border-t border-slate-800/80 p-3">
              <div className="flex items-center justify-between rounded-lg bg-white/5 p-2 text-xs text-slate-400">
                <span>Account Mode</span>
                <LogoutButton />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Desktop Sidebar (lg+) */}
      <aside
        className={`hidden lg:sticky lg:top-0 lg:z-30 lg:flex lg:h-screen lg:flex-col lg:border-r lg:border-slate-800 lg:bg-slate-950 lg:py-3 lg:text-white lg:shadow-xl lg:transition-[width,padding] lg:duration-200 ${
          collapsed ? "lg:px-2" : "lg:px-3"
        }`}
      >
        <div className={`mb-4 ${collapsed ? "lg:px-0" : "lg:px-2"}`}>
          <div className={`flex items-center gap-2 ${collapsed ? "lg:flex-col lg:gap-3" : "justify-between"}`}>
            <div className={`flex min-w-0 items-center gap-2 ${collapsed ? "lg:w-full lg:justify-center" : ""}`}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-panel-accent text-white shadow-lg shadow-teal-950/40">
                <Zap size={18} />
              </span>
              <div className={`truncate text-base font-semibold ${collapsed ? "lg:hidden" : ""}`}>
                Account Panel
              </div>
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
        <nav className="space-y-1 overflow-y-auto">
          {nav.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === "/account"
                ? pathname === "/account"
                : pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                className={`flex h-10 shrink-0 items-center gap-3 rounded-md px-3 text-sm transition-colors ${
                  collapsed ? "lg:justify-center lg:gap-0 lg:px-0" : ""
                } ${
                  active
                    ? "bg-white font-semibold text-slate-950 shadow-sm"
                    : "text-slate-300 hover:bg-white/10 hover:text-white"
                }`}
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

      {/* Main Page Content */}
      <main className="min-w-0 pb-16 sm:pb-0">{children}</main>

      {/* Mobile Quick Bottom Navigation (< sm screens) */}
      <nav
        aria-label="Mobile quick navigation"
        className="fixed bottom-0 inset-x-0 z-30 flex h-14 items-center justify-around border-t border-slate-800/90 bg-slate-950/95 px-2 py-1 backdrop-blur-md sm:hidden text-white"
      >
        {mobileQuickNav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center py-1 px-2 text-[10px] font-medium transition-colors ${
                active ? "text-teal-400 font-semibold" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Icon size={19} className="mb-0.5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => setMobileDrawerOpen(true)}
          className="flex flex-col items-center justify-center py-1 px-2 text-[10px] font-medium text-slate-400 hover:text-slate-200 transition-colors"
          type="button"
        >
          <Menu size={19} className="mb-0.5" />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
