"use client";

import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowRightLeft,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FileCode2,
  FilePlus,
  Folder,
  FolderPlus,
  Github,
  Image as ImageIcon,
  Info,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { apiDeleteBody, apiGet, apiPatch, apiPost, apiUploadWithProgress } from "@/lib/api";
import { uploadFileViaWebSocket } from "@/lib/fileUploadWs";
import { ConfirmModal } from "@/components/confirm-modal";
import { InputModal } from "@/components/input-modal";
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
  uploadChunkLimit: number;
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

type GitStatusResponse = {
  ok: true;
  path: string;
  isRepo: boolean;
};

type GitPullResponse = {
  ok: true;
  path: string;
  stdout?: string;
  stderr?: string;
  returncode: number;
};

type GithubRepo = {
  id?: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  url?: string;
  updatedAt?: string;
};

type GithubRepoResponse = {
  connected: boolean;
  dryRun?: boolean;
  note?: string;
  items: GithubRepo[];
};

type UploadProgress = {
  fileName: string;
  percent: number;
  phase: "uploading" | "processing" | "done";
  uploadedBytes: number;
  totalBytes: number;
};

type ExtractProgress = {
  fileName: string;
  percent: number;
  phase: "queued" | "extracting" | "refreshing" | "done";
  current: number;
  total: number;
};

type FileRootOption = {
  id: string;
  label: string;
  path: string;
  hint: string;
};

