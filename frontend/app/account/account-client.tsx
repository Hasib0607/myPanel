"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Database, FileText, FolderPlus, Globe2, Inbox, Play, Plus, RefreshCw, RotateCw, Save, Square, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { apiDelete, apiDeleteBody, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";

type Domain = { id: string; name: string; status: string; documentRoot: string };
type Deployment = { id: string; name: string; slug: string; status: string; healthStatus: string; port: number; dbType?: string | null };
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

export function AccountClient() {
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
    mutationFn: ({ id, action }: { id: string; action: string }) => apiPost(`/account/deployments/${id}/${action}`, {}),
    onSuccess: async (_result, variables) => {
      setNotice(`Deployment ${variables.action} queued.`);
      await refresh();
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "Deployment action failed.")
  });

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

  return (
    <section className="space-y-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Account Dashboard</h1>
          <p className="mt-1 text-sm text-panel-muted">{data?.account.username ?? "Loading"} · {data?.account.packageName ?? "No package"}</p>
        </div>
        <button className="flex h-10 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => refresh()} type="button">
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {notice ? <div className="rounded-md border border-panel-line bg-white p-3 text-sm text-slate-700">{notice}</div> : null}

      <div className="grid grid-cols-5 gap-3">
        <Metric label="Domains" value={data?.usage.domains} limit={data?.usage.domainLimit} />
        <Metric label="Mailboxes" value={data?.usage.mailAccounts} limit={data?.usage.mailboxLimit} />
        <Metric label="Deployments" value={data?.usage.deployments} limit={data?.usage.deploymentLimit} />
        <Metric label="Databases" value={data?.usage.databases} limit={data?.usage.databaseLimit} />
        <Metric label="Disk MB" value={data?.usage.diskUsedMb} limit={data?.usage.diskLimitMb} />
      </div>

      <div className="grid grid-cols-[1.1fr_0.9fr] gap-6">
        <Panel id="domains" title="Domains" icon={<Globe2 size={17} />}>
          <div className="mb-4 flex gap-2">
            <input className="h-10 min-w-0 flex-1 rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setDomainName(event.target.value)} placeholder="example.com" value={domainName} />
            <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!domainName || createDomain.isPending} onClick={() => createDomain.mutate()} type="button">
              <Plus size={15} />
              Add
            </button>
          </div>
          <ListEmpty show={!domains.length} label="No domains assigned to this account." />
          {domains.map((domain) => (
            <div className="border-t border-panel-line py-2" key={domain.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{domain.name}</div>
                  <div className="text-xs text-panel-muted">{domain.status} · {domain.documentRoot}</div>
                </div>
                <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => queueSsl.mutate(domain.id)} type="button">Issue SSL</button>
              </div>
            </div>
          ))}
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
        </Panel>

        <Panel id="mail" title="Mailboxes" icon={<Inbox size={17} />}>
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
          <ListEmpty show={!data?.mailAccounts.length} label="No mailboxes yet." />
          {(data?.mailAccounts ?? []).map((mailbox) => (
            <div className="border-t border-panel-line py-2" key={mailbox.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{mailbox.username}@{mailbox.domain?.name ?? ""}</div>
                  <div className="text-xs text-panel-muted">{mailbox.enabled ? "enabled" : "disabled"} · {mailbox.quotaMb} MB</div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="rounded-md border border-panel-line px-2 py-1 text-xs hover:bg-slate-50" onClick={() => updateMailbox.mutate({ id: mailbox.id, body: { enabled: !mailbox.enabled } })} type="button">
                    {mailbox.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="rounded-md border border-red-200 px-2 py-1 text-xs text-panel-danger hover:bg-red-50" onClick={() => deleteMailbox.mutate(mailbox.id)} type="button">Delete</button>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <input className="h-9 min-w-0 flex-1 rounded-md border border-panel-line px-3 text-xs" onChange={(event) => setMailReset({ ...mailReset, [mailbox.id]: event.target.value })} placeholder="New password" type="password" value={mailReset[mailbox.id] ?? ""} />
                <button className="h-9 rounded-md border border-panel-line px-2 text-xs hover:bg-slate-50" disabled={(mailReset[mailbox.id] ?? "").length < 10} onClick={() => updateMailbox.mutate({ id: mailbox.id, body: { password: mailReset[mailbox.id] } })} type="button">Reset</button>
              </div>
            </div>
          ))}
        </Panel>
      </div>

      <div className="grid grid-cols-[1.1fr_0.9fr] gap-6">
        <Panel id="files" title="Files" icon={<FileText size={17} />}>
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
          {(files.data?.items ?? []).map((item) => (
            <div className="flex items-center justify-between border-t border-panel-line py-2 text-sm" key={item.path}>
              <button className="min-w-0 truncate text-left" onClick={() => item.type === "directory" ? setFilePath(item.path) : openFile.mutate(item.path)} type="button">
                {item.type === "directory" ? "Folder" : "File"} · {item.name}
              </button>
              <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteFile.mutate(item.path)} title="Delete" type="button">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <ListEmpty show={!files.isLoading && !(files.data?.items ?? []).length} label="No files in this folder." />
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
        </Panel>

        <div className="space-y-6">
          <Panel id="deployments" title="Deployments" icon={<CheckCircle2 size={17} />}>
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
            <ListEmpty show={!data?.deployments.length} label="No deployments assigned to this account." />
            {(data?.deployments ?? []).map((deployment) => (
              <div className="border-t border-panel-line py-2" key={deployment.id}>
                <div className="text-sm font-medium">{deployment.name}</div>
                <div className="text-xs text-panel-muted">{deployment.status} · {deployment.healthStatus} · :{deployment.port}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <IconButton title="Deploy" onClick={() => deploymentAction.mutate({ id: deployment.id, action: "deploy" })}><Play size={14} /></IconButton>
                  <IconButton title="Restart" onClick={() => deploymentAction.mutate({ id: deployment.id, action: "restart" })}><RotateCw size={14} /></IconButton>
                  <IconButton title="Stop" onClick={() => deploymentAction.mutate({ id: deployment.id, action: "stop" })}><Square size={14} /></IconButton>
                </div>
              </div>
            ))}
          </Panel>
          <Panel id="databases" title="Databases" icon={<Database size={17} />}>
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
            <ListEmpty show={!data?.databases.length} label="No databases yet." />
            {(data?.databases ?? []).map((database) => (
              <div className="flex items-center justify-between border-t border-panel-line py-2 text-sm" key={database.id}>
                <div>
                  <div className="font-medium">{database.database}</div>
                  <div className="text-xs text-panel-muted">{database.engine} · {database.username}</div>
                </div>
                <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteDatabase.mutate(database.id)} type="button" title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </Panel>
          <Panel id="profile" title="Profile" icon={<CheckCircle2 size={17} />}>
            <div className="mb-3 text-sm text-panel-muted">{data?.account.email ?? "No email"} · {data?.account.ownerName ?? "No owner"}</div>
            <div className="space-y-2">
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setPasswordDraft({ ...passwordDraft, currentPassword: event.target.value })} placeholder="Current password" type="password" value={passwordDraft.currentPassword} />
              <input className="h-10 w-full rounded-md border border-panel-line px-3 text-sm" onChange={(event) => setPasswordDraft({ ...passwordDraft, newPassword: event.target.value })} placeholder="New password" type="password" value={passwordDraft.newPassword} />
              <button className="flex h-10 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-60" disabled={!passwordDraft.currentPassword || passwordDraft.newPassword.length < 10 || changePassword.isPending} onClick={() => changePassword.mutate()} type="button">
                <Save size={15} />
                Change Password
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </section>
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
