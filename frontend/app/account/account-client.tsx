"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Database, ExternalLink, FileText, FolderPlus, Globe2, Inbox, KeyRound, Mail, Play, Plus, RefreshCw, RotateCw, Save, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ApiError, apiDelete, apiDeleteBody, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { TokenExpiryControls, defaultTokenDateTimeLocal, tokenExpiryBody, tokenExpiryText } from "@/components/token-expiry-controls";

type Domain = { id: string; name: string; status: string; documentRoot: string };
type Deployment = { id: string; name: string; slug: string; status: string; healthStatus: string; port: number; dbType?: string | null };
type RuntimeInstallTarget = { actionKey: string; tool: string; label: string; command: string; reason: string; executables: string[] };
type RuntimeReview = {
  required: string[];
  installed: string[];
  missing: string[];
  installable: RuntimeInstallTarget[];
  blocked: string[];
  needsApproval: boolean;
  phpVersion?: string | null;
};
type RuntimeModalState = {
  deployment: Deployment;
  action: "deploy" | "restart";
  review: RuntimeReview;
  selected: Record<string, boolean>;
};
type RuntimeReviewError = {
  runtimeReview?: RuntimeReview;
  install?: {
    failed?: Array<{ tool?: string; error?: string }>;
  } | null;
};
type Mailbox = { id: string; username: string; quotaMb: number; enabled: boolean; domain?: { id: string; name: string } };
type AccountDatabase = { id: string; engine: string; database: string; username: string };
type FileEntry = { name: string; path: string; type: "directory" | "file"; size: number; modifiedAt: string };
type Dashboard = {
  account: {
    id: string;
    username: string;
    email: string | null;
    ownerName: string | null;
    homeRoot: string;
    packageName: string | null;
    domainLimit: number | null;
    mailboxLimit: number | null;
    databaseLimit: number | null;
    deploymentLimit: number | null;
  };
  usage: {
    domains: number;
    deployments: number;
    mailAccounts: number;
    databases: number;
    diskUsedMb: number;
    diskLimitMb: number | null;
    domainLimit: number | null;
    mailboxLimit: number | null;
    databaseLimit: number | null;
    deploymentLimit: number | null;
  };
  domains: Domain[];
  deployments: Deployment[];
  mailAccounts: Mailbox[];
  databases: AccountDatabase[];
  fileRoot: string;
};
type MailOverview = Pick<Dashboard, "account" | "domains" | "mailAccounts">;
type FileList = { current: FileEntry; root: string; items: FileEntry[] };
type FileRead = { file: FileEntry; content: string };
type AccountApiToken = { token: string; tokenType: "Bearer"; expiresInSeconds: number | null; expiresAt: string | null; unlimited: boolean; apiBaseUrl: string };
export type AccountView = "dashboard" | "domains" | "files" | "mail" | "deployments" | "databases" | "profile";

const viewTitles: Record<AccountView, string> = {
  dashboard: "Account Dashboard",
  domains: "Domains",
  files: "File Manager",
  mail: "Mailboxes",
  deployments: "Deployments",
  databases: "Databases",
  profile: "Profile"
};

const viewDescriptions: Record<AccountView, string> = {
  dashboard: "Account-scoped overview for hosting usage, limits, and active resources.",
  domains: "Manage this account's domains, SSL queue, and DNS records.",
  files: "Browse and edit files inside this account's home directory only.",
  mail: "Create, update, reset, and delete this account's mailboxes.",
  deployments: "Create and operate deployments assigned to this account.",
  databases: "Create databases, rotate credentials, and remove account databases.",
  profile: "Account owner details and password management."
};

