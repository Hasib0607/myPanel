"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { Deployment, DeploymentRelease, QueueResponse } from "../../deployment-types";
import { formatDate, ProjectTabs, statusBadge } from "../../deployment-ui";

export function DeploymentHistoryClient({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["deployment", project], queryFn: () => apiGet<Deployment>(`/deployments/${project}`) });
  const releases = useQuery({
    queryKey: ["deployment-releases", project],
    queryFn: () => apiGet<DeploymentRelease[]>(`/deployments/${project}/releases`),
    refetchInterval: 5000
  });
  const rollback = useMutation({
    mutationFn: (releaseId: string) => apiPost<QueueResponse>(`/deployments/${project}/rollback`, { releaseId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
      await queryClient.invalidateQueries({ queryKey: ["deployment-releases", project] });
    }
  });

  return (
    <>
      <ProjectTabs active="history" project={project} />
      <section className="space-y-4 p-8">
        <div className="flex items-center justify-between rounded-md border border-panel-line bg-white p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold"><History size={16} />Deploy History</div>
            <div className="mt-1 text-xs text-panel-muted">Project wise releases for {detail.data?.name ?? project}. Jump queues rollback to an older successful deploy.</div>
          </div>
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => releases.refetch()} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>

        <div className="overflow-hidden rounded-md border border-panel-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-panel-muted">
              <tr>
                <th className="px-4 py-3">Release</th>
                <th className="px-4 py-3">Commit</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Finished</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {(releases.data ?? []).map((release) => (
                <tr className="border-t border-panel-line" key={release.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">{statusBadge(release.status)}<span className="font-mono text-xs text-panel-muted">{release.id.slice(-8)}</span></div>
                    {release.commitAuthor ? <div className="mt-1 text-xs text-panel-muted">{release.commitAuthor}</div> : null}
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <div className="font-mono text-xs font-semibold">{release.commitSha ? release.commitSha.slice(0, 12) : "-"}</div>
                    {release.commitMessage ? <div className="mt-1 truncate text-xs text-panel-muted">{release.commitMessage}</div> : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-panel-muted">{formatDate(release.startedAt ?? release.createdAt)}</td>
                  <td className="px-4 py-3 text-xs text-panel-muted">{formatDate(release.finishedAt)}</td>
                  <td className="px-4 py-3 text-xs text-panel-muted">{release.durationMs ? `${Math.round(release.durationMs / 1000)}s` : "-"}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button className="h-8 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={rollback.isPending || release.status !== "SUCCEEDED"} onClick={() => rollback.mutate(release.id)} type="button">
                        Jump
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {releases.isLoading ? <div className="p-8 text-center text-sm text-panel-muted">Loading history...</div> : null}
          {!releases.isLoading && (releases.data ?? []).length === 0 ? <div className="p-8 text-center text-sm text-panel-muted">No deploy history yet.</div> : null}
        </div>
      </section>
    </>
  );
}
