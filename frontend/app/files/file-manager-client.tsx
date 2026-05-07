"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Eye,
  FileCode2,
  FilePlus,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload
} from "lucide-react";
import { apiDeleteBody, apiGet, apiPatch, apiPost } from "@/lib/api";
import Link from "next/link";

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  kind: "directory" | "text" | "image" | "pdf" | "binary" | string;
  extension: string;
  size: number;
  modifiedAt: string;
  createdAt: string;
  permissions: string;
  mime: string | null;
  isHidden: boolean;
  isReadonly: boolean;
};

type ListResponse = {
  current: FileEntry;
  breadcrumbs: Array<{ name: string; path: string }>;
  items: FileEntry[];
  total: number;
  page: number;
  pageSize: number;
};

type TreeEntry = FileEntry & { children: TreeEntry[] };

type TreeResponse = {
  root: FileEntry;
  children: TreeEntry[];
};

type Domain = {
  id: string;
  name: string;
  status: "ACTIVE" | "PENDING" | "SUSPENDED";
};

type DomainListResponse = {
  items: Domain[];
  total: number;
};

type Overview = {
  root: string;
  platform: string;
  textReadLimit: number;
  uploadLimit: number;
};

type DownloadResponse = {
  file: FileEntry;
  contentBase64: string;
};

type DomainScaffoldResponse = {
  root: FileEntry;
  scaffold: {
    domain: string;
    relativeRoot: string;
    folders: string[];
  };
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function parentPath(filePath: string) {
  if (filePath === "." || !filePath.includes("/")) return ".";
  return filePath.split("/").slice(0, -1).join("/") || ".";
}

function joinPath(folderPath: string, name: string) {
  return folderPath === "." ? name : `${folderPath}/${name}`;
}

function queryString(values: Record<string, string | number>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => params.set(key, String(value)));
  return params.toString();
}

function editorHref(filePath: string) {
  return `/files/editor?${queryString({ path: filePath })}`;
}

