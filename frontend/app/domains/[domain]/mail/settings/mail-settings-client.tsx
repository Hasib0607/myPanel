"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CheckCircle2, CircleAlert, Copy, Download, LockKeyhole, MailCheck, RefreshCw, Server, Shield, ShieldCheck } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

type AuthStatus = {
  domain: string;
  mailboxCount: number;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};

type SmtpSettings = {
  domain: string;
  host: string;
  ports: Array<{ port: number; security: string; recommended: boolean }>;
  auth: string;
  usernames: string[];
  mailboxes: Array<{ id: string; email: string; enabled: boolean }>;
  rateLimit: number;
  rateWindowSeconds: number;
  notes: string[];
  protocols: Array<{ protocol: string; host: string; port: number; security: string }>;
};

type DnsRecommendation = {
  domain: string;
  records: Array<{
    type: string;
    name: string;
    value: string;
    ttl: number;
    priority: number | null;
    exists: boolean;
  }>;
};

type ServerStatus = {
  stack: {
    commands?: Record<string, boolean>;
    services?: Record<string, { returncode?: number; stdout?: string }>;
  };
  firewall: {
    requiredPorts?: number[];
    rules?: { stdout?: string };
  };
};

type MailTlsStatus = {
  hostname: string;
  exists: boolean;
  expiry: string | null;
  names?: string[];
};

type HealthResult = {
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
};

type SecurityStatus = {
  commands?: Record<string, boolean>;
  services?: Record<string, { returncode?: number; stdout?: string }>;
  relay?: { ok: boolean; detail: string };
};

type Deliverability = { dkimSelector: string; dmarcPolicy: "none" | "quarantine" | "reject"; spfInclude: string | null; spfCustom: string | null; bounceAddress: string | null; pop3Enabled: boolean };

