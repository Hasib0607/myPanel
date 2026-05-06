"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy, Database, KeyRound, ListChecks, ServerCog } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { Deployment, PreflightResponse } from "../../deployment-types";
import { Metric, ProjectTabs, ResultNotice } from "../../deployment-ui";

export function DeploymentDatabaseClient({ project }: { project: string }) {
  const [notice, setNotice] = useState("");
  const detail = useQuery({
    queryKey: ["deployment", project],
    queryFn: () => apiGet<Deployment>(`/deployments/${project}`)
  });
  const preflight = useMutation({
    mutationFn: () => apiPost<PreflightResponse>(`/deployments/${project}/preflight`),
    onSuccess: (result) => setNotice(result.ok ? "Database preflight passed." : `Preflight needs attention: ${result.checks.filter((check) => !check.ok).map((check) => check.label).join(", ")}`),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Preflight failed")
  });

  const deployment = detail.data;
  const connection = deployment?.dbType && deployment.dbName && deployment.dbUser
    ? `${deployment.dbType.toLowerCase()}://${deployment.dbUser}:<secret>@localhost/${deployment.dbName}`
    : "Database provisioning metadata pending";

  return (
    <>
      <ProjectTabs active="database" project={project} />
      <section className="space-y-6 p-8">
        {notice ? <ResultNotice message={notice} ok={!/attention|failed|error/i.test(notice)} /> : null}
        <div className="grid grid-cols-4 gap-3">
          <Metric icon={<Database size={16} />} label="Engine" value={deployment?.dbType ?? "None"} />
          <Metric icon={<ServerCog size={16} />} label="Database" value={deployment?.dbName ?? "Not provisioned"} />
          <Metric icon={<KeyRound size={16} />} label="User" value={deployment?.dbUser ?? "Not provisioned"} />
          <Metric icon={<CheckCircle2 size={16} />} label="Secret" value={deployment?.dbPasswordSecretRef ?? "No secret ref"} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
          <main className="rounded-md border border-panel-line bg-white">
            <div className="border-b border-panel-line p-4 text-sm font-semibold">Connection Material</div>
            <div className="space-y-4 p-4">
              <div className="rounded-md bg-slate-50 p-4">
                <div className="mb-2 text-xs uppercase text-panel-muted">Runtime URL</div>
                <div className="break-all font-mono text-sm">{connection}</div>
              </div>
              <div className="rounded-md bg-slate-50 p-4">
                <div className="mb-2 text-xs uppercase text-panel-muted">Recommended env keys</div>
                <pre className="whitespace-pre-wrap font-mono text-sm">{deployment?.dbType === "POSTGRESQL" ? "DATABASE_URL=postgresql://user:<secret>@localhost:5432/db\nDB_CONNECTION=pgsql" : deployment?.dbType === "MYSQL" ? "DATABASE_URL=mysql://user:<secret>@localhost:3306/db\nDB_CONNECTION=mysql" : "Select PostgreSQL or MySQL on the deployment to enable DB provisioning metadata."}</pre>
              </div>
            </div>
          </main>

          <aside className="space-y-3 rounded-md border border-panel-line bg-white p-4">
            <div className="text-sm font-semibold">Database Actions</div>
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50" onClick={() => navigator.clipboard.writeText(connection)} type="button"><Copy size={15} />Copy URL</button>
            <button className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-panel-line text-sm font-medium hover:bg-slate-50" onClick={() => preflight.mutate()} type="button"><ListChecks size={15} />Run Preflight</button>
            <div className="rounded-md border border-dashed border-panel-line p-3 text-xs text-panel-muted">
              Live database creation, credential rotation, backups, and restore flows are intentionally staged for the next backend slice.
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
