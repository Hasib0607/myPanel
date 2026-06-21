"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Copy, Download, LockKeyhole, RefreshCw, Server, Shield, ShieldCheck } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";

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
  rateLimit: string;
  notes: string[];
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

export function MailSettingsClient({ domainId }: { domainId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const authStatus = useQuery({ queryKey: ["mail-auth-status", domainId], queryFn: () => apiGet<AuthStatus>(`/mail/domains/${domainId}/auth-status`) });
  const smtp = useQuery({ queryKey: ["mail-smtp-settings", domainId], queryFn: () => apiGet<SmtpSettings>(`/mail/domains/${domainId}/smtp-settings`) });
  const dns = useQuery({ queryKey: ["mail-dns-recommendations", domainId], queryFn: () => apiGet<DnsRecommendation>(`/mail/domains/${domainId}/dns-recommendations`) });
  const server = useQuery({ queryKey: ["mail-server-status"], queryFn: () => apiGet<ServerStatus>("/mail/server/status") });
  const tls = useQuery({ queryKey: ["mail-tls-status", domainId], queryFn: () => apiGet<MailTlsStatus>(`/mail/domains/${domainId}/tls/status`) });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["mail-auth-status", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-dns-recommendations", domainId] });
    await queryClient.invalidateQueries({ queryKey: ["mail-server-status"] });
    await queryClient.invalidateQueries({ queryKey: ["mail-tls-status", domainId] });
  };

  const installStack = useMutation({
    mutationFn: () => apiPost("/mail/server/install", {}),
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
    mutationFn: () => apiPost(`/mail/domains/${domainId}/smtp/configure`, { messageRateLimit: "60" }),
    onSuccess: async () => {
      setNotice("SMTP submission configuration applied.");
      await invalidate();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not configure SMTP.")
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

  const copyText = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  const smtpText = smtp.data ? [
    `SMTP host: ${smtp.data.host}`,
    "SMTP port: 587",
    "Security: STARTTLS",
    "Username: full mailbox address",
    "Password: mailbox password"
  ].join("\n") : "";

  return (
    <section className="space-y-6 p-8">
      {notice ? <div className="rounded-md border border-panel-line bg-white p-3 text-sm text-slate-700">{notice}</div> : null}

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
          description="TCP 25, 143, 465, 587, and 993"
          icon={<Shield size={18} />}
          onClick={() => applyFirewall.mutate()}
          ready={Boolean(server.data?.firewall.rules?.stdout && [25, 143, 465, 587, 993].every((port) => server.data?.firewall.rules?.stdout?.includes(String(port))))}
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

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-md border border-panel-line bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold"><Server size={16} /> SMTP Submission</div>
              <div className="text-xs text-panel-muted">Port 587 with Dovecot SASL auth for mailbox users.</div>
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
            <Row label="Port" value="587" />
            <Row label="Security" value="STARTTLS" />
            <Row label="Auth" value={smtp.data?.auth ?? "Full mailbox address and password"} />
            <Row label="Rate limit" value={smtp.data?.rateLimit ?? "60/minute"} />
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              Existing mailboxes need one password reset after SMTP is enabled so Dovecot can authenticate them.
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
    </section>
  );
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