function TreeNode({ node, currentPath, onOpen }: { node: TreeEntry; currentPath: string; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState(currentPath.startsWith(node.path));
  return (
    <div>
      <button
        className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-slate-100 ${currentPath === node.path ? "bg-slate-100 font-semibold" : ""}`}
        onClick={() => {
          setOpen(!open);
          onOpen(node.path);
        }}
        type="button"
      >
        <ChevronRight className={open ? "rotate-90" : ""} size={14} />
        <Folder size={15} />
        <span className="truncate">{node.name}</span>
      </button>
      {open && node.children.length > 0 ? (
        <div className="ml-4 border-l border-panel-line pl-2">
          {node.children.map((child) => (
            <TreeNode currentPath={currentPath} key={child.path} node={child} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FileManagerClient() {
  const queryClient = useQueryClient();
  const [currentPath, setCurrentPath] = useState(".");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [sort, setSort] = useState<"name" | "size" | "modifiedAt">("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [lastResult, setLastResult] = useState("");
  const [imagePreview, setImagePreview] = useState("");
  const [selectedDomainId, setSelectedDomainId] = useState("");

  const domains = useQuery({
    queryKey: ["domains", "file-manager"],
    queryFn: () => apiGet<DomainListResponse>("/domains?page=1&pageSize=100")
  });
  const selectedDomain = domains.data?.items.find((domain) => domain.id === selectedDomainId) ?? null;
  const domainRootPath = selectedDomain?.name ?? ".";

  const listPath = `/files/list?${queryString({ path: currentPath, search, sort, direction, page: 1, pageSize: 200 })}`;

  const overview = useQuery({ queryKey: ["files-overview"], queryFn: () => apiGet<Overview>("/files/overview") });
  const list = useQuery({ queryKey: ["files-list", currentPath, search, sort, direction], queryFn: () => apiGet<ListResponse>(listPath) });
  const tree = useQuery({ queryKey: ["files-tree", domainRootPath], queryFn: () => apiGet<TreeResponse>(`/files/tree?${queryString({ path: domainRootPath, depth: 4 })}`) });

  const selectedEntry = useMemo(() => list.data?.items.find((item) => item.path === selectedPath) ?? null, [list.data?.items, selectedPath]);
  const canEdit = selectedEntry?.type === "file" && selectedEntry.kind === "text";

  const invalidateFiles = async () => {
    await queryClient.invalidateQueries({ queryKey: ["files-list"] });
    await queryClient.invalidateQueries({ queryKey: ["files-tree"] });
  };

  useEffect(() => {
    let cancelled = false;
    setImagePreview("");
    if (selectedEntry?.kind !== "image") return;
    apiGet<DownloadResponse>(`/files/download?${queryString({ path: selectedEntry.path })}`)
      .then((response) => {
        if (!cancelled) setImagePreview(`data:${response.file.mime ?? "image/png"};base64,${response.contentBase64}`);
      })
      .catch((error) => setLastResult(error instanceof Error ? error.message : "Could not load preview"));
    return () => {
      cancelled = true;
    };
  }, [selectedEntry?.path, selectedEntry?.kind]);

  const createFile = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) => apiPost<FileEntry>("/files/files", { parentPath: currentPath, name, content: value }),
    onSuccess: async (file) => {
      setSelectedPath(file.path);
      setLastResult("File created.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create file")
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiPost<FileEntry>("/files/folders", { parentPath: currentPath, name }),
    onSuccess: async () => {
      setLastResult("Folder created.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create folder")
  });

  const createDomainFolder = useMutation({
    mutationFn: (domainName: string) => apiPost<DomainScaffoldResponse>("/files/domain-scaffold", { domain: domainName }),
    onSuccess: async (response) => {
      setCurrentPath(response.root.path);
      setSelectedPath(null);
      setLastResult(`Default folders ready for ${response.scaffold.domain}.`);
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create default folders")
  });

  const renameItem = useMutation({
    mutationFn: ({ path, name }: { path: string; name: string }) => apiPatch<{ ok: true; file: FileEntry }>("/files/rename", { path, name }),
    onSuccess: async (response) => {
      setSelectedPath(response.file.path);
      setLastResult("Renamed.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not rename")
  });

  const deleteItems = useMutation({
    mutationFn: (paths: string[]) => apiDeleteBody<{ ok: true; removed: string[] }>("/files/delete", { paths }),
    onSuccess: async () => {
      setSelectedPath(null);
      setLastResult("Deleted.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not delete")
  });

  const copyItem = useMutation({
    mutationFn: ({ sourcePath, name }: { sourcePath: string; name: string }) => apiPost("/files/copy", { sourcePath, targetParentPath: currentPath, name, overwrite: false }),
    onSuccess: async () => {
      setLastResult("Copied.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not copy")
  });

  const moveItem = useMutation({
    mutationFn: ({ sourcePath, name }: { sourcePath: string; name: string }) => apiPost("/files/move", { sourcePath, targetParentPath: currentPath, name, overwrite: false }),
    onSuccess: async () => {
      setLastResult("Moved.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not move")
  });

  const chmodItem = useMutation({
    mutationFn: ({ path, mode }: { path: string; mode: string }) => apiPost("/files/chmod", { path, mode }),
    onSuccess: (result) => setLastResult(JSON.stringify(result)),
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not change permissions")
  });

  const archiveCreate = useMutation({
    mutationFn: ({ sourcePath, archivePath }: { sourcePath: string; archivePath: string }) => apiPost("/files/archive/create", { sourcePaths: [sourcePath], archivePath }),
    onSuccess: async (result) => {
      setLastResult(JSON.stringify(result));
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create archive")
  });

  const archiveExtract = useMutation({
    mutationFn: ({ archivePath, targetPath }: { archivePath: string; targetPath: string }) => apiPost("/files/archive/extract", { archivePath, targetPath, overwrite: false }),
    onSuccess: async (result) => {
      setLastResult(JSON.stringify(result));
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not extract archive")
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  async function download(pathValue: string) {
    const response = await apiGet<DownloadResponse>(`/files/download?${queryString({ path: pathValue })}`);
    const binary = atob(response.contentBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: response.file.mime ?? "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = response.file.name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function checksum(pathValue: string) {
    const response = await apiGet<{ hash: string }>(`/files/checksum?${queryString({ path: pathValue })}`);
    await navigator.clipboard.writeText(response.hash);
    setLastResult(`SHA256 copied: ${response.hash}`);
  }

  async function uploadFile(file: File) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    await apiPost("/files/upload", { parentPath: currentPath, name: file.name, contentBase64: btoa(binary), overwrite: false });
    setLastResult("Uploaded.");
    await invalidateFiles();
  }

  function selectDomain(domainId: string) {
    const domain = domains.data?.items.find((item) => item.id === domainId) ?? null;
    setSelectedDomainId(domainId);
    setCurrentPath(domain?.name ?? ".");
    setSelectedPath(null);
    setSearch("");
    setDraftSearch("");
    setLastResult("");
  }

  return (
    <section className="grid h-[calc(100vh-81px)] grid-cols-[300px_minmax(520px,1fr)_380px] overflow-hidden p-8">
      <aside className="min-h-0 rounded-l-md border border-panel-line bg-white">
        <div className="border-b border-panel-line p-4">
          <div className="truncate text-sm font-semibold">{selectedDomain ? selectedDomain.name : overview.data?.root ?? "File root"}</div>
          <div className="mt-1 text-xs text-panel-muted">{overview.data ? `${formatBytes(overview.data.textReadLimit)} editor limit` : "Loading..."}</div>
        </div>
        <div className="h-[calc(100%-73px)] overflow-auto p-3">
          <button
            className={`mb-2 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-slate-100 ${currentPath === domainRootPath ? "bg-slate-100 font-semibold" : ""}`}
            onClick={() => setCurrentPath(domainRootPath)}
            type="button"
          >
            <Folder size={15} />
            {selectedDomain ? selectedDomain.name : "root"}
          </button>
          {tree.data?.children.map((node) => <TreeNode currentPath={currentPath} key={node.path} node={node} onOpen={setCurrentPath} />)}
        </div>
      </aside>

      <main className="min-h-0 border-y border-panel-line bg-white">
        <div className="space-y-3 border-b border-panel-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 min-w-64 rounded-md border border-panel-line px-2 text-sm"
              onChange={(event) => selectDomain(event.target.value)}
              value={selectedDomainId}
            >
              <option value="">All files</option>
              {(domains.data?.items ?? []).map((domain) => (
                <option key={domain.id} value={domain.id}>{domain.name}</option>
              ))}
            </select>
            {selectedDomain ? (
              <span className="text-xs text-panel-muted">Showing /var/www/{selectedDomain.name}</span>
            ) : (
              <span className="text-xs text-panel-muted">Showing full file root</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => list.refetch()} type="button"><RefreshCw size={15} /> Refresh</button>
            <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => {
              const name = window.prompt("New file name");
              if (name) createFile.mutate({ name, value: "" });
            }} type="button"><FilePlus size={15} /> New File</button>
            <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={() => {
              const name = window.prompt("New folder name");
              if (name) createFolder.mutate(name);
            }} type="button"><FolderPlus size={15} /> New Folder</button>
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50">
              <Upload size={15} />
              Upload
              <input className="hidden" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) uploadFile(file).catch((error) => setLastResult(error instanceof Error ? error.message : "Upload failed"));
                event.target.value = "";
              }} type="file" />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form className="relative" onSubmit={submitSearch}>
              <Search className="absolute left-3 top-2.5 text-panel-muted" size={15} />
              <input className="h-9 w-72 rounded-md border border-panel-line pl-9 pr-3 text-sm" onChange={(event) => setDraftSearch(event.target.value)} placeholder="Search current folder" value={draftSearch} />
            </form>
            <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setSort(event.target.value as "name" | "size" | "modifiedAt")} value={sort}>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="modifiedAt">Modified</option>
            </select>
            <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setDirection(event.target.value as "asc" | "desc")} value={direction}>
              <option value="asc">Asc</option>
              <option value="desc">Desc</option>
            </select>
            {list.data?.breadcrumbs.filter((crumb) => !selectedDomain || crumb.path !== ".").map((crumb) => (
              <button className="h-8 rounded-md px-2 text-xs text-panel-muted hover:bg-slate-100" key={crumb.path} onClick={() => setCurrentPath(crumb.path)} type="button">
                {crumb.name}
              </button>
            ))}
          </div>
        </div>

        {lastResult ? <div className="border-b border-panel-line bg-slate-50 px-4 py-2 text-sm text-slate-700">{lastResult}</div> : null}
        {list.isError && selectedDomain ? (
          <div className="border-b border-panel-line bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <div className="font-medium">No default folders exist for {selectedDomain.name} yet.</div>
            <button
              className="mt-2 h-8 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold hover:bg-amber-100 disabled:opacity-60"
              disabled={createDomainFolder.isPending}
              onClick={() => createDomainFolder.mutate(selectedDomain.name)}
              type="button"
            >
              Create default folders
            </button>
          </div>
        ) : list.isError ? (
          <div className="border-b border-panel-line bg-red-50 px-4 py-3 text-sm text-panel-danger">
            {list.error instanceof Error ? list.error.message : "Could not load files"}
          </div>
        ) : null}

        <div className="h-[calc(100%-122px)] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3">Modified</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((item) => (
                <tr
                  className={`cursor-pointer border-t border-panel-line hover:bg-slate-50 ${selectedPath === item.path ? "bg-slate-50" : ""}`}
                  key={item.path}
                  onClick={() => {
                    setSelectedPath(item.path);
                    if (item.type === "directory") setCurrentPath(item.path);
                  }}
                >
                  <td className="max-w-0 px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {item.type === "directory" ? <Folder size={16} /> : item.kind === "image" ? <ImageIcon size={16} /> : <FileCode2 size={16} />}
                      <span className="truncate font-medium">{item.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-panel-muted">{item.type === "directory" ? "-" : formatBytes(item.size)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{item.permissions}</td>
                  <td className="px-4 py-3 text-panel-muted">{new Date(item.modifiedAt).toLocaleString()}</td>
                </tr>
              ))}
              {list.data?.items.length === 0 ? (
                <tr>
                  <td className="px-4 py-12 text-center text-panel-muted" colSpan={4}>No files found</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </main>

      <aside className="min-h-0 rounded-r-md border border-panel-line bg-white">
        <div className="flex h-full flex-col">
          <div className="border-b border-panel-line p-4">
            <div className="truncate text-sm font-semibold">{selectedEntry?.name ?? "No selection"}</div>
            <div className="mt-1 truncate text-xs text-panel-muted">{selectedEntry?.path ?? "Select a file or folder"}</div>
          </div>

          {selectedEntry ? (
            <div className="space-y-4 overflow-auto p-4">
              <div className="grid grid-cols-2 gap-2">
                {canEdit ? (
                  <Link className="flex h-9 items-center justify-center gap-2 rounded-md bg-panel-accent px-2 text-sm font-semibold text-white hover:bg-panel-accent/90" href={editorHref(selectedEntry.path)}>
                    <Edit3 size={15} /> Edit
                  </Link>
                ) : null}
                {selectedEntry.type === "file" ? (
                  <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => download(selectedEntry.path).catch((error) => setLastResult(error instanceof Error ? error.message : "Download failed"))} type="button"><Download size={15} /> Download</button>
                ) : null}
                <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => navigator.clipboard.writeText(selectedEntry.path).then(() => setLastResult("Path copied."))} type="button"><Copy size={15} /> Copy Path</button>
                <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => {
                  const name = window.prompt("Rename to", selectedEntry.name);
                  if (name && name !== selectedEntry.name) renameItem.mutate({ path: selectedEntry.path, name });
                }} type="button"><Settings2 size={15} /> Rename</button>
                <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line px-2 text-sm text-panel-danger hover:bg-red-50" onClick={() => {
                  if (window.confirm(`Delete ${selectedEntry.name}?`)) deleteItems.mutate([selectedEntry.path]);
                }} type="button"><Trash2 size={15} /> Delete</button>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-slate-50 p-3"><div className="text-panel-muted">Kind</div><div className="mt-1 font-semibold">{selectedEntry.kind}</div></div>
                <div className="rounded-md bg-slate-50 p-3"><div className="text-panel-muted">Size</div><div className="mt-1 font-semibold">{formatBytes(selectedEntry.size)}</div></div>
                <div className="rounded-md bg-slate-50 p-3"><div className="text-panel-muted">Mode</div><div className="mt-1 font-mono font-semibold">{selectedEntry.permissions}</div></div>
                <div className="rounded-md bg-slate-50 p-3"><div className="text-panel-muted">Modified</div><div className="mt-1 font-semibold">{new Date(selectedEntry.modifiedAt).toLocaleDateString()}</div></div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button className="h-9 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => {
                  const name = window.prompt("Copy name", `copy-${selectedEntry.name}`);
                  if (name) copyItem.mutate({ sourcePath: selectedEntry.path, name });
                }} type="button">Copy Here</button>
                <button className="h-9 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => {
                  const name = window.prompt("Move/rename to", selectedEntry.name);
                  if (name) moveItem.mutate({ sourcePath: selectedEntry.path, name });
                }} type="button">Move Here</button>
                <button className="h-9 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => {
                  const mode = window.prompt("Mode", selectedEntry.permissions);
                  if (mode) chmodItem.mutate({ path: selectedEntry.path, mode });
                }} type="button">Chmod</button>
                {selectedEntry.type === "file" ? (
                  <button className="h-9 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => checksum(selectedEntry.path).catch((error) => setLastResult(error instanceof Error ? error.message : "Checksum failed"))} type="button">SHA256</button>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button className="flex h-9 items-center justify-center gap-2 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => {
                  const archivePath = window.prompt("Archive path", joinPath(parentPath(selectedEntry.path), `${selectedEntry.name}.zip`));
                  if (archivePath) archiveCreate.mutate({ sourcePath: selectedEntry.path, archivePath });
                }} type="button"><Archive size={15} /> Zip</button>
                {selectedEntry.extension === ".zip" ? (
                  <button className="h-9 rounded-md border border-panel-line px-2 text-sm hover:bg-slate-50" onClick={() => archiveExtract.mutate({ archivePath: selectedEntry.path, targetPath: parentPath(selectedEntry.path) })} type="button">Extract</button>
                ) : null}
              </div>

              {canEdit ? (
                <div className="rounded-md border border-panel-line p-4 text-sm text-panel-muted">
                  Open this text file in the full-page editor for a larger workspace.
                </div>
              ) : selectedEntry.kind === "image" && imagePreview ? (
                <div className="rounded-md border border-panel-line p-3">
                  <img alt={selectedEntry.name} className="max-h-96 w-full object-contain" src={imagePreview} />
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-panel-line p-6 text-center text-sm text-panel-muted">
                  <Eye className="mx-auto mb-2" size={18} />
                  {selectedEntry.type === "directory" ? "Folder selected" : "Preview unavailable for this file type"}
                </div>
              )}
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-panel-muted">Select an item to inspect, preview, edit, or operate on it.</div>
          )}

        </div>
      </aside>
    </section>
  );
}
