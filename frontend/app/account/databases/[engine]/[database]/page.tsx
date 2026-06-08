import { DatabaseBrowserClient } from "@/app/databases/database-browser-client";
import { AccountShell } from "@/components/account-shell";

export default async function AccountDatabaseBrowserPage({ params }: { params: Promise<{ engine: string; database: string }> }) {
  const { engine, database } = await params;
  return (
    <AccountShell>
      <DatabaseBrowserClient
        apiBase="/account/databases"
        backHref="/account/databases"
        database={decodeURIComponent(database)}
        engine={engine === "MYSQL" ? "MYSQL" : "POSTGRESQL"}
      />
    </AccountShell>
  );
}
