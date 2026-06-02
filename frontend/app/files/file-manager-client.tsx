"use client";

import { FormEvent, MouseEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FileCode2,
  FilePlus,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  Info,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload
} from "lucide-react";
import { apiDeleteBody, apiGet, apiPatch, apiPost, apiUploadWithProgress } from "@/lib/api";
import { ConfirmModal } from "@/components/confirm-modal";
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
  subdomains?: Array<{ id: string; name: string; target: string; sslEnabled: boolean }>;
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

type UploadProgress = {
  fileName: string;
  percent: number;
  phase: "preparing" | "uploading" | "processing" | "done";
};

type FileRootOption = {
  id: string;
  label: string;
  path: string;
  hint: string;
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
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [infoTarget, setInfoTarget] = useState<FileEntry | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileEntry } | null>(null);
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [sort, setSort] = useState<"name" | "size" | "modifiedAt">("name");
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [lastResult, setLastResult] = useState("");
  const [selectedDomainId, setSelectedDomainId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

  const domains = useQuery({
    queryKey: ["domains", "file-manager"],
    queryFn: () => apiGet<DomainListResponse>("/domains?page=1&pageSize=100")
  });
  const rootOptions = useMemo<FileRootOption[]>(() => {
    const items = domains.data?.items ?? [];
    return items.flatMap((domain) => [
      { id: `domain:${domain.id}`, label: domain.name, path: domain.name, hint: `/var/www/${domain.name}` },
      ...(domain.subdomains ?? []).map((subdomain) => ({
        id: `subdomain:${subdomain.id}`,
        label: `${subdomain.name}.${domain.name}`,
        path: `${domain.name}/subdomains/${subdomain.name}`,
        hint: `/var/www/${domain.name}/subdomains/${subdomain.name}`
      }))
    ]);
  }, [domains.data?.items]);
  const selectedRoot = rootOptions.find((item) => item.id === selectedDomainId) ?? null;
  const domainRootPath = selectedRoot?.path ?? ".";

  const listPath = `/files/list?${queryString({ path: currentPath, search, sort, direction, page: 1, pageSize: 200 })}`;

  const overview = useQuery({ queryKey: ["files-overview"], queryFn: () => apiGet<Overview>("/files/overview") });
  const list = useQuery({ queryKey: ["files-list", currentPath, search, sort, direction], queryFn: () => apiGet<ListResponse>(listPath), enabled: Boolean(selectedRoot) });
  const tree = useQuery({ queryKey: ["files-tree", domainRootPath], queryFn: () => apiGet<TreeResponse>(`/files/tree?${queryString({ path: domainRootPath, depth: 4 })}`), enabled: Boolean(selectedRoot) });

  useEffect(() => {
    if (selectedDomainId || rootOptions.length === 0) return;
    const firstRoot = rootOptions[0];
    setSelectedDomainId(firstRoot.id);
    setCurrentPath(firstRoot.path);
    setSelectedPath(null);
  }, [rootOptions, selectedDomainId]);

  const invalidateFiles = async () => {
    await queryClient.invalidateQueries({ queryKey: ["files-list"] });
    await queryClient.invalidateQueries({ queryKey: ["files-tree"] });
  };

  useEffect(() => {
    setContextMenu(null);
  }, [currentPath, search, sort, direction]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, []);

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
    mutationFn: (root: FileRootOption) => {
      if (root.id.startsWith("subdomain:")) {
        const [domain, , subdomain] = root.path.split("/");
        return apiPost<DomainScaffoldResponse>("/files/subdomain-scaffold", { domain, subdomain });
      }
      return apiPost<DomainScaffoldResponse>("/files/domain-scaffold", { domain: root.path });
    },
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
      setDeleteTarget(null);
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
    mutationFn: ({ paths, mode }: { paths: string[]; mode: string }) => Promise.all(paths.map((path) => apiPost("/files/chmod", { path, mode }))),
    onSuccess: async () => {
      setLastResult("Permissions updated.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not change permissions")
  });

  const archiveCreate = useMutation({
    mutationFn: ({ sourcePaths, archivePath }: { sourcePaths: string[]; archivePath: string }) => apiPost("/files/archive/create", { sourcePaths, archivePath }),
    onSuccess: async () => {
      setLastResult("Archive created.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create archive")
  });

  const archiveExtract = useMutation({
    mutationFn: ({ archivePath, targetPath }: { archivePath: string; targetPath: string }) => apiPost("/files/archive/extract", { archivePath, targetPath, overwrite: false }),
    onSuccess: async () => {
      setLastResult("Archive extracted.");
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

  async function uploadFile(file: File, overwrite = false) {
    try {
      if (!overwrite && list.data?.items.some((item) => item.name === file.name)) {
        const shouldReplace = window.confirm(`${file.name} already exists in this folder. Replace it?`);
        if (!shouldReplace) return;
        return uploadFile(file, true);
      }

      setUploadProgress({ fileName: file.name, percent: 0, phase: "preparing" });
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      setUploadProgress({ fileName: file.name, percent: 0, phase: "uploading" });
      const payload = JSON.stringify({ parentPath: currentPath, name: file.name, contentBase64: btoa(binary), overwrite });
      await apiUploadWithProgress("/files/upload", payload, "application/json", (percent) => {
        setUploadProgress({
          fileName: file.name,
          percent,
          phase: percent >= 100 ? "processing" : "uploading"
        });
      });
      setUploadProgress({ fileName: file.name, percent: 100, phase: "done" });
      setLastResult("Uploaded.");
      await invalidateFiles();
      window.setTimeout(() => setUploadProgress(null), 700);
    } catch (error) {
      setUploadProgress(null);
      if (!overwrite && error instanceof Error && /exists|already/i.test(error.message)) {
        const shouldReplace = window.confirm(`${file.name} already exists in this folder. Replace it?`);
        if (shouldReplace) return uploadFile(file, true);
      }
      throw error;
    }
  }

  function selectDomain(domainId: string) {
    const root = rootOptions.find((item) => item.id === domainId) ?? null;
    setSelectedDomainId(domainId);
    setCurrentPath(root?.path ?? ".");
    setSelectedPath(null);
    setSelectedPaths(new Set());
    setSearch("");
    setDraftSearch("");
    setLastResult("");
  }

  function setSingleSelection(item: FileEntry) {
    setSelectedPath(item.path);
    setSelectedPaths(new Set([item.path]));
  }

  function toggleSelection(item: FileEntry, checked?: boolean) {
    setSelectedPath(item.path);
    setSelectedPaths((current) => {
      const next = new Set(current);
      const shouldSelect = checked ?? !next.has(item.path);
      if (shouldSelect) next.add(item.path);
      else next.delete(item.path);
      return next;
    });
  }

  function toggleAllVisible(checked: boolean) {
    const items = list.data?.items ?? [];
    if (!checked) {
      setSelectedPaths(new Set());
      setSelectedPath(null);
      return;
    }
    setSelectedPaths(new Set(items.map((item) => item.path)));
    setSelectedPath(items[0]?.path ?? null);
  }

  function openEntry(item: FileEntry) {
    if (item.type === "directory") {
      setCurrentPath(item.path);
      setSelectedPath(null);
      setSelectedPaths(new Set());
    } else if (item.kind === "text") {
      window.location.href = editorHref(item.path);
    }
  }

  function openContextMenu(event: MouseEvent, item: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedPaths.has(item.path)) {
      setSingleSelection(item);
    } else {
      setSelectedPath(item.path);
    }
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 330), item });
  }

  const contextItem = contextMenu?.item ?? null;
  const contextCanEdit = contextItem?.type === "file" && contextItem.kind === "text";
  const selectedCount = selectedPaths.size;

  return (
    <section className="grid h-[calc(100vh-64px)] grid-cols-[300px_minmax(0,1fr)] overflow-hidden p-6 lg:h-screen xl:p-8">
      <aside className="min-h-0 rounded-l-md border border-panel-line bg-white">
        <div className="border-b border-panel-line p-4">
          <div className="truncate text-sm font-semibold">{selectedRoot ? selectedRoot.label : "Web roots"}</div>
          <div className="mt-1 text-xs text-panel-muted">{overview.data ? `${formatBytes(overview.data.textReadLimit)} editor limit` : "Loading..."}</div>
        </div>
        <div className="h-[calc(100%-73px)] overflow-auto p-3">
          {rootOptions.length === 0 && !domains.isLoading ? (
            <div className="rounded-md border border-dashed border-panel-line p-3 text-xs text-panel-muted">No domains or subdomains found.</div>
          ) : null}
          {rootOptions.map((root) => (
            <div className="mb-1" key={root.id}>
              <button
                className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-slate-100 ${selectedDomainId === root.id && currentPath === root.path ? "bg-slate-100 font-semibold" : ""}`}
                onClick={() => selectDomain(root.id)}
                type="button"
              >
                <Folder size={15} />
                <span className="truncate">{root.label}</span>
              </button>
              {selectedDomainId === root.id && tree.data?.children.length ? (
                <div className="ml-4 border-l border-panel-line pl-2">
                  {tree.data.children.map((node) => <TreeNode currentPath={currentPath} key={node.path} node={node} onOpen={setCurrentPath} />)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </aside>

      <main className="min-w-0 min-h-0 rounded-r-md border-y border-r border-panel-line bg-white">
        <div className="space-y-3 border-b border-panel-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 min-w-64 rounded-md border border-panel-line px-2 text-sm"
              onChange={(event) => selectDomain(event.target.value)}
              value={selectedDomainId}
            >
              <option value="" disabled>{domains.isLoading ? "Loading roots..." : "Select web root"}</option>
              {rootOptions.map((root) => (
                <option key={root.id} value={root.id}>{root.label}</option>
              ))}
            </select>
            {selectedRoot ? (
              <span className="text-xs text-panel-muted">Showing {selectedRoot.hint}</span>
            ) : (
              <span className="text-xs text-panel-muted">Choose a domain or subdomain root</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button aria-label="Refresh" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={() => list.refetch()} title="Refresh" type="button"><RefreshCw size={16} /></button>
            <button aria-label="New file" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={() => {
              const name = window.prompt("New file name");
              if (name) createFile.mutate({ name, value: "" });
            }} title="New file" type="button"><FilePlus size={16} /></button>
            <button aria-label="New folder" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={() => {
              const name = window.prompt("New folder name");
              if (name) createFolder.mutate(name);
            }} title="New folder" type="button"><FolderPlus size={16} /></button>
            <label aria-label="Upload" className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" title="Upload">
              <Upload size={16} />
              <input className="hidden" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) uploadFile(file).catch((error) => setLastResult(error instanceof Error ? error.message : "Upload failed"));
                event.target.value = "";
              }} type="file" />
            </label>
            <div className="mx-1 h-6 border-l border-panel-line" />
            <button
              aria-label="Zip selected"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || archiveCreate.isPending}
              onClick={() => {
                const archivePath = window.prompt("Archive path", joinPath(currentPath, "selected.zip"));
                if (archivePath) archiveCreate.mutate({ sourcePaths: [...selectedPaths], archivePath });
              }}
              title={selectedCount > 0 ? `Zip ${selectedCount} selected` : "Zip selected"}
              type="button"
            >
              <Archive size={16} />
            </button>
            <button
              aria-label="Change selected permissions"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || chmodItem.isPending}
              onClick={() => {
                const mode = window.prompt(`Mode for ${selectedCount} selected`, "775");
                if (mode) chmodItem.mutate({ paths: [...selectedPaths], mode });
              }}
              title={selectedCount > 0 ? `Chmod ${selectedCount} selected` : "Chmod selected"}
              type="button"
            >
              <Settings2 size={16} />
            </button>
            <button
              aria-label="Delete selected"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || deleteItems.isPending}
              onClick={() => {
                if (window.confirm(`Delete ${selectedCount} selected item${selectedCount === 1 ? "" : "s"}?`)) deleteItems.mutate([...selectedPaths]);
              }}
              title={selectedCount > 0 ? `Delete ${selectedCount} selected` : "Delete selected"}
              type="button"
            >
              <Trash2 size={16} />
            </button>
            {selectedCount > 0 ? <span className="rounded-md bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">{selectedCount} selected</span> : null}
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
            {list.data?.breadcrumbs.filter((crumb) => !selectedRoot || crumb.path !== ".").map((crumb) => (
              <button className="h-8 rounded-md px-2 text-xs text-panel-muted hover:bg-slate-100" key={crumb.path} onClick={() => setCurrentPath(crumb.path)} type="button">
                {crumb.name}
              </button>
            ))}
          </div>
        </div>

        {lastResult ? <div className="border-b border-panel-line bg-slate-50 px-4 py-2 text-sm text-slate-700">{lastResult}</div> : null}
        {list.isError && selectedRoot ? (
          <div className="border-b border-panel-line bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <div className="font-medium">No default folders exist for {selectedRoot.label} yet.</div>
            <button
              className="mt-2 h-8 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold hover:bg-amber-100 disabled:opacity-60"
              disabled={createDomainFolder.isPending}
              onClick={() => createDomainFolder.mutate(selectedRoot)}
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

        <div className="h-[calc(100%-122px)] overflow-auto" onContextMenu={(event) => event.preventDefault()}>
          <table className="w-full min-w-[980px] table-fixed text-sm">
            <colgroup>
              <col style={{ width: "56px" }} />
              <col />
              <col style={{ width: "130px" }} />
              <col style={{ width: "110px" }} />
              <col style={{ width: "230px" }} />
            </colgroup>
            <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-panel-muted">
              <tr>
                <th className="px-4 py-3">
                  <input
                    aria-label="Select all files"
                    checked={Boolean(list.data?.items.length) && selectedPaths.size === list.data?.items.length}
                    className="h-4 w-4 rounded border-panel-line"
                    onChange={(event) => toggleAllVisible(event.target.checked)}
                    type="checkbox"
                  />
                </th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Size</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3">Modified</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((item) => (
                <tr
                  className={`cursor-pointer border-t border-panel-line hover:bg-slate-50 ${selectedPaths.has(item.path) ? "bg-emerald-50/60" : selectedPath === item.path ? "bg-slate-50" : ""}`}
                  key={item.path}
                  onClick={() => {
                    setSingleSelection(item);
                  }}
                  onContextMenu={(event) => openContextMenu(event, item)}
                  onDoubleClick={() => openEntry(item)}
                >
                  <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                    <input
                      aria-label={`Select ${item.name}`}
                      checked={selectedPaths.has(item.path)}
                      className="h-4 w-4 rounded border-panel-line"
                      onChange={(event) => toggleSelection(item, event.target.checked)}
                      type="checkbox"
                    />
                  </td>
                  <td className="min-w-0 overflow-hidden px-4 py-3">
                    <div className="flex w-full min-w-0 items-center gap-2">
                      {item.type === "directory" ? <Folder className="shrink-0" size={16} /> : item.kind === "image" ? <ImageIcon className="shrink-0" size={16} /> : <FileCode2 className="shrink-0" size={16} />}
                      <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium leading-5" title={item.name}>{item.name}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-panel-muted">{item.type === "directory" ? "-" : formatBytes(item.size)}</td>
                  <td className="px-4 py-3 font-mono text-xs">{item.permissions}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-panel-muted">{new Date(item.modifiedAt).toLocaleString()}</td>
                </tr>
              ))}
              {list.data?.items.length === 0 ? (
                <tr>
                  <td className="px-4 py-12 text-center text-panel-muted" colSpan={5}>No files found</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </main>

      {contextItem ? (
        <div
          className="fixed z-50 w-56 overflow-hidden rounded-md border border-panel-line bg-white py-1 text-sm shadow-xl"
          onClick={(event) => event.stopPropagation()}
          style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
        >
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { setInfoTarget(contextItem); setContextMenu(null); }} type="button">
            <Info size={15} /> Info
          </button>
          {contextItem.type === "directory" ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { openEntry(contextItem); setContextMenu(null); }} type="button">
              <Folder size={15} /> Open
            </button>
          ) : null}
          {contextCanEdit ? (
            <Link className="flex h-9 w-full items-center gap-2 px-3 hover:bg-slate-50" href={editorHref(contextItem.path)} onClick={() => setContextMenu(null)}>
              <Edit3 size={15} /> Edit
            </Link>
          ) : null}
          {contextItem.type === "file" ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { download(contextItem.path).catch((error) => setLastResult(error instanceof Error ? error.message : "Download failed")); setContextMenu(null); }} type="button">
              <Download size={15} /> Download
            </button>
          ) : null}
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { navigator.clipboard.writeText(contextItem.path).then(() => setLastResult("Path copied.")); setContextMenu(null); }} type="button">
            <Copy size={15} /> Copy Path
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => {
            const name = window.prompt("Rename to", contextItem.name);
            if (name && name !== contextItem.name) renameItem.mutate({ path: contextItem.path, name });
            setContextMenu(null);
          }} type="button">
            <Settings2 size={15} /> Rename
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => {
            const name = window.prompt("Copy name", `copy-${contextItem.name}`);
            if (name) copyItem.mutate({ sourcePath: contextItem.path, name });
            setContextMenu(null);
          }} type="button">
            <Copy size={15} /> Copy Here
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => {
            const name = window.prompt("Move/rename to", contextItem.name);
            if (name) moveItem.mutate({ sourcePath: contextItem.path, name });
            setContextMenu(null);
          }} type="button">
            <Settings2 size={15} /> Move Here
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => {
            const mode = window.prompt("Mode", contextItem.permissions);
            if (mode) chmodItem.mutate({ paths: [contextItem.path], mode });
            setContextMenu(null);
          }} type="button">
            <Settings2 size={15} /> Chmod
          </button>
          {contextItem.type === "file" ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { checksum(contextItem.path).catch((error) => setLastResult(error instanceof Error ? error.message : "Checksum failed")); setContextMenu(null); }} type="button">
              <Settings2 size={15} /> SHA256
            </button>
          ) : null}
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => {
            const archivePath = window.prompt("Archive path", joinPath(parentPath(contextItem.path), `${contextItem.name}.zip`));
            if (archivePath) archiveCreate.mutate({ sourcePaths: [contextItem.path], archivePath });
            setContextMenu(null);
          }} type="button">
            <Archive size={15} /> Zip
          </button>
          {contextItem.extension === ".zip" ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { archiveExtract.mutate({ archivePath: contextItem.path, targetPath: parentPath(contextItem.path) }); setContextMenu(null); }} type="button">
              <Archive size={15} /> Extract
            </button>
          ) : null}
          <div className="my-1 border-t border-panel-line" />
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left text-panel-danger hover:bg-red-50" onClick={() => {
            if (selectedPaths.size > 1) {
              if (window.confirm(`Delete ${selectedPaths.size} selected items?`)) deleteItems.mutate([...selectedPaths]);
            } else {
              setDeleteTarget(contextItem);
            }
            setContextMenu(null);
          }} type="button">
            <Trash2 size={15} /> Delete{selectedPaths.size > 1 ? ` ${selectedPaths.size} selected` : ""}
          </button>
        </div>
      ) : null}
      {infoTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => setInfoTarget(null)}>
          <div className="w-full max-w-2xl rounded-md bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="border-b border-panel-line p-5">
              <div className="text-lg font-semibold text-panel-text">{infoTarget.name}</div>
              <div className="mt-1 break-all text-sm text-panel-muted">{infoTarget.path}</div>
            </div>
            <div className="grid gap-3 p-5 text-sm sm:grid-cols-2">
              {[
                ["Type", infoTarget.type],
                ["Kind", infoTarget.kind],
                ["Extension", infoTarget.extension || "-"],
                ["Size", infoTarget.type === "directory" ? "-" : formatBytes(infoTarget.size)],
                ["Mode", infoTarget.permissions],
                ["MIME", infoTarget.mime ?? "-"],
                ["Hidden", infoTarget.isHidden ? "Yes" : "No"],
                ["Readonly", infoTarget.isReadonly ? "Yes" : "No"],
                ["Created", new Date(infoTarget.createdAt).toLocaleString()],
                ["Modified", new Date(infoTarget.modifiedAt).toLocaleString()]
              ].map(([label, value]) => (
                <div className="rounded-md bg-slate-50 p-3" key={label}>
                  <div className="text-xs font-medium uppercase text-panel-muted">{label}</div>
                  <div className="mt-1 break-all font-semibold text-panel-text">{value}</div>
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t border-panel-line p-4">
              <button className="h-9 rounded-md border border-panel-line px-4 text-sm font-medium hover:bg-slate-50" onClick={() => setInfoTarget(null)} type="button">Close</button>
            </div>
          </div>
        </div>
      ) : null}
      {uploadProgress ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-md bg-white p-6 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 animate-spin rounded-full border-2 border-panel-line border-t-panel-accent" />
              <div className="min-w-0">
                <div className="font-semibold text-panel-text">
                  {uploadProgress.phase === "done" ? "Upload complete" : uploadProgress.phase === "processing" ? "Finishing upload" : uploadProgress.phase === "preparing" ? "Preparing upload" : "Uploading file"}
                </div>
                <div className="mt-1 truncate text-sm text-panel-muted">{uploadProgress.fileName}</div>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-between text-sm">
              <span className="capitalize text-panel-muted">{uploadProgress.phase}</span>
              <span className="font-semibold text-panel-text">{uploadProgress.percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-panel-accent transition-all" style={{ width: `${uploadProgress.percent}%` }} />
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmModal
        confirmLabel="Delete item"
        message={`This will permanently delete ${deleteTarget?.name ?? "the selected item"} from the file manager.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget ? deleteItems.mutate([deleteTarget.path]) : undefined}
        open={Boolean(deleteTarget)}
        pending={deleteItems.isPending}
        title="Delete file item?"
      />
    </section>
  );
}
