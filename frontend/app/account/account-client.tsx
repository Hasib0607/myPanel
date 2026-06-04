"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Database, FileText, FolderPlus, Globe2, Inbox, Play, Plus, RefreshCw, RotateCw, Save, Square, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ApiError, apiDelete, apiDeleteBody, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { PageHeader } from "@/components/page-header";

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
type Mailbox = { id: string; username: string; quotaMb: number; enabled: boolean; domain?: { name: string } };
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
type FileList = { current: FileEntry; root: string; items: FileEntry[] };
type FileRead = { file: FileEntry; content: string };
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
  const [notice, setNotice] = useState("");
  const [domainName, setDomainName] = useState("");
  const [mailDraft, setMailDraft] = useState({ domainId: "", username: "", password: "", quotaMb: "1024" });
  const [mailReset, setMailReset] = useState<Record<string, string>>({});
  const [deploymentDraft, setDeploymentDraft] = useState({ name: "", framework: "STATIC", domainId: "", gitUrl: "", startCommand: "" });
  const [databaseDraft, setDatabaseDraft] = useState({ engine: "POSTGRESQL", database: "", username: "", password: "" });
  const [filePath, setFilePath] = useState(".");
  const [fileDraft, setFileDraft] = useState({ name: "", content: "" });
  const [editorPath, setEditorPath] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [folderName, setFolderName] = useState("");
  const [dnsDraft, setDnsDraft] = useState({ domainId: "", type: "A", name: "@", value: "", ttl: "3600" });
  const [passwordDraft, setPasswordDraft] = useState({ currentPassword: "", newPassword: "" });
  const [runtimeModal, setRuntimeModal] = useState<RuntimeModalState | null>(null);

  const dashboard = useQuery({
    queryKey: ["account-dashboard"],
    queryFn: () => apiGet<Dashboard>("/account/dashboard")
  });
  const files = useQuery({
    queryKey: ["account-files", filePath],
    queryFn: () => apiGet<FileList>(`/account/files/list?path=${encodeURIComponent(filePath)}`)
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["account-dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["account-files"] })
    ]);
  };

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
    onSuccess: async () => {
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

  const data = dashboard.data;
  const domains = data?.domains ?? [];
  const isDashboard = view === "dashboard";
  const showDomains = view === "domains";
  const showMail = view === "mail";
  const showFiles = view === "files";
  const showDeployments = view === "deployments";
  const showDatabases = view === "databases";
  const showProfile = view === "profile";

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
          <div className="mb-4 grid grid-cols-2 gap-2">
            <select className="h-10 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, domainId: event.target.value })} value={mailDraft.domainId}>
              <option value="">Domain</option>
              {domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}
            </select>
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, username: event.target.value })} placeholder="user" value={mailDraft.username} />
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, password: event.target.value })} placeholder="Password" type="password" value={mailDraft.password} />
            <input className="h-10 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setMailDraft({ ...mailDraft, quotaMb: event.target.value.replace(/\D/g, "") })} placeholder="Quota MB" value={mailDraft.quotaMb} />
            <button className="col-span-2 flex h-10 items-center justify-center gap-2 rounded-md bg-panel-accent text-sm font-semibold text-white disabled:opacity-60" disabled={!mailDraft.domainId || !mailDraft.username || !mailDraft.password || createMailbox.isPending} onClick={() => createMailbox.mutate()} type="button">
              <Plus size={15} />
              Create Mailbox
            </button>
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
                {(data?.mailAccounts ?? []).map((mailbox) => (
                  <tr className="border-t border-panel-line" key={mailbox.id}>
                    <td className="px-4 py-3 font-medium">{mailbox.username}@{mailbox.domain?.name ?? ""}</td>
                    <td className="px-4 py-3">{mailbox.enabled ? "enabled" : "disabled"}</td>
                    <td className="px-4 py-3">{mailbox.quotaMb} MB</td>
                    <td className="px-4 py-3">
                      <input className="h-9 w-full rounded-md border border-panel-line px-3 text-xs" onChange={(event) => setMailReset({ ...mailReset, [mailbox.id]: event.target.value })} placeholder="New password" type="password" value={mailReset[mailbox.id] ?? ""} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" disabled={(mailReset[mailbox.id] ?? "").length < 10} onClick={() => updateMailbox.mutate({ id: mailbox.id, body: { password: mailReset[mailbox.id] } })} type="button">Reset</button>
                        <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => updateMailbox.mutate({ id: mailbox.id, body: { enabled: !mailbox.enabled } })} type="button">{mailbox.enabled ? "Disable" : "Enable"}</button>
                        <button className="rounded-md border border-red-200 px-2 py-1 text-xs text-panel-danger hover:bg-red-50" onClick={() => deleteMailbox.mutate(mailbox.id)} type="button">Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
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

function parentPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}
