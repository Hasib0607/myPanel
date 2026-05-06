import { AppShell } from "@/components/app-shell";
import { DomainsClient } from "./domains-client";

export default function DomainsPage() {
  return (
    <AppShell>
      <DomainsClient />
    </AppShell>
  );
}
