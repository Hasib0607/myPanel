"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, RefreshCw, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import type { Deployment, DeploymentRelease, QueueResponse } from "../../deployment-types";
import { formatDate, ProjectTabs, statusBadge } from "../../deployment-ui";

export function DeploymentHistoryClient({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const detail = useQuery({ queryKey: ["deployment", project], queryFn: () => apiGet<Deployment>(`/deployments/${project}`) });
  const releases = useQuery({
    queryKey: ["deployment-releases", project],
    queryFn: () => apiGet<DeploymentRelease[]>(`/deployments/${project}/releases`),
    refetchInterval: 5000
  });
  const rollback = useMutation({
    mutationFn: (releaseId: string) => apiPost<QueueResponse>(`/deployments/${project}/rollback`, { releaseId }),
    onSuccess: async () => {
      setNotice("Rollback queued.");
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
      await queryClient.invalidateQueries({ queryKey: ["deployment-releases", project] });
    }
  });
  const cancelRelease = useMutation({
    mutationFn: (releaseId: string) => apiPost<{ ok: true }>(`/deployments/${project}/releases/${releaseId}/cancel`, {}),
    onSuccess: async () => {
      setNotice("Release closed.");
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
      await queryClient.invalidateQueries({ queryKey: ["deployment-releases", project] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not close release.")
  });
  const deleteRelease = useMutation({
    mutationFn: (releaseId: string) => apiDelete<{ ok: true }>(`/deployments/${project}/releases/${releaseId}`),
    onSuccess: async () => {
      setNotice("Release deleted.");
      await queryClient.invalidateQueries({ queryKey: ["deployment", project] });
      await queryClient.invalidateQueries({ queryKey: ["deployment-releases", project] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete release.")
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
        {notice ? <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</div> : null}

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
                    <div className="flex justify-end gap-2">
                      {release.status === "QUEUED" || release.status === "RUNNING" ? (
                        <button
                          className="flex h-8 items-center gap-1 rounded-md border border-amber-200 px-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                          disabled={cancelRelease.isPending}
                          onClick={() => cancelRelease.mutate(release.id)}
                          title={release.status === "RUNNING" ? "Close stuck running release" : "Cancel queued release"}
                          type="button"
                        >
                          <XCircle size={14} />
                          {release.status === "RUNNING" ? "Close" : "Cancel"}
                        </button>
                      ) : null}
                      <button className="h-8 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={rollback.isPending || release.status !== "SUCCEEDED"} onClick={() => rollback.mutate(release.id)} type="button">
                        Jump
                      </button>
                      <button
                        className="flex h-8 items-center justify-center rounded-md border border-red-200 px-2 text-panel-danger hover:bg-red-50 disabled:opacity-50"
                        disabled={deleteRelease.isPending || release.status === "RUNNING"}
                        onClick={() => deleteRelease.mutate(release.id)}
                        title={release.status === "RUNNING" ? "Close the running release before deleting it" : "Delete release row"}
                        type="button"
                      >
                        <Trash2 size={14} />
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
