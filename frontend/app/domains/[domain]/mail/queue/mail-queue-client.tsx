"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

type QueueItem = { queueId: string; queueName: string; status: "queued" | "deferred" | "bounced"; arrivalTime?: number; messageSize: number; sender: string; recipients: Array<{ address?: string; delay_reason?: string }> };
type QueueResult = { ok: boolean; dryRun?: boolean; items: QueueItem[] };

export function MailQueueClient() {
  const client = useQueryClient();
  const queue = useQuery({ queryKey: ["postfix-queue"], queryFn: () => apiGet<QueueResult>("/mail/server/queue"), refetchInterval: 10000 });
  const action = useMutation({ mutationFn: (body: { action: "flush" | "retry" | "delete"; queueId?: string }) => apiPost("/mail/server/queue/action", body), onSuccess: () => client.invalidateQueries({ queryKey: ["postfix-queue"] }) });
  return <section className="space-y-4 p-8"><div className="flex justify-end gap-2"><button className="flex h-9 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold" onClick={() => queue.refetch()} type="button"><RefreshCw size={15} />Refresh</button><button className="h-9 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white" disabled={action.isPending} onClick={() => action.mutate({ action: "flush" })} type="button">Flush queue</button></div>
    <div className="overflow-hidden rounded-md border border-panel-line bg-white"><div className="grid grid-cols-[130px_110px_1fr_1fr_110px] gap-3 border-b border-panel-line bg-slate-50 px-4 py-3 text-xs font-semibold uppercase text-panel-muted"><div>ID</div><div>State</div><div>Sender</div><div>Recipients / reason</div><div>Actions</div></div>{(queue.data?.items ?? []).map((item) => <div className="grid grid-cols-[130px_110px_1fr_1fr_110px] gap-3 border-b border-panel-line px-4 py-3 text-sm last:border-0" key={item.queueId}><div className="font-mono text-xs">{item.queueId}</div><div className="capitalize">{item.status}</div><div className="break-all">{item.sender || "MAILER-DAEMON"}</div><div className="space-y-1 text-xs">{item.recipients.map((recipient, index) => <div key={index}><span>{recipient.address}</span>{recipient.delay_reason ? <div className="text-red-600">{recipient.delay_reason}</div> : null}</div>)}</div><div className="flex gap-2"><button aria-label="Retry" className="rounded border border-panel-line p-2" onClick={() => action.mutate({ action: "retry", queueId: item.queueId })} type="button"><RotateCcw size={14} /></button><button aria-label="Delete" className="rounded border border-red-200 p-2 text-red-600" onClick={() => action.mutate({ action: "delete", queueId: item.queueId })} type="button"><Trash2 size={14} /></button></div></div>)}{queue.data?.items.length === 0 ? <div className="p-10 text-center text-sm text-panel-muted">Postfix queue is empty.</div> : null}</div>
  </section>;
}
