"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, FolderGit2, Globe2, HeartPulse, KeyRound, ListChecks, RefreshCw, TerminalSquare } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { Deployment, PreflightResponse, QueueResponse } from "../../deployment-types";
import { ActionButton, DeploymentSummary, EmptyState, Metric, ProjectTabs, ResultNotice, actionIcon, formatDate, formatDuration, statusBadge } from "../../deployment-ui";

export function DeploymentOverviewClient({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["deployment", project],
    queryFn: () => apiGet<Deployment>(`/deployments/${project}`),
    refetchInterval: 8000
  });
  const [notice, setNotice] = useStateMessage();

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
  };

  const action = useMutation({
    mutationFn: (name: "deploy" | "redeploy" | "pull" | "rollback" | "start" | "stop" | "restart" | "health" | "preflight") => apiPost<QueueResponse | PreflightResponse>(`/deployments/${project}/${name}`),
    onSuccess: async (_result, name) => {
      setNotice(`${name} requested.`);
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Action failed")
  });

  const deployment = detail.data;

  return (
    <>
      <ProjectTabs active="overview" project={project} />
      <section className="space-y-6 p-8">
        {notice ? <ResultNotice message={notice} ok={!/failed|error|attention/i.test(notice)} /> : null}
        {deployment ? (
          <>
            <DeploymentSummary deployment={deployment} />

            <div className="flex flex-wrap items-center gap-2">
              {(["deploy", "redeploy", "pull", "rollback", "start", "stop", "restart"] as const).map((name) => (
                <ActionButton disabled={action.isPending} icon={actionIcon(name === "stop" ? "stop" : name === "rollback" || name === "redeploy" ? "rollback" : "deploy")} intent={name === "deploy" ? "primary" : name === "stop" ? "danger" : "default"} key={name} label={name} onClick={() => action.mutate(name)} />
              ))}
              <ActionButton disabled={action.isPending} icon={<ListChecks size={15} />} label="Preflight" onClick={() => action.mutate("preflight")} />
              <ActionButton disabled={action.isPending} icon={<HeartPulse size={15} />} label="Health" onClick={() => action.mutate("health")} />
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6">
              <div className="space-y-6">
                <div className="rounded-md border border-panel-line bg-white">
                  <div className="border-b border-panel-line p-4 text-sm font-semibold">Build Pipeline</div>
                  <div className="grid grid-cols-2 gap-3 p-4 text-sm">
                    <Command label="Install" value={deployment.installCommand} />
                    <Command label="Build" value={deployment.buildCommand} />
                    <Command label="Start" value={deployment.startCommand} />
                    <Command label="Output" value={deployment.outputDirectory} />
                  </div>
                </div>

                <div className="rounded-md border border-panel-line bg-white">
                  <div className="flex items-center justify-between border-b border-panel-line p-4">
                    <div className="text-sm font-semibold">Latest Releases</div>
                    <Link className="text-sm font-medium text-panel-accent" href={`/deployments/${project}/logs`}>View logs</Link>
                  </div>
                  <div className="divide-y divide-panel-line">
                    {(deployment.releases ?? []).slice(0, 6).map((release) => (
                      <div className="grid grid-cols-[160px_1fr_100px_160px] items-center gap-3 px-4 py-3 text-sm" key={release.id}>
                        {statusBadge(release.status)}
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{release.commitSha ?? release.id}</div>
                          <div className="mt-1 truncate text-xs text-panel-muted">{release.sourcePath ?? deployment.rootPath}</div>
                        </div>
                        <div className="text-xs text-panel-muted">{formatDuration(release.durationMs)}</div>
                        <div className="text-xs text-panel-muted">{formatDate(release.createdAt)}</div>
                      </div>
                    ))}
                    {(deployment.releases ?? []).length === 0 ? <div className="p-4 text-sm text-panel-muted">No release history yet.</div> : null}
                  </div>
                </div>
              </div>

              <aside className="space-y-3">
                <Metric icon={<FolderGit2 size={16} />} label="Source" value={`${deployment.sourceProvider}${deployment.githubRepo ? ` · ${deployment.githubOwner}/${deployment.githubRepo}` : ""}`} />
                <Metric icon={<Globe2 size={16} />} label="Domain" value={deployment.domain?.name ?? "Not linked"} />
                <Metric icon={<TerminalSquare size={16} />} label="Runtime" value={`${deployment.framework} · ${deployment.processManager ?? "no manager"} · :${deployment.port}`} />
                <Metric icon={<KeyRound size={16} />} label="Environment" value={`${deployment.env?.length ?? deployment._count?.env ?? 0} variables`} />
                <Metric icon={<Database size={16} />} label="Database" value={deployment.dbType ? `${deployment.dbType} · ${deployment.dbName ?? "pending"}` : "None"} />
                <Metric icon={<RefreshCw size={16} />} label="Updated" value={formatDate(deployment.updatedAt)} />
              </aside>
            </div>
          </>
        ) : detail.isLoading ? (
          <div className="rounded-md border border-panel-line bg-white p-8 text-sm text-panel-muted">Loading deployment...</div>
        ) : (
          <EmptyState title="Deployment not found" detail="The project slug or id did not return a deployment." />
        )}
      </section>
    </>
  );
}

function Command({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <div className="text-xs uppercase text-panel-muted">{label}</div>
      <div className="mt-2 break-words font-mono text-xs">{value || "-"}</div>
    </div>
  );
}

function useStateMessage() {
  const [message, setMessage] = useState("");
  return [message, setMessage] as [string, (message: string) => void];
}
