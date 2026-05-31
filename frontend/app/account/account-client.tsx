"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, FolderPlus, Globe2, Inbox, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { apiDeleteBody, apiGet, apiPost, apiPut } from "@/lib/api";

type Domain = { id: string; name: string; status: string; documentRoot: string };
type Deployment = { id: string; name: string; slug: string; status: string; healthStatus: string; port: number; dbType?: string | null };
type Mailbox = { id: string; username: string; quotaMb: number; enabled: boolean; domain?: { name: string } };
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
    diskLimitMb: number | null;
    domainLimit: number | null;
    mailboxLimit: number | null;
    databaseLimit: number | null;
    deploymentLimit: number | null;
  };
  domains: Domain[];
  deployments: Deployment[];
  mailAccounts: Mailbox[];
  fileRoot: string;
};
type FileList = { current: FileEntry; root: string; items: FileEntry[] };

export function AccountClient() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");
  const [domainName, setDomainName] = useState("");
  const [mailDraft, setMailDraft] = useState({ domainId: "", username: "", password: "", quotaMb: "1024" });
  const [filePath, setFilePath] = useState(".");
  const [fileDraft, setFileDraft] = useState({ name: "", content: "" });
  const [folderName, setFolderName] = useState("");
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
        <Metric label="Disk MB" value={0} limit={data?.usage.diskLimitMb} />
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
            <Row key={domain.id} title={domain.name} detail={`${domain.status} · ${domain.documentRoot}`} />
          ))}
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
            <Row key={mailbox.id} title={`${mailbox.username}@${mailbox.domain?.name ?? ""}`} detail={`${mailbox.enabled ? "enabled" : "disabled"} · ${mailbox.quotaMb} MB`} />
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
              <button className="min-w-0 truncate text-left" onClick={() => item.type === "directory" ? setFilePath(item.path) : undefined} type="button">
                {item.type === "directory" ? "Folder" : "File"} · {item.name}
              </button>
              <button className="rounded-md border border-red-200 p-2 text-panel-danger hover:bg-red-50" onClick={() => deleteFile.mutate(item.path)} title="Delete" type="button">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <ListEmpty show={!files.isLoading && !(files.data?.items ?? []).length} label="No files in this folder." />
        </Panel>

        <div className="space-y-6">
          <Panel id="deployments" title="Deployments" icon={<CheckCircle2 size={17} />}>
            <ListEmpty show={!data?.deployments.length} label="No deployments assigned to this account." />
            {(data?.deployments ?? []).map((deployment) => (
              <Row key={deployment.id} title={deployment.name} detail={`${deployment.status} · ${deployment.healthStatus} · :${deployment.port}`} />
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

function parentPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}
