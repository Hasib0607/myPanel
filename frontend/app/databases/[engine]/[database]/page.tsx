import { AppShell } from "@/components/app-shell";
import { DatabaseBrowserClient } from "../../database-browser-client";

export default async function DatabaseBrowserPage({ params }: { params: Promise<{ engine: string; database: string }> }) {
  const { engine, database } = await params;
  return (
    <AppShell>
      <DatabaseBrowserClient
        backHref="/databases"
        database={decodeURIComponent(database)}
        engine={engine === "MYSQL" ? "MYSQL" : "POSTGRESQL"}
      />
    </AppShell>
  );
}