export function MailSettingsClient({ domainId }: { domainId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [selectedMailboxId, setSelectedMailboxId] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [testRecipient, setTestRecipient] = useState("");
  const [enableClamav, setEnableClamav] = useState(false);
  const [enableRspamd, setEnableRspamd] = useState(true);
  const [deliverabilityDraft, setDeliverabilityDraft] = useState<Deliverability | null>(null);
  const authStatus = useQuery({ queryKey: ["mail-auth-status", domainId], queryFn: () => apiGet<AuthStatus>(`/mail/domains/${domainId}/auth-status`) });
  const smtp = useQuery({ queryKey: ["mail-smtp-settings", domainId], queryFn: () => apiGet<SmtpSettings>(`/mail/domains/${domainId}/smtp-settings`) });
  const dns = useQuery({ queryKey: ["mail-dns-recommendations", domainId], queryFn: () => apiGet<DnsRecommendation>(`/mail/domains/${domainId}/dns-recommendations`) });
  const server = useQuery({ queryKey: ["mail-server-status"], queryFn: () => apiGet<ServerStatus>("/mail/server/status") });
  const tls = useQuery({ queryKey: ["mail-tls-status", domainId], queryFn: () => apiGet<MailTlsStatus>(`/mail/domains/${domainId}/tls/status`) });
  const security = useQuery({ queryKey: ["mail-security-status"], queryFn: () => apiGet<SecurityStatus>("/mail/server/security/status") });
  const deliverability = useQuery({ queryKey: ["mail-deliverability", domainId], queryFn: () => apiGet<Deliverability>(`/mail/domains/${domainId}/deliverability`) });
  useEffect(() => { if (deliverability.data && !deliverabilityDraft) setDeliverabilityDraft(deliverability.data); }, [deliverability.data, deliverabilityDraft]);
  const effectiveMailboxId = selectedMailboxId || smtp.data?.mailboxes.find((mailbox) => mailbox.enabled)?.id || "";

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["mail-auth-status", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-dns-recommendations", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-server-status"] });
    await queryClient.invalidateQueries({ queryKey: ["mail-tls-status", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-security-status"] });
  };

  const installStack = useMutation({
    mutationFn: () => apiPost("/mail/server/install", { enableRspamd }),
    onSuccess: async () => {
      setNotice("Postfix, Dovecot, OpenDKIM, and Certbot installed and started.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not install mail stack.")
  });

  const applyFirewall = useMutation({
    mutationFn: () => apiPost("/mail/server/firewall/apply", {}),
    onSuccess: async () => {
      setNotice("Mail ports opened in the active firewall backend.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not apply mail firewall ports.")
  });

  const issueTls = useMutation({
    mutationFn: () => apiPost(`/mail/domains/${domainId}/tls/issue`, {}),
    onSuccess: async () => {
      setNotice("Mail TLS certificate issued and attached to Postfix/Dovecot.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not issue mail TLS.")
  });

  const renewTls = useMutation({
    mutationFn: () => apiPost(`/mail/domains/${domainId}/tls/renew`, {}),
    onSuccess: async () => {
      setNotice("Mail TLS certificate renewed and reattached.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not renew mail TLS.")
  });

  const configureSmtp = useMutation({
    mutationFn: () => apiPost(`/mail/domains/${domainId}/smtp/configure`, { messageRateLimit: rateLimit }),
    onSuccess: async () => {
      setNotice("SMTP submission configuration applied.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not configure SMTP.")
  });

  const syncMailboxes = useMutation({
    mutationFn: () => apiPost<{ synced: number }>(`/mail/domains/${domainId}/mailboxes/sync`, {}),
    onSuccess: async (result) => {
      setNotice(`${result.synced} mailbox(es) synced to Dovecot with passwords and quotas.`);
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not sync mailboxes.")
  });

  const smtpHealth = useMutation({
    mutationFn: () => apiPost<HealthResult>(`/mail/domains/${domainId}/health/smtp`, { accountId: effectiveMailboxId, password: smtpPassword, recipient: testRecipient || undefined }),
    onSuccess: (result) => {
      setSmtpPassword("");
      setNotice(result.ok ? "SMTP login and test send passed." : "SMTP test completed with failures. Review the checks below.");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not test SMTP.")
  });

  const incomingHealth = useMutation({
    mutationFn: () => apiPost<HealthResult>(`/mail/domains/${domainId}/health/incoming`, { accountId: effectiveMailboxId }),
    onSuccess: (result) => setNotice(result.ok ? "Inbound delivery path passed end to end." : "Inbound test completed with failures. Review the checks below."),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not test incoming delivery.")
  });

  const configureSecurity = useMutation({
    mutationFn: () => apiPost("/mail/server/security/configure", { enableClamav }),
    onSuccess: async () => {
      setNotice(`Mail security profile applied${enableClamav ? " with ClamAV" : ""}.`);
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not configure mail security.")
  });

  const applyDns = useMutation({
    mutationFn: () => apiPost(`/mail/domains/${domainId}/dns-recommendations/apply`, {}),
    onSuccess: async () => {
      setNotice("Mail DNS records applied and zone publish queued.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not apply DNS records.")
  });

  const setupDkim = useMutation({
    mutationFn: () => apiPost(`/mail/domains/${domainId}/dkim/setup`, {}),
    onSuccess: async () => {
      setNotice("DKIM setup completed. DNS was updated if a key was generated.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not setup DKIM.")
  });

  const saveDeliverability = useMutation({
    mutationFn: () => apiPatch(`/mail/domains/${domainId}/deliverability`, deliverabilityDraft),
    onSuccess: async () => { setNotice("Deliverability policy saved and DNS records republished."); await invalidate(); },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save deliverability settings.")
  });

  const copyText = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  const smtpText = smtp.data ? [
    `SMTP host: ${smtp.data.host}`,
    "SMTP port: 587 (STARTTLS, recommended)",
    "Alternative: 465 (SSL/TLS)",
    "Username: full mailbox address",
    "Password: mailbox password"
  ].join("\n") : "";
  const protocolText = smtp.data ? [...smtp.data.protocols.map((item) => `${item.protocol}: ${item.host}:${item.port} (${item.security})`), `${typeof window === "undefined" ? "" : window.location.origin}/webmail/login`, "Username: full mailbox address", "Password: mailbox password"].join("\n") : "";

  return (
    <section className="space-y-6 p-8">
      {notice ? <div className="rounded-md border border-panel-line bg-white p-3 text-sm text-slate-700">{notice}</div> : null}

      <div className="rounded-md border border-panel-line bg-white">
        <div className="border-b border-panel-line px-4 py-3"><div className="text-sm font-semibold">Domain Mail Setup Wizard</div><div className="text-xs text-panel-muted">Complete each stage in order. Live validation determines readiness.</div></div>
        <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <WizardStep index={1} label="Apply DNS" ready={Boolean(dns.data?.records.every((record) => record.exists))} busy={applyDns.isPending} onClick={() => applyDns.mutate()} />
          <WizardStep index={2} label="Issue SSL" ready={Boolean(tls.data?.exists)} busy={issueTls.isPending} onClick={() => issueTls.mutate()} />
          <WizardStep index={3} label="Configure SMTP" ready={Boolean(server.data?.stack.services?.postfix?.returncode === 0)} busy={configureSmtp.isPending} onClick={() => configureSmtp.mutate()} />
          <WizardStep index={4} label="Configure DKIM" ready={Boolean(authStatus.data?.checks.find((check) => check.key === "dkim")?.ok)} busy={setupDkim.isPending} onClick={() => setupDkim.mutate()} />
          <WizardStep index={5} label="Test send / receive" ready={Boolean(smtpHealth.data?.ok && incomingHealth.data?.ok)} busy={smtpHealth.isPending || incomingHealth.isPending} onClick={() => setNotice("Use Live Mail Health below with a mailbox password to complete both tests.")} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <SetupCard
          action={server.data?.stack.commands && Object.values(server.data.stack.commands).every(Boolean) ? "Installed" : "Install stack"}
          busy={installStack.isPending}
          description="Postfix, Dovecot, OpenDKIM, and Certbot"
          icon={<Download size={18} />}
          onClick={() => installStack.mutate()}
          ready={Boolean(server.data?.stack.commands && Object.values(server.data.stack.commands).every(Boolean))}
          title="Mail packages"
        />
        <SetupCard
          action="Open ports"
          busy={applyFirewall.isPending}
          description="TCP 25, 143, 465, 587, 993, and optional 995"
          icon={<Shield size={18} />}
          onClick={() => applyFirewall.mutate()}
          ready={Boolean(server.data?.firewall.rules?.stdout && [25, 143, 465, 587, 993, 995].every((port) => server.data?.firewall.rules?.stdout?.includes(String(port))))}
          title="Mail firewall"
        />
        <SetupCard
          action={tls.data?.exists ? "Renew TLS" : "Issue TLS"}
          busy={issueTls.isPending || renewTls.isPending}
          description={tls.data?.exists ? `${tls.data.hostname} · expires ${tls.data.expiry ? new Date(tls.data.expiry).toLocaleDateString() : "unknown"}` : (tls.data?.hostname ?? "mail.domain.com")}
          icon={<LockKeyhole size={18} />}
          onClick={() => tls.data?.exists ? renewTls.mutate() : issueTls.mutate()}
          ready={Boolean(tls.data?.exists)}
          title="Mail TLS"
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-panel-muted"><input checked={enableRspamd} onChange={(event) => setEnableRspamd(event.target.checked)} type="checkbox" />Install Rspamd and Fail2Ban with the mail server stack</label>

      <div className="rounded-md border border-panel-line bg-white">
        <div className="flex items-center justify-between border-b border-panel-line px-4 py-3"><div><div className="text-sm font-semibold">Full Protocol Settings</div><div className="text-xs text-panel-muted">Mailbox apps and individual webmail login.</div></div><button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-xs font-semibold" disabled={!smtp.data} onClick={() => copyText(protocolText, "All protocol settings copied.")} type="button"><Copy size={14} />Copy all</button></div>
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">{(smtp.data?.protocols ?? []).map((protocol) => <div className="rounded-md border border-panel-line p-3" key={`${protocol.protocol}-${protocol.port}`}><div className="font-semibold">{protocol.protocol}</div><div className="mt-2 font-mono text-xs">{protocol.host}:{protocol.port}</div><div className="mt-1 text-xs text-panel-muted">{protocol.security}</div></div>)}<div className="rounded-md border border-panel-line p-3"><div className="font-semibold">Webmail</div><div className="mt-2 font-mono text-xs">/webmail/login</div><div className="mt-1 text-xs text-panel-muted">Full email address + mailbox password</div></div></div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold"><Server size={16} /> SMTP Submission</div>
              <div className="text-xs text-panel-muted">Ports 587 (STARTTLS) and 465 (SSL/TLS) with Dovecot SASL auth.</div>
            </div>
            <div className="flex gap-2">
              <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50" disabled={!smtp.data} onClick={() => copyText(smtpText, "SMTP settings copied.")} type="button">
                <Copy size={14} />
                Copy
              </button>
              <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white disabled:opacity-60" disabled={configureSmtp.isPending} onClick={() => configureSmtp.mutate()} type="button">
                <ShieldCheck size={14} />
                Configure
              </button>
            </div>
          </div>
          <div className="space-y-3 p-4 text-sm">
            <Row label="Host" value={smtp.data?.host ?? "mail.domain"} />
            <Row label="Submission" value="587 / STARTTLS" />
            <Row label="SMTPS" value="465 / SSL/TLS" />
            <Row label="Security" value="STARTTLS" />
            <Row label="Auth" value={smtp.data?.auth ?? "Full mailbox address and password"} />
            <div className="grid grid-cols-[110px_1fr] items-center gap-3">
              <label className="text-panel-muted" htmlFor="smtp-rate-limit">Rate limit</label>
              <div className="flex items-center gap-2">
                <input className="h-9 w-28 rounded-md border border-panel-line px-3 text-sm" id="smtp-rate-limit" min={1} max={10000} onChange={(event) => setRateLimit(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} type="number" value={rateLimit} />
                <span className="text-xs text-panel-muted">messages/client/60 sec</span>
              </div>
            </div>
            <div className="flex flex-col gap-3 rounded-md border border-panel-line bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-semibold">Mailbox authentication and quota</div>
                <div className="mt-1 text-xs text-panel-muted">Sync stored hashes, enabled state, and per-mailbox storage limits.</div>
              </div>
              <button className="h-9 shrink-0 rounded-md border border-panel-line bg-white px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={syncMailboxes.isPending} onClick={() => syncMailboxes.mutate()} type="button">
                {syncMailboxes.isPending ? "Syncing..." : "Sync all mailboxes"}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Mail DNS Records</div>
              <div className="text-xs text-panel-muted">MX, SPF, DKIM, DMARC, and mail host alignment.</div>
            </div>
            <div className="flex gap-2">
              <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50" disabled={setupDkim.isPending} onClick={() => setupDkim.mutate()} type="button">Setup DKIM</button>
              <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white disabled:opacity-60" disabled={applyDns.isPending} onClick={() => applyDns.mutate()} type="button">Apply DNS</button>
            </div>
          </div>
          <div className="divide-y divide-panel-line text-sm">
            {(dns.data?.records ?? []).map((record) => (
              <div className="grid grid-cols-[90px_120px_1fr_auto] gap-3 px-4 py-3" key={`${record.type}-${record.name}`}>
                <div className="font-semibold">{record.type}</div>
                <div className="font-mono text-xs">{record.name}</div>
                <div className="break-all font-mono text-xs text-panel-muted">{record.priority != null ? `${record.priority} ` : ""}{record.value}</div>
                <div>{record.exists ? <CheckCircle2 className="text-emerald-600" size={16} /> : <CircleAlert className="text-panel-warn" size={16} />}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-panel-line bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Authentication Status</div>
            <div className="text-xs text-panel-muted">Current DNS posture for sending and receiving mail.</div>
          </div>
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50" onClick={() => invalidate()} type="button">
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        <div className="grid gap-3 p-4 md:grid-cols-5">
          {(authStatus.data?.checks ?? []).map((check) => (
            <div key={check.key} className="rounded-md border border-panel-line p-3 text-sm">
              <div className="flex items-center gap-2 font-medium">
                {check.ok ? <CheckCircle2 className="text-emerald-600" size={16} /> : <CircleAlert className="text-panel-warn" size={16} />}
                {check.label}
              </div>
              <div className="mt-2 text-xs text-panel-muted">{check.detail}</div>
            </div>
          ))}
        </div>
      </div>

      {deliverabilityDraft ? <div className="rounded-md border border-panel-line bg-white"><div className="border-b border-panel-line px-4 py-3"><div className="text-sm font-semibold">Deliverability Policy</div><div className="text-xs text-panel-muted">DKIM selector, DMARC enforcement, SPF extension, bounce identity, and optional POP3.</div></div><div className="grid gap-4 p-4 md:grid-cols-2">
        <label className="text-xs font-medium text-panel-muted">DKIM selector<input className="mt-1 h-10 w-full rounded-md border border-panel-line px-3 text-sm" value={deliverabilityDraft.dkimSelector} onChange={(event) => setDeliverabilityDraft({ ...deliverabilityDraft, dkimSelector: event.target.value.toLowerCase() })} /></label>
        <label className="text-xs font-medium text-panel-muted">DMARC policy<select className="mt-1 h-10 w-full rounded-md border border-panel-line bg-white px-3 text-sm" value={deliverabilityDraft.dmarcPolicy} onChange={(event) => setDeliverabilityDraft({ ...deliverabilityDraft, dmarcPolicy: event.target.value as Deliverability["dmarcPolicy"] })}><option value="none">Monitor only</option><option value="quarantine">Quarantine</option><option value="reject">Reject</option></select></label>
        <label className="text-xs font-medium text-panel-muted">SPF include<input className="mt-1 h-10 w-full rounded-md border border-panel-line px-3 text-sm" placeholder="_spf.provider.com" value={deliverabilityDraft.spfInclude ?? ""} onChange={(event) => setDeliverabilityDraft({ ...deliverabilityDraft, spfInclude: event.target.value || null })} /></label>
        <label className="text-xs font-medium text-panel-muted">Bounce address<input className="mt-1 h-10 w-full rounded-md border border-panel-line px-3 text-sm" placeholder="bounce@example.com" type="email" value={deliverabilityDraft.bounceAddress ?? ""} onChange={(event) => setDeliverabilityDraft({ ...deliverabilityDraft, bounceAddress: event.target.value || null })} /></label>
        <label className="text-xs font-medium text-panel-muted md:col-span-2">Custom SPF record<input className="mt-1 h-10 w-full rounded-md border border-panel-line px-3 font-mono text-xs" placeholder="Leave empty to generate automatically" value={deliverabilityDraft.spfCustom ?? ""} onChange={(event) => setDeliverabilityDraft({ ...deliverabilityDraft, spfCustom: event.target.value || null })} /></label>
        <label className="flex items-center gap-2 text-sm"><input checked={deliverabilityDraft.pop3Enabled} onChange={(event) => setDeliverabilityDraft({ ...deliverabilityDraft, pop3Enabled: event.target.checked })} type="checkbox" />Enable optional POP3 settings</label>
        <button className="h-10 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={saveDeliverability.isPending} onClick={() => saveDeliverability.mutate()} type="button">{saveDeliverability.isPending ? "Saving..." : "Save and publish DNS"}</button>
      </div><div className="border-t border-panel-line bg-slate-50 px-4 py-3 text-xs text-panel-muted">PTR checklist: set the VPS IP reverse DNS to <span className="font-mono">{smtp.data?.host ?? "mail.domain"}</span>, then verify it on Diagnostics.</div></div> : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-md border border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold"><Activity size={16} /> Live Mail Health</div>
            <div className="text-xs text-panel-muted">Test authenticated sending and real Postfix to LMTP delivery.</div>
          </div>
          <div className="space-y-4 p-4">
            <label className="block text-xs font-medium text-panel-muted" htmlFor="health-mailbox">Mailbox</label>
            <select className="h-10 w-full rounded-md border border-panel-line bg-white px-3 text-sm" id="health-mailbox" onChange={(event) => setSelectedMailboxId(event.target.value)} value={effectiveMailboxId}>
              {(smtp.data?.mailboxes ?? []).filter((mailbox) => mailbox.enabled).map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.email}</option>)}
            </select>

            <div className="grid gap-3 sm:grid-cols-2">
              <input autoComplete="new-password" className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setSmtpPassword(event.target.value)} placeholder="Mailbox password" type="password" value={smtpPassword} />
              <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setTestRecipient(event.target.value)} placeholder="Recipient (defaults to self)" type="email" value={testRecipient} />
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white disabled:opacity-60" disabled={!effectiveMailboxId || !smtpPassword || smtpHealth.isPending} onClick={() => smtpHealth.mutate()} type="button"><MailCheck size={14} />{smtpHealth.isPending ? "Testing..." : "Test SMTP login/send"}</button>
              <button className="h-9 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={!effectiveMailboxId || incomingHealth.isPending} onClick={() => incomingHealth.mutate()} type="button">{incomingHealth.isPending ? "Testing..." : "Test incoming delivery"}</button>
            </div>
            <HealthChecks result={smtpHealth.data} />
            <HealthChecks result={incomingHealth.data} />
          </div>
        </div>

        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} /> Mail Security</div>
              <div className="text-xs text-panel-muted">Fail2Ban, Rspamd, relay protection, and sender validation.</div>
            </div>
            {security.data?.commands?.["fail2ban-client"] && security.data?.services?.fail2ban?.returncode === 0 && security.data?.commands?.rspamd && security.data?.services?.rspamd?.returncode === 0 ? <CheckCircle2 className="text-emerald-600" size={18} /> : <CircleAlert className="text-panel-warn" size={18} />}
          </div>
          <div className="space-y-4 p-4 text-sm">
            <SecurityRow label="Fail2Ban" ready={Boolean(security.data?.commands?.["fail2ban-client"] && security.data?.services?.fail2ban?.returncode === 0)} />
            <SecurityRow label="Rspamd" ready={Boolean(security.data?.commands?.rspamd && security.data?.services?.rspamd?.returncode === 0)} />
            {security.data?.commands?.clamdscan ? <SecurityRow label="ClamAV" ready={Object.entries(security.data.services ?? {}).some(([name, result]) => name.startsWith("clam") && result.returncode === 0)} /> : null}
            <SecurityRow label="Relay blocked" ready={Boolean(security.data?.relay?.ok)} detail={security.data?.relay?.detail} />
            <label className="flex items-center gap-2 rounded-md border border-panel-line bg-slate-50 p-3 text-xs">
              <input checked={enableClamav} onChange={(event) => setEnableClamav(event.target.checked)} type="checkbox" />
              Install and connect ClamAV malware scanning (uses additional RAM)
            </label>
            <button className="h-9 w-full rounded-md bg-panel-accent px-3 text-xs font-semibold text-white disabled:opacity-60" disabled={configureSecurity.isPending} onClick={() => configureSecurity.mutate()} type="button">{configureSecurity.isPending ? "Applying security..." : "Install / apply security profile"}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function HealthChecks({ result }: { result?: HealthResult }) {
  if (!result) return null;
  return (
    <div className="divide-y divide-panel-line rounded-md border border-panel-line">
      {result.checks.map((check) => (
        <div className="flex items-start gap-3 p-3" key={check.key}>
          {check.ok ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-600" size={15} /> : <CircleAlert className="mt-0.5 shrink-0 text-red-600" size={15} />}
          <div className="min-w-0"><div className="text-xs font-semibold">{check.label}</div><div className="mt-1 break-words text-xs text-panel-muted">{check.detail}</div></div>
        </div>
      ))}
    </div>
  );
}

function SecurityRow({ label, ready, detail }: { label: string; ready: boolean; detail?: string }) {
  return <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{label}</div>{detail ? <div className="mt-1 text-xs text-panel-muted">{detail}</div> : null}</div>{ready ? <CheckCircle2 className="text-emerald-600" size={16} /> : <CircleAlert className="text-panel-warn" size={16} />}</div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <div className="text-panel-muted">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function SetupCard({ title, description, action, ready, busy, icon, onClick }: { title: string; description: string; action: string; ready: boolean; busy: boolean; icon: ReactNode; onClick: () => void }) {
  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-slate-100 text-panel-text">{icon}</span>
          <div>
            <div className="font-semibold text-panel-text">{title}</div>
            <div className="mt-1 text-xs text-panel-muted">{description}</div>
          </div>
        </div>
        {ready ? <CheckCircle2 className="shrink-0 text-emerald-600" size={18} /> : <CircleAlert className="shrink-0 text-panel-warn" size={18} />}
      </div>
      <button className="h-9 w-full rounded-md border border-panel-line text-sm font-semibold hover:bg-slate-50 disabled:opacity-60" disabled={busy} onClick={onClick} type="button">
        {busy ? "Working..." : action}
      </button>
    </div>
  );
}

function WizardStep({ index, label, ready, busy, onClick }: { index: number; label: string; ready: boolean; busy: boolean; onClick: () => void }) {
  return <button className="flex min-h-16 items-center gap-3 rounded-md border border-panel-line p-3 text-left hover:bg-slate-50 disabled:opacity-60" disabled={busy} onClick={onClick} type="button"><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${ready ? "bg-emerald-100 text-emerald-700" : "bg-slate-100"}`}>{ready ? "OK" : index}</span><span className="text-xs font-semibold">{busy ? "Working..." : label}</span></button>;
}