type PromptRequest = {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
};

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: "danger" | "warn";
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value < 1024 * 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${(value / 1024 / 1024 / 1024 / 1024).toFixed(1)} TB`;
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

function editorHref(filePath: string, editorBase: string) {
  return `${editorBase}?${queryString({ path: filePath })}`;
}

function isZipEntry(item: Pick<FileEntry, "extension" | "name" | "type">) {
  return item.type === "file" && (item.extension.toLowerCase() === ".zip" || item.name.toLowerCase().endsWith(".zip"));
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

export function FileManagerClient({
  apiBase = "/files",
  domainsApiBase = "/domains",
  githubReposApiBase = "/deployments/github/repos",
  editorBase = "/files/editor",
  rootHintPrefix = "/var/www",
  enableGithubPull = true,
  fixedRoot,
  embedded = false
}: {
  apiBase?: "/files" | "/account/files";
  domainsApiBase?: "/domains" | "/account/domains";
  githubReposApiBase?: string;
  editorBase?: string | null;
  rootHintPrefix?: string;
  enableGithubPull?: boolean;
  fixedRoot?: FileRootOption;
  embedded?: boolean;
} = {}) {
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
  const [deleteRequest, setDeleteRequest] = useState<{ paths: string[]; permanent: boolean } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadDragActive, setUploadDragActive] = useState(false);
  const [extractProgress, setExtractProgress] = useState<ExtractProgress | null>(null);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [autoPullEnabled, setAutoPullEnabled] = useState(false);
  const [autoPullBusy, setAutoPullBusy] = useState(false);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const promptResolverRef = useRef<((value: string | null) => void) | null>(null);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const autoPullTimerRef = useRef<number | null>(null);
  const currentInTrash = currentPath === ".trash" || currentPath.startsWith(".trash/");

  const domains = useQuery({
    queryKey: ["domains", domainsApiBase, "file-manager"],
    queryFn: () => apiGet<DomainListResponse>(`${domainsApiBase}?page=1&pageSize=100`),
    enabled: !fixedRoot
  });
  const rootOptions = useMemo<FileRootOption[]>(() => {
    if (fixedRoot) return [fixedRoot];
    const items = domains.data?.items ?? [];
    const roots = items.flatMap((domain) => [
      { id: `domain:${domain.id}`, label: domain.name, path: domain.name, hint: `${rootHintPrefix}/${domain.name}` },
      ...(domain.subdomains ?? []).map((subdomain) => ({
        id: `subdomain:${subdomain.id}`,
        label: `${subdomain.name}.${domain.name}`,
        path: `${domain.name}/subdomains/${subdomain.name}`,
        hint: `${rootHintPrefix}/${domain.name}/subdomains/${subdomain.name}`
      }))
    ]);
    roots.push({ id: "trash:global", label: "Trash", path: ".trash", hint: `${rootHintPrefix}/.trash` });
    return roots;
  }, [domains.data?.items, fixedRoot]);
  const selectedRoot = rootOptions.find((item) => item.id === selectedDomainId) ?? null;
  const domainRootPath = selectedRoot?.path ?? ".";

  const listPath = `${apiBase}/list?${queryString({ path: currentPath, search, sort, direction, page: 1, pageSize: 200 })}`;

  const overview = useQuery({ queryKey: ["files-overview", apiBase], queryFn: () => apiGet<Overview>(`${apiBase}/overview`) });
  const list = useQuery({ queryKey: ["files-list", apiBase, currentPath, search, sort, direction], queryFn: () => apiGet<ListResponse>(listPath), enabled: Boolean(selectedRoot) });
  const tree = useQuery({ queryKey: ["files-tree", apiBase, domainRootPath], queryFn: () => apiGet<TreeResponse>(`${apiBase}/tree?${queryString({ path: domainRootPath, depth: 4 })}`), enabled: Boolean(selectedRoot) });
  const gitStatus = useQuery({
    queryKey: ["files-git-status", apiBase, currentPath],
    queryFn: () => apiPost<GitStatusResponse>(`${apiBase}/git/status`, { path: currentPath }),
    enabled: Boolean(enableGithubPull && selectedRoot && !currentInTrash),
    retry: false
  });
  const githubRepos = useQuery({
    queryKey: ["files-github-repos", repoSearch],
    queryFn: () => apiGet<GithubRepoResponse>(`${githubReposApiBase}?${queryString({ search: repoSearch })}`),
    enabled: enableGithubPull && repoPickerOpen,
    retry: false
  });

  useEffect(() => {
    if (selectedDomainId || rootOptions.length === 0) return;
    const firstRoot = rootOptions[0];
    setSelectedDomainId(firstRoot.id);
    setCurrentPath(firstRoot.path);
    setSelectedPath(null);
  }, [rootOptions, selectedDomainId]);

  useEffect(() => {
    if (!fixedRoot) return;
    setSelectedDomainId(fixedRoot.id);
    setCurrentPath(fixedRoot.path);
    setSelectedPath(null);
    setSelectedPaths(new Set());
  }, [fixedRoot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem("file-manager:auto-pull");
      setAutoPullEnabled(stored === "on");
    } catch {
      setAutoPullEnabled(false);
    }
  }, []);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("file-manager:auto-pull", autoPullEnabled ? "on" : "off");
    } catch {
      // ignore storage failures
    }
  }, [autoPullEnabled]);

  const createFile = useMutation({
    mutationFn: ({ name, value }: { name: string; value: string }) => apiPost<FileEntry>(`${apiBase}/files`, { parentPath: currentPath, name, content: value }),
    onSuccess: async (file) => {
      setSelectedPath(file.path);
      setLastResult("File created.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create file")
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiPost<FileEntry>(`${apiBase}/folders`, { parentPath: currentPath, name }),
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
        return apiPost<DomainScaffoldResponse>(`${apiBase}/subdomain-scaffold`, { domain, subdomain });
      }
      return apiPost<DomainScaffoldResponse>(`${apiBase}/domain-scaffold`, { domain: root.path });
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
    mutationFn: ({ path, name }: { path: string; name: string }) => apiPatch<{ ok: true; file: FileEntry }>(`${apiBase}/rename`, { path, name }),
    onSuccess: async (response) => {
      setSelectedPath(response.file.path);
      setLastResult("Renamed.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not rename")
  });

  const deleteItems = useMutation({
    mutationFn: ({ paths, permanent }: { paths: string[]; permanent: boolean }) =>
      apiDeleteBody<{ ok: true; movedToTrash: string[]; permanentlyRemoved: string[] }>(`${apiBase}/delete`, { paths, permanent }),
    onSuccess: async (result) => {
      setSelectedPath(null);
      setDeleteRequest(null);
      if (result.permanentlyRemoved.length > 0 && result.movedToTrash.length === 0) setLastResult("Permanently deleted.");
      else if (result.movedToTrash.length > 0 && result.permanentlyRemoved.length === 0) setLastResult("Moved to trash.");
      else setLastResult("Moved to trash and permanently deleted selected trash items.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not delete")
  });

  function openDeleteConfirm(paths: string[]) {
    if (paths.length === 0) return;
    setDeleteRequest({ paths, permanent: currentInTrash });
  }

  const copyItem = useMutation({
    mutationFn: ({ sourcePath, name }: { sourcePath: string; name: string }) => apiPost(`${apiBase}/copy`, { sourcePath, targetParentPath: currentPath, name, overwrite: false }),
    onSuccess: async () => {
      setLastResult("Copied.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not copy")
  });

  const moveItem = useMutation({
    mutationFn: ({ sourcePath, name }: { sourcePath: string; name: string }) => apiPost(`${apiBase}/move`, { sourcePath, targetParentPath: currentPath, name, overwrite: false }),
    onSuccess: async () => {
      setLastResult("Moved.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not move")
  });

  const copySelected = useMutation({
    mutationFn: async ({ sourcePaths, targetPath }: { sourcePaths: string[]; targetPath: string }) => {
      const results = [];
      for (const sourcePath of sourcePaths) {
        results.push(await apiPost(`${apiBase}/copy`, { sourcePath, targetParentPath: targetPath, overwrite: false }));
      }
      return results;
    },
    onSuccess: async () => {
      setLastResult("Selected items copied.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not copy selected items")
  });

  const moveSelected = useMutation({
    mutationFn: async ({ sourcePaths, targetPath }: { sourcePaths: string[]; targetPath: string }) => {
      const results = [];
      for (const sourcePath of sourcePaths) {
        results.push(await apiPost(`${apiBase}/move`, { sourcePath, targetParentPath: targetPath, overwrite: false }));
      }
      return results;
    },
    onSuccess: async () => {
      setSelectedPaths(new Set());
      setSelectedPath(null);
      setLastResult("Selected items moved.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not move selected items")
  });

  const chmodItem = useMutation({
    mutationFn: ({ paths, mode }: { paths: string[]; mode: string }) => Promise.all(paths.map((path) => apiPost(`${apiBase}/chmod`, { path, mode }))),
    onSuccess: async () => {
      setLastResult("Permissions updated.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not change permissions")
  });

  const archiveCreate = useMutation({
    mutationFn: ({ sourcePaths, archivePath }: { sourcePaths: string[]; archivePath: string }) => apiPost(`${apiBase}/archive/create`, { sourcePaths, archivePath }),
    onSuccess: async () => {
      setLastResult("Archive created.");
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not create archive")
  });

  const archiveExtract = useMutation({
    mutationFn: async ({ archivePaths, targetPath }: { archivePaths: string[]; targetPath: string }) => {
      const total = archivePaths.length;
      const results = [];
      for (const [index, archivePath] of archivePaths.entries()) {
        const fileName = archivePath.split("/").pop() ?? archivePath;
        const basePercent = Math.round((index / total) * 90);
        const maxBeforeDone = Math.round(((index + 0.92) / total) * 90);
        setExtractProgress({ fileName, percent: Math.max(1, basePercent), phase: "extracting", current: index + 1, total });
        const timer = window.setInterval(() => {
          setExtractProgress((progress) => {
            if (!progress || progress.fileName !== fileName || progress.phase !== "extracting") return progress;
            return { ...progress, percent: Math.min(maxBeforeDone, progress.percent + 2) };
          });
        }, 700);
        try {
          results.push(await apiPost(`${apiBase}/archive/extract`, { archivePath, targetPath, overwrite: false }));
        } finally {
          window.clearInterval(timer);
        }
        setExtractProgress({ fileName, percent: Math.round(((index + 1) / total) * 90), phase: "extracting", current: index + 1, total });
      }
      setExtractProgress({ fileName: total === 1 ? (archivePaths[0]?.split("/").pop() ?? "Archive") : `${total} archives`, percent: 95, phase: "refreshing", current: total, total });
      return results;
    },
    onSuccess: async () => {
      setExtractProgress((progress) => progress ? { ...progress, percent: 95, phase: "refreshing" } : progress);
      setLastResult("Archive extracted.");
      await invalidateFiles();
      setExtractProgress((progress) => progress ? { ...progress, percent: 100, phase: "done" } : progress);
      window.setTimeout(() => setExtractProgress(null), 900);
    },
    onError: (err) => {
      setExtractProgress(null);
      setLastResult(err instanceof Error ? err.message : "Could not extract archive");
    }
  });

  const gitPull = useMutation({
    mutationFn: () => apiPost<GitPullResponse>(`${apiBase}/git/pull`, { path: currentPath }),
    onSuccess: async (response) => {
      const gitOutput = response.stdout?.trim() || response.stderr?.trim() || "Already up to date.";
      setLastResult(`Git pull done: ${gitOutput.slice(0, 200)}`);
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Git pull failed")
  });

  const githubPull = useMutation({
    mutationFn: (repo: GithubRepo) => apiPost<{ ok: true; path: string; owner: string; repo: string; branch: string }>(`${apiBase}/git/github/pull`, {
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch || "main",
      targetParentPath: currentPath
    }),
    onSuccess: async (response) => {
      setLastResult(`Pulled ${response.owner}/${response.repo} into ${response.path}`);
      setRepoPickerOpen(false);
      await invalidateFiles();
    },
    onError: (err) => setLastResult(err instanceof Error ? err.message : "Could not pull GitHub project")
  });

  useEffect(() => {
    if (autoPullTimerRef.current) {
      window.clearInterval(autoPullTimerRef.current);
      autoPullTimerRef.current = null;
    }
    if (!autoPullEnabled || !gitStatus.data?.isRepo || gitPull.isPending) return;
    autoPullTimerRef.current = window.setInterval(async () => {
      if (autoPullBusy) return;
      setAutoPullBusy(true);
      try {
        await gitPull.mutateAsync();
      } catch {
        // handled by mutation
      } finally {
        setAutoPullBusy(false);
      }
    }, 60000);
    return () => {
      if (autoPullTimerRef.current) {
        window.clearInterval(autoPullTimerRef.current);
        autoPullTimerRef.current = null;
      }
    };
  }, [autoPullEnabled, gitStatus.data?.isRepo, gitPull.isPending, gitPull.mutateAsync, autoPullBusy]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(draftSearch.trim());
  }

  async function requestInput(options: PromptRequest) {
    return await new Promise<string | null>((resolve) => {
      promptResolverRef.current = resolve;
      setPromptRequest(options);
    });
  }

  function resolveInput(value: string | null) {
    const resolver = promptResolverRef.current;
    promptResolverRef.current = null;
    setPromptRequest(null);
    resolver?.(value);
  }

  async function requestConfirm(options: ConfirmRequest) {
    return await new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmRequest(options);
    });
  }

  function resolveConfirm(value: boolean) {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmRequest(null);
    resolver?.(value);
  }

  async function download(pathValue: string) {
    const response = await apiGet<DownloadResponse>(`${apiBase}/download?${queryString({ path: pathValue })}`);
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
    const response = await apiGet<{ hash: string }>(`${apiBase}/checksum?${queryString({ path: pathValue })}`);
    await navigator.clipboard.writeText(response.hash);
    setLastResult(`SHA256 copied: ${response.hash}`);
  }

  async function uploadFile(file: File, overwrite = false) {
    try {
      if (!overwrite && list.data?.items.some((item) => item.name === file.name)) {
        const shouldReplace = await requestConfirm({
          title: "Replace existing file?",
          message: `${file.name} already exists in this folder. Do you want to replace it?`,
          confirmLabel: "Replace",
          tone: "warn"
        });
        if (!shouldReplace) return;
        return uploadFile(file, true);
      }

      const uploadLimit = overview.data?.uploadLimit;
      if (uploadLimit && file.size > uploadLimit) {
        throw new Error(`Upload is too large. Limit: ${formatBytes(uploadLimit)}.`);
      }

      const uploadId = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setUploadProgress({ fileName: file.name, percent: 0, phase: "uploading", uploadedBytes: 0, totalBytes: file.size });

      try {
        await uploadFileViaWebSocket({
          apiBase,
          parentPath: currentPath,
          name: file.name,
          file,
          uploadId,
          overwrite,
          onProgress: (uploaded, total) => {
            const percent = total > 0 ? Math.min(99, Math.floor((uploaded / total) * 100)) : 99;
            setUploadProgress({
              fileName: file.name,
              percent,
              phase: uploaded >= total ? "processing" : "uploading",
              uploadedBytes: uploaded,
              totalBytes: total
            });
          }
        });
      } catch (wsError) {
        const configuredChunkSize = overview.data?.uploadChunkLimit ?? 16 * 1024 * 1024;
        const chunkSize = Math.min(16 * 1024 * 1024, Math.max(1024 * 1024, configuredChunkSize));
        const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
        for (let index = 0; index < totalChunks; index += 1) {
          const offset = index * chunkSize;
          const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
          let lastError: Error | null = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              await apiUploadWithProgress(
                `${apiBase}/upload/chunk?${queryString({
                  parentPath: currentPath,
                  name: file.name,
                  uploadId,
                  index,
                  totalChunks,
                  offset,
                  totalSize: file.size,
                  overwrite: overwrite ? "true" : "false"
                })}`,
                chunk,
                "application/vnd.vps-panel.file-upload",
                (_percent, loaded) => {
                  const uploaded = Math.min(file.size, offset + loaded);
                  const percent = file.size > 0 ? Math.min(99, Math.floor((uploaded / file.size) * 100)) : 99;
                  setUploadProgress({
                    fileName: file.name,
                    percent,
                    phase: index === totalChunks - 1 && percent >= 99 ? "processing" : "uploading",
                    uploadedBytes: uploaded,
                    totalBytes: file.size
                  });
                }
              );
              lastError = null;
              break;
            } catch (error) {
              lastError = error instanceof Error ? error : new Error("Upload chunk failed");
              if (attempt < 3) {
                await new Promise((resolve) => window.setTimeout(resolve, attempt * 1500));
              }
            }
          }
          if (lastError) {
            const hint = wsError instanceof Error ? wsError.message : "WebSocket upload failed";
            throw new Error(lastError.message || hint);
          }
        }
      }

      setUploadProgress({ fileName: file.name, percent: 100, phase: "done", uploadedBytes: file.size, totalBytes: file.size });
      setLastResult("Uploaded.");
      await invalidateFiles();
      window.setTimeout(() => {
        setUploadProgress(null);
        setUploadDialogOpen(false);
      }, 700);
    } catch (error) {
      setUploadProgress(null);
      if (!overwrite && error instanceof Error && /exists|already/i.test(error.message)) {
        const shouldReplace = await requestConfirm({
          title: "Replace existing file?",
          message: `${file.name} already exists in this folder. Do you want to replace it?`,
          confirmLabel: "Replace",
          tone: "warn"
        });
        if (shouldReplace) return uploadFile(file, true);
      }
      throw error;
    }
  }

  function startUpload(file: File | null | undefined) {
    if (!file) return;
    setUploadDialogOpen(true);
    uploadFile(file).catch((error) => setLastResult(error instanceof Error ? error.message : "Upload failed"));
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

  function pathWithinFixedRoot(pathValue: string) {
    if (!fixedRoot) return true;
    const root = fixedRoot.path.replace(/\/+$/, "");
    const target = pathValue.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
    return target === root || target.startsWith(`${root}/`);
  }

  function guardFixedRootPath(pathValue: string) {
    if (pathWithinFixedRoot(pathValue)) return true;
    setLastResult("This project file manager is locked to the selected project storage.");
    return false;
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
    } else if (item.kind === "text" && editorBase) {
      window.location.href = editorHref(item.path, editorBase);
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
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 260),
      y: Math.min(event.clientY, window.innerHeight - 520),
      item
    });
  }

  const contextItem = contextMenu?.item ?? null;
  const contextCanEdit = contextItem?.type === "file" && contextItem.kind === "text";
  const contextIsZip = contextItem ? isZipEntry(contextItem) : false;
  const selectedCount = selectedPaths.size;
  const selectedZipPaths = useMemo(() => (list.data?.items ?? []).filter((item) => selectedPaths.has(item.path) && isZipEntry(item)).map((item) => item.path), [list.data?.items, selectedPaths]);

  return (
    <section className={`grid overflow-hidden ${embedded ? "h-[720px] grid-cols-[260px_minmax(0,1fr)] p-0" : "h-[calc(100vh-64px)] grid-cols-[300px_minmax(0,1fr)] p-6 lg:h-screen xl:p-8"}`}>
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

      <main className="min-w-0 min-h-0 rounded-r-md border-y border-r border-panel-line bg-white flex flex-col">
        <div className="space-y-3 border-b border-panel-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            {!fixedRoot ? (
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
            ) : null}
            {selectedRoot ? (
              <span className="text-xs text-panel-muted">Showing {selectedRoot.hint}</span>
            ) : (
              <span className="text-xs text-panel-muted">Choose a domain or subdomain root</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button aria-label="Refresh" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={() => list.refetch()} title="Refresh" type="button"><RefreshCw size={16} /></button>
            <button
              aria-label="Git pull"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!enableGithubPull || !gitStatus.data?.isRepo || gitPull.isPending}
              onClick={() => gitPull.mutate()}
              title={gitStatus.data?.isRepo ? "Pull latest changes from git remote" : "Current folder is not a git repository"}
              type="button"
            >
              <RefreshCw size={16} />
            </button>
            <button
              aria-label="Pull from GitHub projects"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!enableGithubPull || currentInTrash}
              onClick={() => setRepoPickerOpen(true)}
              title="Choose project from GitHub and pull into this folder"
              type="button"
            >
              <Github size={16} />
            </button>
            <button
              aria-label="Toggle auto pull"
              className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm ${autoPullEnabled ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-panel-line hover:bg-slate-50"} disabled:cursor-not-allowed disabled:opacity-40`}
              disabled={!enableGithubPull || !gitStatus.data?.isRepo}
              onClick={() => setAutoPullEnabled((current) => !current)}
              title={gitStatus.data?.isRepo ? `Auto pull ${autoPullEnabled ? "ON" : "OFF"} (every 1 minute)` : "Current folder is not a git repository"}
              type="button"
            >
              <RefreshCw size={16} className={autoPullEnabled ? "" : "opacity-60"} />
            </button>
            <button aria-label="New file" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={async () => {
              const name = (await requestInput({ title: "Create New File", label: "File name", placeholder: "index.html", confirmLabel: "Create" }))?.trim();
              if (name) createFile.mutate({ name, value: "" });
            }} title="New file" type="button"><FilePlus size={16} /></button>
            <button aria-label="New folder" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={async () => {
              const name = (await requestInput({ title: "Create New Folder", label: "Folder name", placeholder: "assets", confirmLabel: "Create" }))?.trim();
              if (name) createFolder.mutate(name);
            }} title="New folder" type="button"><FolderPlus size={16} /></button>
            <button aria-label="Upload" className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50" onClick={() => setUploadDialogOpen(true)} title="Upload" type="button">
              <Upload size={16} />
            </button>
            <div className="mx-1 h-6 border-l border-panel-line" />
            <button
              aria-label="Copy selected items"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || copySelected.isPending}
              onClick={async () => {
                const targetPath = (await requestInput({
                  title: "Copy Selected Items",
                  label: "Target folder path",
                  defaultValue: currentPath,
                  confirmLabel: "Copy"
                }))?.trim();
                if (!targetPath) return;
                if (!guardFixedRootPath(targetPath)) return;
                copySelected.mutate({ sourcePaths: [...selectedPaths], targetPath });
              }}
              title={selectedCount > 0 ? `Copy ${selectedCount} selected` : "Copy selected"}
              type="button"
            >
              <Copy size={16} />
            </button>
            <button
              aria-label="Move selected items"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || moveSelected.isPending}
              onClick={async () => {
                const targetPath = (await requestInput({
                  title: "Move Selected Items",
                  label: "Target folder path",
                  defaultValue: currentPath,
                  confirmLabel: "Move"
                }))?.trim();
                if (!targetPath) return;
                if (!guardFixedRootPath(targetPath)) return;
                moveSelected.mutate({ sourcePaths: [...selectedPaths], targetPath });
              }}
              title={selectedCount > 0 ? `Move ${selectedCount} selected` : "Move selected"}
              type="button"
            >
              <ArrowRightLeft size={16} />
            </button>
            <button
              aria-label="Zip selected"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || archiveCreate.isPending}
              onClick={async () => {
                const archivePath = (await requestInput({
                  title: "Create Zip Archive",
                  label: "Archive path",
                  defaultValue: joinPath(currentPath, "selected.zip"),
                  confirmLabel: "Create"
                }))?.trim();
                if (archivePath && guardFixedRootPath(archivePath)) archiveCreate.mutate({ sourcePaths: [...selectedPaths], archivePath });
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
              onClick={async () => {
                const mode = (await requestInput({
                  title: "Change Permissions",
                  label: `Mode for ${selectedCount} selected`,
                  defaultValue: "775",
                  confirmLabel: "Apply"
                }))?.trim();
                if (mode) chmodItem.mutate({ paths: [...selectedPaths], mode });
              }}
              title={selectedCount > 0 ? `Chmod ${selectedCount} selected` : "Chmod selected"}
              type="button"
            >
              <Settings2 size={16} />
            </button>
            <button
              aria-label={currentInTrash ? "Delete selected permanently" : "Move selected to trash"}
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-panel-danger hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedCount === 0 || deleteItems.isPending}
              onClick={async () => {
                openDeleteConfirm([...selectedPaths]);
              }}
              title={selectedCount > 0
                ? `${currentInTrash ? "Permanently delete" : "Move to trash"} ${selectedCount} selected`
                : currentInTrash ? "Delete selected permanently" : "Move selected to trash"}
              type="button"
            >
              <Trash2 size={16} />
            </button>
            <button
              aria-label="Extract selected zip files"
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedZipPaths.length === 0 || archiveExtract.isPending}
              onClick={() => archiveExtract.mutate({ archivePaths: selectedZipPaths, targetPath: currentPath })}
              title={selectedZipPaths.length > 0 ? `Extract ${selectedZipPaths.length} selected zip file${selectedZipPaths.length === 1 ? "" : "s"}` : "Extract selected zip files"}
              type="button"
            >
              <Archive size={16} />
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
        {!currentInTrash ? (
          <div className="border-b border-panel-line bg-slate-50 px-4 py-2 text-xs text-slate-600">
            {gitStatus.isLoading
              ? "Checking git repository..."
              : gitStatus.data?.isRepo
                ? `Git repository detected. Auto pull is ${autoPullEnabled ? "enabled" : "disabled"}.`
                : "Current folder is not a git repository."}
          </div>
        ) : null}
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

        <div className="min-h-0 flex-1 overflow-auto" onContextMenu={(event) => event.preventDefault()}>
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
          className="fixed z-50 max-h-[calc(100vh-24px)] w-56 overflow-y-auto rounded-md border border-panel-line bg-white py-1 text-sm shadow-xl"
          onClick={(event) => event.stopPropagation()}
          style={{ left: Math.max(12, contextMenu?.x ?? 0), top: Math.max(12, contextMenu?.y ?? 0) }}
        >
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { setInfoTarget(contextItem); setContextMenu(null); }} type="button">
            <Info size={15} /> Info
          </button>
          {contextItem.type === "directory" ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { openEntry(contextItem); setContextMenu(null); }} type="button">
              <Folder size={15} /> Open
            </button>
          ) : null}
          {contextCanEdit && editorBase ? (
            <Link className="flex h-9 w-full items-center gap-2 px-3 hover:bg-slate-50" href={editorHref(contextItem.path, editorBase)} onClick={() => setContextMenu(null)}>
              <Edit3 size={15} /> Edit
            </Link>
          ) : null}
          {contextItem.type === "file" ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { download(contextItem.path).catch((error) => setLastResult(error instanceof Error ? error.message : "Download failed")); setContextMenu(null); }} type="button">
              <Download size={15} /> Download
            </button>
          ) : null}
          {contextIsZip ? (
            <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { archiveExtract.mutate({ archivePaths: [contextItem.path], targetPath: parentPath(contextItem.path) }); setContextMenu(null); }} type="button">
              <Archive size={15} /> Extract
            </button>
          ) : null}
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left text-panel-danger hover:bg-red-50" onClick={() => {
            if (selectedPaths.size > 1) {
              openDeleteConfirm([...selectedPaths]);
            } else {
              openDeleteConfirm([contextItem.path]);
            }
            setContextMenu(null);
          }} type="button">
            <Trash2 size={15} /> {currentInTrash ? "Delete Permanently" : "Move to Trash"}{selectedPaths.size > 1 ? ` ${selectedPaths.size} selected` : ""}
          </button>
          <div className="my-1 border-t border-panel-line" />
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={() => { navigator.clipboard.writeText(contextItem.path).then(() => setLastResult("Path copied.")); setContextMenu(null); }} type="button">
            <Copy size={15} /> Copy Path
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={async () => {
            const name = (await requestInput({ title: "Rename Item", label: "Rename to", defaultValue: contextItem.name, confirmLabel: "Rename" }))?.trim();
            if (name && name !== contextItem.name) renameItem.mutate({ path: contextItem.path, name });
            setContextMenu(null);
          }} type="button">
            <Settings2 size={15} /> Rename
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={async () => {
            const name = (await requestInput({ title: "Copy Item Here", label: "Copy name", defaultValue: `copy-${contextItem.name}`, confirmLabel: "Copy" }))?.trim();
            if (name) copyItem.mutate({ sourcePath: contextItem.path, name });
            setContextMenu(null);
          }} type="button">
            <Copy size={15} /> Copy Here
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={async () => {
            const name = (await requestInput({ title: "Move Item Here", label: "Move/rename to", defaultValue: contextItem.name, confirmLabel: "Move" }))?.trim();
            if (name) moveItem.mutate({ sourcePath: contextItem.path, name });
            setContextMenu(null);
          }} type="button">
            <Settings2 size={15} /> Move Here
          </button>
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={async () => {
            const mode = (await requestInput({ title: "Change Permissions", label: "Mode", defaultValue: contextItem.permissions, confirmLabel: "Apply" }))?.trim();
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
          <button className="flex h-9 w-full items-center gap-2 px-3 text-left hover:bg-slate-50" onClick={async () => {
            const archivePath = (await requestInput({
              title: "Create Zip Archive",
              label: "Archive path",
              defaultValue: joinPath(parentPath(contextItem.path), `${contextItem.name}.zip`),
              confirmLabel: "Create"
            }))?.trim();
            if (archivePath && guardFixedRootPath(archivePath)) archiveCreate.mutate({ sourcePaths: [contextItem.path], archivePath });
            setContextMenu(null);
          }} type="button">
            <Archive size={15} /> Zip
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
      {uploadDialogOpen || uploadProgress ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-md bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line p-5">
              <div>
                <div className="font-semibold text-panel-text">Upload file</div>
                <div className="mt-1 text-sm text-panel-muted">Drop a file here or choose one from your device.</div>
              </div>
              <button
                aria-label="Close upload"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50 disabled:opacity-50"
                disabled={Boolean(uploadProgress && uploadProgress.phase !== "done")}
                onClick={() => {
                  setUploadDialogOpen(false);
                  setUploadDragActive(false);
                }}
                title="Close"
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5">
              <div
                className={`flex min-h-44 flex-col items-center justify-center rounded-md border border-dashed p-6 text-center transition ${uploadDragActive ? "border-panel-accent bg-emerald-50" : "border-panel-line bg-slate-50"}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setUploadDragActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setUploadDragActive(false);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  setUploadDragActive(false);
                  startUpload(event.dataTransfer.files?.[0]);
                }}
              >
                <Upload className="text-panel-muted" size={28} />
                <div className="mt-3 font-medium text-panel-text">Drag file to upload</div>
                <div className="mt-1 max-w-sm text-sm text-panel-muted">Files will upload to the current folder.</div>
                <label className="mt-4 flex h-9 cursor-pointer items-center gap-2 rounded-md border border-panel-line bg-white px-4 text-sm font-medium hover:bg-slate-50">
                  <Upload size={15} />
                  Choose file
                  <input
                    className="hidden"
                    disabled={Boolean(uploadProgress && uploadProgress.phase !== "done")}
                    onChange={(event) => {
                      startUpload(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                    type="file"
                  />
                </label>
              </div>
              {uploadProgress ? (
                <div className="mt-5 rounded-md border border-panel-line p-4">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-panel-line border-t-panel-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-panel-text">
                        {uploadProgress.phase === "done" ? "Upload complete" : uploadProgress.phase === "processing" ? "Finishing upload" : "Uploading file"}
                      </div>
                      <div className="mt-1 truncate text-sm text-panel-muted">{uploadProgress.fileName}</div>
                    </div>
                    <div className="text-sm font-semibold text-panel-text">{uploadProgress.percent}%</div>
                  </div>
                  <div className="mt-2 text-xs text-panel-muted">
                    {formatBytes(uploadProgress.uploadedBytes)} / {formatBytes(uploadProgress.totalBytes)}
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-panel-accent transition-all" style={{ width: `${uploadProgress.percent}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {extractProgress ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-md bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line p-5">
              <div>
                <div className="font-semibold text-panel-text">Extract archive</div>
                <div className="mt-1 text-sm text-panel-muted">Please keep this page open while files are being extracted.</div>
              </div>
              <button
                aria-label="Close extract progress"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50 disabled:opacity-50"
                disabled={extractProgress.phase !== "done"}
                onClick={() => setExtractProgress(null)}
                title="Close"
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5">
              <div className="rounded-md border border-panel-line p-4">
                <div className="flex items-center gap-3">
                  <div className={`h-8 w-8 rounded-full border-2 border-panel-line border-t-panel-accent ${extractProgress.phase === "done" ? "" : "animate-spin"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-panel-text">
                      {extractProgress.phase === "done" ? "Extract complete" : extractProgress.phase === "refreshing" ? "Refreshing file list" : "Extracting archive"}
                    </div>
                    <div className="mt-1 truncate text-sm text-panel-muted">
                      {extractProgress.fileName} · {extractProgress.current}/{extractProgress.total}
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-panel-text">{extractProgress.percent}%</div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-panel-accent transition-all" style={{ width: `${extractProgress.percent}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <InputModal
        open={Boolean(promptRequest)}
        title={promptRequest?.title ?? "Input"}
        label={promptRequest?.label}
        placeholder={promptRequest?.placeholder}
        defaultValue={promptRequest?.defaultValue}
        confirmLabel={promptRequest?.confirmLabel ?? "Confirm"}
        onClose={() => resolveInput(null)}
        onConfirm={(value) => resolveInput(value)}
      />
      <ConfirmModal
        open={Boolean(confirmRequest)}
        title={confirmRequest?.title ?? "Confirm action"}
        message={confirmRequest?.message ?? "Are you sure?"}
        confirmLabel={confirmRequest?.confirmLabel ?? "Confirm"}
        tone={confirmRequest?.tone ?? "danger"}
        onClose={() => resolveConfirm(false)}
        onConfirm={() => resolveConfirm(true)}
      />
      <ConfirmModal
        confirmLabel={deleteRequest?.permanent ? "Delete permanently" : "Move to trash"}
        message={deleteRequest
          ? deleteRequest.permanent
            ? `This will permanently delete ${deleteRequest.paths.length} item${deleteRequest.paths.length === 1 ? "" : "s"}.`
            : `This will move ${deleteRequest.paths.length} item${deleteRequest.paths.length === 1 ? "" : "s"} to trash.`
          : "Delete selected items?"}
        checkboxLabel={!currentInTrash ? "Permanently delete instead of moving to trash" : undefined}
        checkboxDefaultChecked={deleteRequest?.permanent ?? currentInTrash}
        onClose={() => setDeleteRequest(null)}
        onConfirm={(checked) => {
          if (!deleteRequest) return;
          const permanent = currentInTrash ? true : Boolean(checked);
          deleteItems.mutate({ paths: deleteRequest.paths, permanent });
        }}
        open={Boolean(deleteRequest)}
        pending={deleteItems.isPending}
        title={currentInTrash ? "Delete permanently?" : "Delete options"}
      />
      {repoPickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-6">
          <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-panel-line bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-panel-line p-4">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold"><Github size={17} />GitHub Projects</div>
                <div className="mt-1 text-xs text-panel-muted">Choose any repository and pull it into the current folder.</div>
              </div>
              <button className="flex h-8 w-8 items-center justify-center rounded-md border border-panel-line" onClick={() => setRepoPickerOpen(false)} type="button">
                <X size={16} />
              </button>
            </div>
            <div className="border-b border-panel-line p-4">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 text-panel-muted" size={15} />
                <input
                  className="h-9 w-full rounded-md border border-panel-line pl-9 pr-3 text-sm"
                  onChange={(event) => setRepoSearch(event.target.value)}
                  placeholder="Search GitHub repositories"
                  value={repoSearch}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {!githubRepos.data?.connected ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  GitHub not connected. Please connect from Deployments Create Project first, then come back here.
                </div>
              ) : null}
              {githubRepos.isLoading ? <div className="text-sm text-panel-muted">Loading repositories...</div> : null}
              {!githubRepos.isLoading && (githubRepos.data?.items?.length ?? 0) === 0 ? (
                <div className="text-sm text-panel-muted">{githubRepos.data?.connected ? "No repositories found." : "No repositories to show yet."}</div>
              ) : null}
              <div className="space-y-2">
                {(githubRepos.data?.items ?? []).map((repo) => (
                  <div className="flex items-center justify-between rounded-md border border-panel-line px-3 py-2" key={repo.fullName}>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{repo.fullName}</div>
                      <div className="text-xs text-panel-muted">Branch: {repo.defaultBranch || "main"}{repo.private ? " · Private" : ""}</div>
                    </div>
                    <button
                      className="h-8 rounded-md border border-panel-line px-3 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
                      disabled={githubPull.isPending}
                      onClick={() => githubPull.mutate(repo)}
                      type="button"
                    >
                      Pull Here
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
