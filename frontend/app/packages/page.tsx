import { AppShell } from "@/components/app-shell";
import { PackagesClient } from "./packages-client";

export default function PackagesPage() {
  return (
    <AppShell>
      <PackagesClient />
    </AppShell>
  );
}
