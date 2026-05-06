"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiPost } from "@/lib/api";

export function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await apiPost("/auth/logout");
    router.replace("/login");
  }

  return (
    <button
      aria-label="Log out"
      className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-slate-600 hover:bg-slate-100"
      onClick={logout}
      title="Log out"
      type="button"
    >
      <LogOut size={16} />
    </button>
  );
}
