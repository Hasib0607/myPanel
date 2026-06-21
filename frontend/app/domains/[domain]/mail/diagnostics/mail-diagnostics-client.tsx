"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

type Diagnostics = { ok: boolean; dryRun?: boolean; hostname: string; checks: Array<{ key: string; label: string; ok: boolean; detail: string }> };

export function MailDiagnosticsClient({ domainId }: { domainId: string }) {
  const [mailboxId, setMailboxId] = useState("");
  const [password, setPassword] = useState("");
  const diagnostics = useQuery({ queryKey: ["mail-diagnostics", domainId], queryFn: () => apiGet<Diagnostics>(`/mail/domains/${domainId}/diagnostics`), refetchInterval: 15000 });
  const mailboxes = useQuery({ queryKey: ["mail-diagnostic-mailboxes", domainId], queryFn: () => apiGet<{ mailboxes: Array<{ id: string; email: string; enabled: boolean }> }>(`/mail/domains/${domainId}/smtp-settings`) });
  const effectiveMailbox = mailboxId || mailboxes.data?.mailboxes.find((mailbox) => mailbox.enabled)?.id || "";
  const smtpTest = useMutation({ mutationFn: () => apiPost<Diagnostics>(`/mail/domains/${domainId}/health/smtp`, { accountId: effectiveMailbox, password }), onSuccess: () => setPassword("") });
  return <section className="space-y-4 p-8">
    <div className="flex items-center justify-between"><div className="text-sm text-panel-muted">Target: <span className="font-mono text-panel-text">{diagnostics.data?.hostname ?? "mail.domain"}</span></div><button className="flex h-9 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold" onClick={() => diagnostics.refetch()} type="button"><RefreshCw size={15} /> Refresh</button></div>
    {diagnostics.data?.dryRun ? <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">Live commands are disabled. These checks are not considered passed.</div> : null}
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{(diagnostics.data?.checks ?? []).map((check) => <div className="rounded-md border border-panel-line bg-white p-4" key={check.key}><div className="flex items-center gap-2 font-semibold">{check.ok ? <CheckCircle2 className="text-emerald-600" size={17} /> : <CircleAlert className="text-red-600" size={17} />}{check.label}</div><div className="mt-2 break-words text-xs text-panel-muted">{check.detail}</div></div>)}</div>
    <div className="rounded-md border border-panel-line bg-white"><div className="border-b border-panel-line px-4 py-3"><div className="text-sm font-semibold">SMTP Authentication Probe</div><div className="text-xs text-panel-muted">Negotiates STARTTLS, logs in, and sends a message to the same mailbox.</div></div><div className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]"><select className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm" value={effectiveMailbox} onChange={(event) => setMailboxId(event.target.value)}>{(mailboxes.data?.mailboxes ?? []).filter((mailbox) => mailbox.enabled).map((mailbox) => <option value={mailbox.id} key={mailbox.id}>{mailbox.email}</option>)}</select><input className="h-10 rounded-md border border-panel-line px-3 text-sm" type="password" placeholder="Mailbox password" value={password} onChange={(event) => setPassword(event.target.value)} /><button className="h-10 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={!effectiveMailbox || !password || smtpTest.isPending} onClick={() => smtpTest.mutate()} type="button">{smtpTest.isPending ? "Testing..." : "Test SMTP auth"}</button></div>{smtpTest.data ? <div className="grid gap-3 border-t border-panel-line p-4 md:grid-cols-2">{smtpTest.data.checks.map((check) => <div className="flex items-start gap-2 text-sm" key={check.key}>{check.ok ? <CheckCircle2 className="mt-0.5 text-emerald-600" size={15} /> : <CircleAlert className="mt-0.5 text-red-600" size={15} />}<div><div className="font-medium">{check.label}</div><div className="text-xs text-panel-muted">{check.detail}</div></div></div>)}</div> : null}</div>
  </section>;
}
