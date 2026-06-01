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
      className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 bg-white/10 text-current hover:bg-white/15"
      onClick={logout}
      title="Log out"
      type="button"
    >
      <LogOut size={16} />
    </button>
  );
}