export function AccountClient({ view = "dashboard" }: { view?: AccountView }) {
  const queryClient = useQueryClient();
  const isDashboard = view === "dashboard";
  const showDomains = view === "domains";
  const showMail = view === "mail";
  const showFiles = view === "files";
  const showDeployments = view === "deployments";
  const showDatabases = view === "databases";
  const showProfile = view === "profile";
  const [notice, setNotice] = useState("");
  const [domainName, setDomainName] = useState("");
  const [mailDraft, setMailDraft] = useState({ domainId: "", username: "", password: "", quotaMb: "1024" });
  const [mailReset, setMailReset] = useState<Record<string, string>>({});
  const [mailEdit, setMailEdit] = useState<Record<string, { quotaMb: string; enabled: boolean }>>({});
  const [deploymentDraft, setDeploymentDraft] = useState({ name: "", framework: "STATIC", domainId: "", gitUrl: "", startCommand: "" });
  const [databaseDraft, setDatabaseDraft] = useState({ engine: "POSTGRESQL", database: "", username: "", password: "" });
  const [filePath, setFilePath] = useState(".");
  const [fileDraft, setFileDraft] = useState({ name: "", content: "" });
  const [editorPath, setEditorPath] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [folderName, setFolderName] = useState("");
  const [dnsDraft, setDnsDraft] = useState({ domainId: "", type: "A", name: "@", value: "", ttl: "3600" });
  const [passwordDraft, setPasswordDraft] = useState({ currentPassword: "", newPassword: "" });
  const [apiToken, setApiToken] = useState<AccountApiToken | null>(null);
  const [apiTokenExpiryMode, setApiTokenExpiryMode] = useState<"unlimited" | "date">("unlimited");
  const [apiTokenExpiresAt, setApiTokenExpiresAt] = useState(defaultTokenDateTimeLocal);
  const [runtimeModal, setRuntimeModal] = useState<RuntimeModalState | null>(null);

  const dashboard = useQuery({
    queryKey: ["account-dashboard"],
    queryFn: () => apiGet<Dashboard>("/account/dashboard"),
    enabled: !showMail
  });
  const mailOverview = useQuery({
    queryKey: ["account-mail-overview"],
    queryFn: () => apiGet<MailOverview>("/account/mail/overview"),
    enabled: showMail
  });
  const savedApiToken = useQuery({
    queryKey: ["account-api-token"],
    queryFn: () => apiGet<AccountApiToken | { token: null }>("/account/api-token")
  });
  const files = useQuery({
    queryKey: ["account-files", filePath],
    queryFn: () => apiGet<FileList>(`/account/files/list?path=${encodeURIComponent(filePath)}`),
    enabled: isDashboard || showFiles
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["account-dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["account-mail-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["account-files"] })
    ]);
  };

  useEffect(() => {
    if (savedApiToken.data?.token) setApiToken(savedApiToken.data);
  }, [savedApiToken.data]);

  const createDomain = useMutation({
    mutationFn: () => apiPost<Domain>("/account/domains", { name: domainName }),
    onSuccess: async () => {
      setDomainName("");
      setNotice("Domain added to this account.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create domain.")
  });

  const createMailbox = useMutation({
    mutationFn: () => apiPost<Mailbox>("/account/mail", {
      domainId: mailDraft.domainId,
      username: mailDraft.username,
      password: mailDraft.password,
      quotaMb: Number(mailDraft.quotaMb || 1024)
    }),
    onSuccess: async () => {
      setMailDraft({ domainId: "", username: "", password: "", quotaMb: "1024" });
      setNotice("Mailbox created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create mailbox.")
  });

  const configureSmtp = useMutation({
    mutationFn: (domainId: string) => apiPost(`/mail/domains/${domainId}/smtp/configure`, { messageRateLimit: 60 }),
    onSuccess: async () => {
      setNotice("SMTP services, firewall ports, and listener checks were applied.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not configure SMTP.")
  });

  const createFile = useMutation({
    mutationFn: () => apiPost<FileEntry>("/account/files/files", { parentPath: filePath, name: fileDraft.name, content: fileDraft.content }),
    onSuccess: async () => {
      setFileDraft({ name: "", content: "" });
      setNotice("File created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create file.")
  });

  const createFolder = useMutation({
    mutationFn: () => apiPost<FileEntry>("/account/files/folders", { parentPath: filePath, name: folderName }),
    onSuccess: async () => {
      setFolderName("");
      setNotice("Folder created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create folder.")
  });

  const deleteFile = useMutation({
    mutationFn: (path: string) => apiDeleteBody("/account/files/delete", { path }),
    onSuccess: async () => {
      setNotice("File item deleted.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete file item.")
  });

  const openFile = useMutation({
    mutationFn: (path: string) => apiGet<FileRead>(`/account/files/read?path=${encodeURIComponent(path)}`),
    onSuccess: (result) => {
      setEditorPath(result.file.path);
      setEditorContent(result.content);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not open file.")
  });

  const saveFile = useMutation({
    mutationFn: () => apiPut("/account/files/write", { path: editorPath, content: editorContent }),
    onSuccess: async () => {
      setNotice("File saved.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not save file.")
  });

  const createDeployment = useMutation({
    mutationFn: () => apiPost<Deployment>("/account/deployments", {
      name: deploymentDraft.name,
      framework: deploymentDraft.framework,
      domainId: deploymentDraft.domainId || null,
      gitUrl: deploymentDraft.gitUrl || null,
      sourceProvider: deploymentDraft.gitUrl ? "GIT_URL" : "FILE_MANAGER",
      startCommand: deploymentDraft.startCommand || null
    }),
    onSuccess: async () => {
      setDeploymentDraft({ name: "", framework: "STATIC", domainId: "", gitUrl: "", startCommand: "" });
      setNotice("Deployment created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create deployment.")
  });

  const deploymentAction = useMutation({
    mutationFn: ({ id, action, approvedRuntimeTools = [] }: { id: string; action: string; approvedRuntimeTools?: string[] }) => apiPost(`/account/deployments/${id}/${action}`, { approvedRuntimeTools }),
    onSuccess: async (_result, variables) => {
      setRuntimeModal(null);
      setNotice(`Deployment ${variables.action} queued.`);
      await refresh();
    },
    onError: (error, variables) => {
      if (error instanceof ApiError && error.status === 409) {
        const data = error.data as RuntimeReviewError | null;
        if (data?.runtimeReview) {
          const failed = data.install?.failed?.map((item) => item.tool).filter(Boolean).join(", ");
          const remaining = data.runtimeReview.missing.join(", ");
          setNotice(failed
            ? `Install did not finish for: ${failed}. Remaining missing tools: ${remaining || "unknown"}.`
            : `Deployment was not queued because required tools are still missing: ${remaining || "unknown"}. Click deploy again to review.`);
          return;
        }
      }
      setNotice(error instanceof Error ? error.message : "Deployment action failed.");
    }
  });

  const startDeploymentAction = async (deployment: Deployment, action: "deploy" | "restart" | "stop") => {
    if (action === "stop") {
      deploymentAction.mutate({ id: deployment.id, action });
      return;
    }
    setNotice("Checking server runtime packages before deployment...");
    try {
      const review = await apiGet<RuntimeReview>(`/account/deployments/${deployment.id}/runtime-review`);
      if (!review.missing.length) {
        deploymentAction.mutate({ id: deployment.id, action });
        return;
      }
      setRuntimeModal({
        deployment,
        action,
        review,
        selected: Object.fromEntries(review.installable.map((item) => [item.tool, true]))
      });
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not check runtime packages.");
    }
  };

  const continueRuntimeInstall = (modal: RuntimeModalState) => {
    const approvedRuntimeTools = Object.entries(modal.selected).filter(([, enabled]) => enabled).map(([tool]) => tool);
    setRuntimeModal(null);
    setNotice(`Installing selected packages for ${modal.deployment.name}, then starting ${modal.action}...`);
    deploymentAction.mutate({
      id: modal.deployment.id,
      action: modal.action,
      approvedRuntimeTools
    });
  };

  const createDatabase = useMutation({
    mutationFn: () => apiPost<AccountDatabase>("/account/databases", {
      engine: databaseDraft.engine,
      database: databaseDraft.database,
      username: databaseDraft.username,
      password: databaseDraft.password || undefined
    }),
    onSuccess: async () => {
      setDatabaseDraft({ engine: "POSTGRESQL", database: "", username: "", password: "" });
      setNotice("Database created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create database.")
  });

  const deleteDatabase = useMutation({
    mutationFn: (id: string) => apiDelete(`/account/databases/${id}`),
    onSuccess: async () => {
      setNotice("Database deleted.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete database.")
  });

  const createDns = useMutation({
    mutationFn: () => apiPost(`/account/domains/${dnsDraft.domainId}/dns`, {
      type: dnsDraft.type,
      name: dnsDraft.name,
      value: dnsDraft.value,
      ttl: Number(dnsDraft.ttl || 3600)
    }),
    onSuccess: async () => {
      setDnsDraft({ domainId: dnsDraft.domainId, type: "A", name: "@", value: "", ttl: "3600" });
      setNotice("DNS record created.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not create DNS record.")
  });

  const queueSsl = useMutation({
    mutationFn: (domainId: string) => apiPost(`/account/domains/${domainId}/ssl/issue`, {}),
    onSuccess: () => setNotice("SSL issue queued."),
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not queue SSL.")
  });

  const updateMailbox = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) => apiPatch(`/account/mail/${id}`, body),
    onSuccess: async (_result, variables) => {
      setMailReset(({ [variables.id]: _cleared, ...rest }) => rest);
      setNotice("Mailbox updated.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not update mailbox.")
  });

  const deleteMailbox = useMutation({
    mutationFn: (id: string) => apiDelete(`/account/mail/${id}`),
    onSuccess: async () => {
      setNotice("Mailbox deleted.");
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not delete mailbox.")
  });

  const changePassword = useMutation({
    mutationFn: () => apiPost("/account/password", passwordDraft),
    onSuccess: () => {
      setPasswordDraft({ currentPassword: "", newPassword: "" });
      setNotice("Password changed.");
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not change password.")
  });

  const generateApiToken = useMutation({
    mutationFn: () => apiPost<AccountApiToken>("/account/api-token", tokenExpiryBody(apiTokenExpiryMode, apiTokenExpiresAt)),
    onSuccess: (result) => {
      setApiToken(result);
      setNotice("API token generated and saved. Copy it now and keep it private.");
      queryClient.setQueryData(["account-api-token"], result);
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Could not generate API token.")
  });

  const copyText = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setNotice(message);
  };

  const mailboxAddress = (mailbox: Mailbox) => `${mailbox.username}@${mailbox.domain?.name ?? ""}`;
  const webmailUrl = typeof window === "undefined" ? "/webmail/login" : `${window.location.origin}/webmail/login`;
  const mailboxSmtpSettings = (mailbox: Mailbox) => [
    `SMTP host: mail.${mailbox.domain?.name ?? ""}`,
    "SMTP port: 587 (STARTTLS, recommended)",
    "Alternative: 465 (SSL/TLS)",
    `Username: ${mailboxAddress(mailbox)}`,
    "Password: mailbox password"
  ].join("\n");

  const data = showMail && mailOverview.data
    ? {
        account: mailOverview.data.account,
        usage: dashboard.data?.usage ?? {
          domains: mailOverview.data.domains.length,
          deployments: 0,
          mailAccounts: mailOverview.data.mailAccounts.length,
          databases: 0,
          diskUsedMb: 0,
          diskLimitMb: null,
          domainLimit: mailOverview.data.account.domainLimit,
          mailboxLimit: mailOverview.data.account.mailboxLimit,
          databaseLimit: mailOverview.data.account.databaseLimit,
          deploymentLimit: mailOverview.data.account.deploymentLimit
        },
        domains: mailOverview.data.domains,
        deployments: [],
        mailAccounts: mailOverview.data.mailAccounts,
        databases: [],
        fileRoot: mailOverview.data.account.homeRoot
      } satisfies Dashboard
    : dashboard.data;
  const domains = data?.domains ?? [];
  const mailOpsDomainId = mailDraft.domainId;
  const mailOpsDomainName = domains.find((domain) => domain.id === mailOpsDomainId)?.name || "selected domain";

  return (
    <>
      <PageHeader
        title={viewTitles[view]}
        description={`${viewDescriptions[view]} ${data?.account.username ? `Account: ${data.account.username}.` : ""}`}
        action={
          <button className="flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm hover:bg-slate-50" onClick={() => refresh()} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
        }
      />
      <section className="space-y-6 p-8">
      {notice ? <div className="rounded-md border border-panel-line bg-white p-3 text-sm text-slate-700">{notice}</div> : null}

      {isDashboard ? <div className="grid grid-cols-5 gap-3">
        <Metric label="Domains" value={data?.usage.domains} limit={data?.usage.domainLimit} />
        <Metric label="Mailboxes" value={data?.usage.mailAccounts} limit={data?.usage.mailboxLimit} />
        <Metric label="Deployments" value={data?.usage.deployments} limit={data?.usage.deploymentLimit} />
        <Metric label="Databases" value={data?.usage.databases} limit={data?.usage.databaseLimit} />
        <Metric label="Disk MB" value={data?.usage.diskUsedMb} limit={data?.usage.diskLimitMb} />
      </div> : null}

      {showDomains || showMail ? <div className={isDashboard ? "grid grid-cols-[1.1fr_0.9fr] gap-6" : "grid grid-cols-1 gap-6"}>
        {showDomains ? <Panel id="domains" title="Domains" icon={<Globe2 size={17} />}>
          <div className="mb-4 flex gap-2">
            <input className="h-10 min-w-0 flex-1 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDomainName(event.target.value)} placeholder="example.com" value={domainName} />
            <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!domainName || createDomain.isPending} onClick={() => createDomain.mutate()} type="button">
              <Plus size={15} />
              Add
            </button>
          </div>
          <div className="overflow-hidden rounded-md border border-panel-line">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                <tr>
                  <th className="px-4 py-3">Domain</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Document Root</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((domain) => (
                  <tr className="border-t border-panel-line" key={domain.id}>
                    <td className="px-4 py-3 font-medium">{domain.name}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${domain.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700" : domain.status === "SUSPENDED" ? "bg-red-50 text-panel-danger" : "bg-amber-50 text-amber-700"}`}>
                        {domain.status}
                      </span>
                    </td>
                    <td className="max-w-xl truncate px-4 py-3 font-mono text-xs text-panel-muted">{domain.documentRoot}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button className="rounded-md border border-panel-line px-3 py-2 text-xs hover:bg-slate-50" onClick={() => queueSsl.mutate(domain.id)} type="button">Issue SSL</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!domains.length ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-panel-muted" colSpan={4}>No domains assigned to this account.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid grid-cols-[1fr_90px_1fr_auto] gap-2 border-t border-panel-line pt-4">
            <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDnsDraft({ ...dnsDraft, domainId: event.target.value })} value={dnsDraft.domainId}>
              <option value="">DNS domain</option>
              {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
            </select>
            <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDnsDraft({ ...dnsDraft, type: event.target.value })} value={dnsDraft.type}>
              {["A", "AAAA", "CNAME", "MX", "TXT"].map((type) => <option key={type}>{type}</option>)}
            </select>
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDnsDraft({ ...dnsDraft, value: event.target.value })} placeholder="DNS value" value={dnsDraft.value} />
            <button className="h-10 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" disabled={!dnsDraft.domainId || !dnsDraft.value} onClick={() => createDns.mutate()} type="button">DNS</button>
          </div>
        </Panel> : null}

        {showMail ? <Panel id="mail" title="Mailboxes" icon={<Inbox size={17} />}>
          <div className="mb-4 rounded-md border border-panel-line bg-slate-50 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-panel-text">Create email account</div>
                <div className="text-xs text-panel-muted">Mailbox users can sign in separately at /webmail/login.</div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Link className="flex h-9 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-xs font-semibold hover:bg-slate-50" href="/webmail/login" target="_blank">
                  <ExternalLink size={14} />
                  Webmail
                </Link>
                <Link className={`flex h-9 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-xs font-semibold hover:bg-slate-50 ${mailOpsDomainId ? "" : "pointer-events-none opacity-50"}`} href={mailOpsDomainId ? `/domains/${mailOpsDomainId}/mail/settings` : "#"}>
                  <Mail size={14} />
                  Mail Settings
                </Link>
                <Link className={`flex h-9 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-xs font-semibold hover:bg-slate-50 ${mailOpsDomainId ? "" : "pointer-events-none opacity-50"}`} href={mailOpsDomainId ? `/domains/${mailOpsDomainId}/mail/diagnostics` : "#"}>
                  <CheckCircle2 size={14} />
                  Diagnostics
                </Link>
                <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-xs font-semibold text-white disabled:opacity-60" disabled={!mailOpsDomainId || configureSmtp.isPending} onClick={() => configureSmtp.mutate(mailOpsDomainId)} title={`Apply SMTP repair for ${mailOpsDomainName}`} type="button">
                  <RotateCw size={14} />
                  {configureSmtp.isPending ? "Configuring..." : "Configure SMTP"}
                </button>
              </div>
            </div>
            <div className="grid gap-2 lg:grid-cols-[1fr_1fr_1fr_140px_auto]">
              <SearchableDomainSelect domains={domains} value={mailDraft.domainId} onChange={(domainId) => setMailDraft({ ...mailDraft, domainId })} />
              <input className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, username: event.target.value.trim().toLowerCase() })} placeholder="name" value={mailDraft.username} />
              <input className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, password: event.target.value })} placeholder="Password" type="password" value={mailDraft.password} />
              <input className="h-10 rounded-md border border-panel-line bg-white px-3 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, quotaMb: event.target.value.replace(/\D/g, "") })} placeholder="Quota MB" value={mailDraft.quotaMb} />
              <button className="flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={!mailDraft.domainId || !mailDraft.username || mailDraft.password.length < 10 || createMailbox.isPending} onClick={() => createMailbox.mutate()} type="button">
                <Plus size={15} />
                Create
              </button>
            </div>
          </div>
          <div className="overflow-hidden rounded-md border border-panel-line">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                <tr>
                  <th className="px-4 py-3">Mailbox</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Quota</th>
                  <th className="px-4 py-3">Password</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(data?.mailAccounts ?? []).map((mailbox) => {
                  const edit = mailEdit[mailbox.id] ?? { quotaMb: String(mailbox.quotaMb), enabled: mailbox.enabled };
                  return (
                  <tr className="border-t border-panel-line align-top" key={mailbox.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{mailboxAddress(mailbox)}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs">
                        <button className="text-panel-accent hover:underline" onClick={() => copyText(mailboxAddress(mailbox), "Mailbox address copied.")} type="button">Copy email</button>
                        <button className="text-panel-accent hover:underline" onClick={() => copyText(`${webmailUrl}\nEmail: ${mailboxAddress(mailbox)}`, "Webmail login details copied.")} type="button">Copy login</button>
                        <button className="text-panel-accent hover:underline" onClick={() => copyText(mailboxSmtpSettings(mailbox), "SMTP settings copied.")} type="button">Copy SMTP</button>
                        <button className="text-panel-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50" disabled={!mailbox.domain?.id || configureSmtp.isPending} onClick={() => mailbox.domain?.id && configureSmtp.mutate(mailbox.domain.id)} type="button">Configure SMTP</button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <label className="flex items-center gap-2">
                        <input checked={edit.enabled} onChange={(event) => setMailEdit({ ...mailEdit, [mailbox.id]: { ...edit, enabled: event.target.checked } })} type="checkbox" />
                        <span className={edit.enabled ? "text-emerald-700" : "text-panel-danger"}>{edit.enabled ? "Enabled" : "Disabled"}</span>
                      </label>
                    </td>
                    <td className="px-4 py-3">
                      <input className="h-9 w-28 rounded-md border border-panel-line px-3 text-xs" onChange={(event) => setMailEdit({ ...mailEdit, [mailbox.id]: { ...edit, quotaMb: event.target.value.replace(/\D/g, "") } })} value={edit.quotaMb} />
                      <span className="ml-2 text-xs text-panel-muted">MB</span>
                    </td>
                    <td className="px-4 py-3">
                      <input className="h-9 w-full rounded-md border border-panel-line px-3 text-xs" onChange={(event) => setMailReset({ ...mailReset, [mailbox.id]: event.target.value })} placeholder="New password" type="password" value={mailReset[mailbox.id] ?? ""} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button className="flex items-center gap-1 rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => updateMailbox.mutate({ id: mailbox.id, body: { quotaMb: Number(edit.quotaMb || mailbox.quotaMb), enabled: edit.enabled } })} type="button">
                          <Save size={13} />
                          Save
                        </button>
                        <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" disabled={(mailReset[mailbox.id] ?? "").length < 10} onClick={() => updateMailbox.mutate({ id: mailbox.id, body: { password: mailReset[mailbox.id] } })} type="button">Reset password</button>
                        <Link className="flex items-center gap-1 rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" href="/webmail/login" target="_blank">
                          <Mail size={13} />
                          Login
                        </Link>
                        <button className="rounded-md border border-red-200 px-2 py-1 text-xs text-panel-danger hover:bg-red-50" onClick={() => deleteMailbox.mutate(mailbox.id)} type="button">Delete</button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
                {!data?.mailAccounts.length ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-panel-muted" colSpan={5}>No mailboxes yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Panel> : null}
      </div> : null}

      {showFiles || showDeployments || showDatabases || showProfile ? <div className={isDashboard ? "grid grid-cols-[1.1fr_0.9fr] gap-6" : "grid grid-cols-1 gap-6"}>
        {showFiles ? <Panel id="files" title="Files" icon={<FileText size={17} />}>
          <div className="mb-3 truncate rounded-md border border-panel-line bg-slate-50 px-3 py-2 font-mono text-xs text-panel-muted">{data?.fileRoot ?? ""}/{filePath === "." ? "" : filePath}</div>
          <div className="mb-4 grid grid-cols-[1fr_auto] gap-2">
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setFileDraft({ ...fileDraft, name: event.target.value })} placeholder="new-file.html" value={fileDraft.name} />
            <button className="flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" disabled={!fileDraft.name} onClick={() => createFile.mutate()} type="button">
              <Save size={15} />
              File
            </button>
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setFolderName(event.target.value)} placeholder="folder" value={folderName} />
            <button className="flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" disabled={!folderName} onClick={() => createFolder.mutate()} type="button">
              <FolderPlus size={15} />
              Folder
            </button>
          </div>
          {filePath !== "." ? <button className="mb-2 text-sm text-panel-accent" onClick={() => setFilePath(parentPath(filePath))} type="button">Back</button> : null}
          <div className="overflow-hidden rounded-md border border-panel-line">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Size</th>
                  <th className="px-4 py-3">Modified</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(files.data?.items ?? []).map((item) => (
                  <tr className="border-t border-panel-line" key={item.path}>
                    <td className="px-4 py-3">
                      <button className="min-w-0 truncate text-left font-medium text-panel-accent hover:underline" onClick={() => item.type === "directory" ? setFilePath(item.path) : openFile.mutate(item.path)} type="button">{item.name}</button>
                    </td>
                    <td className="px-4 py-3">{item.type}</td>
                    <td className="px-4 py-3">{item.size}</td>
                    <td className="px-4 py-3 text-panel-muted">{new Date(item.modifiedAt).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteFile.mutate(item.path)} title="Delete" type="button"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!files.isLoading && !(files.data?.items ?? []).length ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-panel-muted" colSpan={5}>No files in this folder.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {editorPath ? (
            <div className="mt-4 border-t border-panel-line pt-4">
              <div className="mb-2 truncate font-mono text-xs text-panel-muted">{editorPath}</div>
              <textarea className="h-64 w-full rounded-md border border-panel-line p-3 font-mono text-xs" onChange={(event) => setEditorContent(event.target.value)} value={editorContent} />
              <button className="mt-2 flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white" onClick={() => saveFile.mutate()} type="button">
                <Save size={15} />
                Save File
              </button>
            </div>
          ) : null}
        </Panel> : null}

        {showDeployments || showDatabases || showProfile ? <div className="space-y-6">
          {showDeployments ? <Panel id="deployments" title="Deployments" icon={<CheckCircle2 size={17} />}>
            <div className="mb-4 grid grid-cols-2 gap-2">
              <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDeploymentDraft({ ...deploymentDraft, name: event.target.value })} placeholder="App name" value={deploymentDraft.name} />
              <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDeploymentDraft({ ...deploymentDraft, framework: event.target.value })} value={deploymentDraft.framework}>
                {["STATIC", "NEXTJS", "NODEJS", "LARAVEL", "PYTHON", "GO"].map((item) => <option key={item}>{item}</option>)}
              </select>
              <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDeploymentDraft({ ...deploymentDraft, domainId: event.target.value })} value={deploymentDraft.domainId}>
                <option value="">No domain</option>
                {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
              </select>
              <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDeploymentDraft({ ...deploymentDraft, gitUrl: event.target.value })} placeholder="Git URL optional" value={deploymentDraft.gitUrl} />
              <input className="col-span-2 h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDeploymentDraft({ ...deploymentDraft, startCommand: event.target.value })} placeholder="Start command optional" value={deploymentDraft.startCommand} />
              <button className="col-span-2 flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!deploymentDraft.name || createDeployment.isPending} onClick={() => createDeployment.mutate()} type="button">
                <Plus size={15} />
                Create Deployment
              </button>
            </div>
            <div className="overflow-hidden rounded-md border border-panel-line">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                  <tr>
                    <th className="px-4 py-3">Deployment</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Health</th>
                    <th className="px-4 py-3">Port</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.deployments ?? []).map((deployment) => (
                    <tr className="border-t border-panel-line" key={deployment.id}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{deployment.name}</div>
                        <div className="text-xs text-panel-muted">{deployment.slug}</div>
                      </td>
                      <td className="px-4 py-3">{deployment.status}</td>
                      <td className="px-4 py-3">{deployment.healthStatus}</td>
                      <td className="px-4 py-3">:{deployment.port}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <IconButton title="Deploy" onClick={() => startDeploymentAction(deployment, "deploy")}><Play size={14} /></IconButton>
                          <IconButton title="Restart" onClick={() => startDeploymentAction(deployment, "restart")}><RotateCw size={14} /></IconButton>
                          <IconButton title="Stop" onClick={() => startDeploymentAction(deployment, "stop")}><Square size={14} /></IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!data?.deployments.length ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-panel-muted" colSpan={5}>No deployments assigned to this account.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Panel> : null}
          {showDatabases ? <Panel id="databases" title="Databases" icon={<Database size={17} />}>
            <div className="mb-4 grid grid-cols-2 gap-2">
              <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDatabaseDraft({ ...databaseDraft, engine: event.target.value })} value={databaseDraft.engine}>
                <option value="POSTGRESQL">PostgreSQL</option>
                <option value="MYSQL">MySQL</option>
              </select>
              <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDatabaseDraft({ ...databaseDraft, database: event.target.value })} placeholder={`${data?.account.username ?? "user"}_db`} value={databaseDraft.database} />
              <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDatabaseDraft({ ...databaseDraft, username: event.target.value })} placeholder={`${data?.account.username ?? "user"}_user`} value={databaseDraft.username} />
              <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDatabaseDraft({ ...databaseDraft, password: event.target.value })} placeholder="Password" type="password" value={databaseDraft.password} />
              <button className="col-span-2 flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!databaseDraft.database || !databaseDraft.username || createDatabase.isPending} onClick={() => createDatabase.mutate()} type="button">
                <Plus size={15} />
                Create Database
              </button>
            </div>
            <div className="overflow-hidden rounded-md border border-panel-line">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-panel-muted">
                  <tr>
                    <th className="px-4 py-3">Database</th>
                    <th className="px-4 py-3">Engine</th>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.databases ?? []).map((database) => (
                    <tr className="border-t border-panel-line" key={database.id}>
                      <td className="px-4 py-3 font-medium">{database.database}</td>
                      <td className="px-4 py-3">{database.engine}</td>
                      <td className="px-4 py-3">{database.username}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteDatabase.mutate(database.id)} type="button" title="Delete"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!data?.databases.length ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-panel-muted" colSpan={4}>No databases yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Panel> : null}
          {showProfile ? <Panel id="profile" title="Profile" icon={<CheckCircle2 size={17} />}>
            <div className="mb-3 text-sm text-panel-muted">{data?.account.email ?? "No email"} · {data?.account.ownerName ?? "No owner"}</div>
            <div className="space-y-2">
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setPasswordDraft({ ...passwordDraft, currentPassword: event.target.value })} placeholder="Current password" type="password" value={passwordDraft.currentPassword} />
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setPasswordDraft({ ...passwordDraft, newPassword: event.target.value })} placeholder="New password" type="password" value={passwordDraft.newPassword} />
              <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!passwordDraft.currentPassword || passwordDraft.newPassword.length < 10 || changePassword.isPending} onClick={() => changePassword.mutate()} type="button">
                <Save size={15} />
                Change Password
              </button>
            </div>
          </Panel> : null}
          {showProfile ? <Panel id="api-token" title="Account API Token" icon={<KeyRound size={17} />}>
            <div className="space-y-4">
              <div className="text-sm text-panel-muted">
                Generate a bearer token for account-scoped API calls like adding domains. The token is shown only after generation.
              </div>
              <TokenExpiryControls mode={apiTokenExpiryMode} setMode={setApiTokenExpiryMode} expiresAt={apiTokenExpiresAt} setExpiresAt={setApiTokenExpiresAt} />
              <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={generateApiToken.isPending} onClick={() => generateApiToken.mutate()} type="button">
                <KeyRound size={15} />
                {generateApiToken.isPending ? "Generating" : apiToken ? "Generate New Token" : "Generate API Token"}
              </button>
              {apiToken ? (
                <div className="space-y-3">
                  <div className="rounded-md border border-panel-line bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase text-panel-muted">Bearer Token</div>
                      <button className="flex h-8 items-center gap-2 rounded-md border border-panel-line bg-white px-2 text-xs hover:bg-slate-50" onClick={() => copyText(apiToken.token, "API token copied.")} type="button">
                        <Copy size={13} />
                        Copy
                      </button>
                    </div>
                    <div className="break-all font-mono text-xs text-panel-text">{apiToken.token}</div>
                  </div>
                  <div className="rounded-md border border-panel-line bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase text-panel-muted">Domain API .env</div>
                      <button className="flex h-8 items-center gap-2 rounded-md border border-panel-line bg-white px-2 text-xs hover:bg-slate-50" onClick={() => copyText(accountDomainEnv(apiToken), "Domain API .env copied.")} type="button">
                        <Copy size={13} />
                        Copy
                      </button>
                    </div>
                    <pre className="whitespace-pre-wrap break-all font-mono text-xs text-panel-text">{accountDomainEnv(apiToken)}</pre>
                  </div>
                  <div className="text-xs text-panel-muted">{tokenExpiryText(apiToken)}. Generate a new token anytime.</div>
                </div>
              ) : null}
            </div>
          </Panel> : null}
        </div> : null}
      </div> : null}
      </section>
      {runtimeModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white shadow-xl">
            <div className="border-b border-panel-line p-5">
              <h2 className="text-xl font-bold text-panel-text">Install required server packages?</h2>
              <p className="mt-1 text-sm text-panel-muted">
                {runtimeModal.deployment.name} needs these missing runtime tools before {runtimeModal.action}. Turn off anything you do not want installed now.
              </p>
              {runtimeModal.review.phpVersion ? <p className="mt-2 text-xs font-medium text-panel-muted">Current server PHP: {runtimeModal.review.phpVersion}</p> : null}
            </div>
            <div className="space-y-3 p-5">
              {runtimeModal.review.installable.map((item) => (
                <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-panel-line p-4 hover:bg-slate-50" key={item.tool}>
                  <div>
                    <div className="font-semibold text-panel-text">{item.label}</div>
                    <div className="mt-1 text-sm text-panel-muted">{item.reason}</div>
                    <div className="mt-2 font-mono text-xs text-panel-muted">{item.command}</div>
                  </div>
                  <input
                    checked={runtimeModal.selected[item.tool] ?? false}
                    className="mt-1 h-5 w-5"
                    onChange={(event) => setRuntimeModal({
                      ...runtimeModal,
                      selected: { ...runtimeModal.selected, [item.tool]: event.target.checked }
                    })}
                    type="checkbox"
                  />
                </label>
              ))}
              {runtimeModal.review.blocked.length ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Not auto-installable: {runtimeModal.review.blocked.join(", ")}. These may still need manual server setup.
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-panel-line p-5">
              <button className="rounded-md border border-panel-line px-4 py-2 text-sm font-medium hover:bg-slate-50" onClick={() => setRuntimeModal(null)} type="button">Cancel</button>
              <button
                className="rounded-md bg-panel-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                disabled={deploymentAction.isPending || !Object.values(runtimeModal.selected).some(Boolean)}
                onClick={() => continueRuntimeInstall(runtimeModal)}
                type="button"
              >
                {deploymentAction.isPending ? "Installing..." : "Install selected and continue"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Metric({ label, value, limit }: { label: string; value?: number; limit?: number | null }) {
  return (
    <div className="rounded-md border border-panel-line bg-white p-4">
      <div className="text-xs text-panel-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value ?? "..."}</div>
      <div className="mt-1 text-xs text-panel-muted">Limit {limit ?? "unlimited"}</div>
    </div>
  );
}

function Panel({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-md border border-panel-line bg-white" id={id}>
      <div className="flex items-center gap-2 border-b border-panel-line px-4 py-3 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Row({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="border-t border-panel-line py-2">
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-panel-muted">{detail}</div>
    </div>
  );
}

function ListEmpty({ show, label }: { show: boolean; label: string }) {
  return show ? <div className="rounded-md border border-dashed border-panel-line p-4 text-sm text-panel-muted">{label}</div> : null;
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50" onClick={onClick} title={title} type="button">
      {children}
    </button>
  );
}

function SearchableDomainSelect({ domains, value, onChange }: { domains: Domain[]; value: string; onChange: (value: string) => void }) {
  const selected = domains.find((domain) => domain.id === value);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(selected?.name ?? "");
  const normalizedSearch = search.trim().toLowerCase();
  const matches = domains
    .filter((domain) => !normalizedSearch || domain.name.toLowerCase().includes(normalizedSearch))
    .slice(0, 50);

  useEffect(() => {
    if (!open) setSearch(selected?.name ?? "");
  }, [open, selected?.name]);

  return (
    <div className="relative">
      <input
        className="h-10 w-full rounded-md border border-panel-line bg-white px-3 text-sm"
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          const next = event.target.value;
          setSearch(next);
          setOpen(true);
          const exact = domains.find((domain) => domain.name.toLowerCase() === next.trim().toLowerCase());
          onChange(exact?.id ?? "");
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search domain"
        value={open ? search : selected?.name ?? ""}
      />
      {open ? (
        <div className="absolute left-0 right-0 top-11 z-30 max-h-72 overflow-auto rounded-md border border-panel-line bg-white py-1 text-sm shadow-xl">
          {matches.map((domain) => (
            <button
              className={`block w-full px-3 py-2 text-left hover:bg-slate-50 ${domain.id === value ? "bg-teal-50 font-semibold text-panel-accent" : "text-panel-ink"}`}
              key={domain.id}
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(domain.id);
                setSearch(domain.name);
                setOpen(false);
              }}
              type="button"
            >
              {domain.name}
            </button>
          ))}
          {!matches.length ? <div className="px-3 py-3 text-panel-muted">No domains found.</div> : null}
          {domains.length > matches.length ? <div className="border-t border-panel-line px-3 py-2 text-xs text-panel-muted">Showing {matches.length} of {domains.length}. Keep typing to narrow.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function accountDomainEnv(apiToken: AccountApiToken) {
  const apiBase = apiToken.apiBaseUrl.replace(/\/api\/v1$/, "");
  return [
    `ACCOUNT_DOMAIN_API_BASE_URL=${apiBase}`,
    `ACCOUNT_DOMAIN_API_TOKEN=${apiToken.token}`,
    "ACCOUNT_DOMAIN_API_TIMEOUT=30",
    "ACCOUNT_DOMAIN_FORCE_SSL=true",
    "ACCOUNT_DOMAIN_HOSTING_MODE=PUBLIC_HTML",
    "ACCOUNT_DOMAIN_DOCUMENT_ROOT=public_html"
  ].join("\n");
}

function parentPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}
