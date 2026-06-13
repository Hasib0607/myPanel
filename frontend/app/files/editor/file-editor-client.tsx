"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Code2, RefreshCw, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { apiGet, apiPut } from "@/lib/api";

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  kind: "directory" | "text" | "image" | "pdf" | "binary" | string;
  extension: string;
  modifiedAt: string;
  permissions: string;
};

type ReadResponse = {
  file: FileEntry;
  content: string;
};

type MonacoEditor = {
  getValue: () => string;
  setValue: (value: string) => void;
  updateOptions: (options: Record<string, unknown>) => void;
  dispose: () => void;
  onDidChangeModelContent: (listener: () => void) => { dispose: () => void };
};

const languageMap: Record<string, string> = {
  ".css": "css",
  ".env": "ini",
  ".go": "go",
  ".html": "html",
  ".ini": "ini",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".md": "markdown",
  ".nginx": "nginx",
  ".php": "php",
  ".prisma": "prisma",
  ".py": "python",
  ".sh": "shell",
  ".sql": "sql",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".txt": "plaintext",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml"
};

function queryString(values: Record<string, string | number>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => params.set(key, String(value)));
  return params.toString();
}

function parentPath(filePath: string) {
  if (!filePath || filePath === "." || !filePath.includes("/")) return ".";
  return filePath.split("/").slice(0, -1).join("/") || ".";
}

export function FileEditorClient({ initialPath, apiBase = "/files" }: { initialPath: string; apiBase?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const suppressEditorChange = useRef(false);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [lastResult, setLastResult] = useState("");
  const [wordWrap, setWordWrap] = useState(true);
  const [minimap, setMinimap] = useState(false);
  const [fontSize, setFontSize] = useState(14);
  const [theme, setTheme] = useState<"vs" | "vs-dark">("vs");

  const filePath = initialPath.trim();
  const readFile = useQuery({
    enabled: Boolean(filePath),
    queryKey: ["files-editor-read", apiBase, filePath],
    queryFn: () => apiGet<ReadResponse>(`${apiBase}/read?${queryString({ path: filePath })}`)
  });

  const file = readFile.data?.file ?? null;
  const language = useMemo(() => (file ? languageMap[file.extension] ?? "plaintext" : "plaintext"), [file]);
  const dirty = content !== originalContent;

  useEffect(() => {
    if (!readFile.data) return;
    setContent(readFile.data.content);
    setOriginalContent(readFile.data.content);
    suppressEditorChange.current = true;
    editorRef.current?.setValue(readFile.data.content);
    suppressEditorChange.current = false;
    setLastResult("");
  }, [readFile.data]);

  useEffect(() => {
    let disposed = false;
    if (!editorHostRef.current || !readFile.data) return;

    import("monaco-editor").then((monaco) => {
      if (disposed || !editorHostRef.current) return;
      editorRef.current?.dispose();
      editorRef.current = monaco.editor.create(editorHostRef.current, {
        value: readFile.data.content,
        language,
        theme,
        automaticLayout: true,
        minimap: { enabled: minimap },
        wordWrap: wordWrap ? "on" : "off",
        fontSize,
        scrollBeyondLastLine: false
      }) as MonacoEditor;
      editorRef.current.onDidChangeModelContent(() => {
        if (suppressEditorChange.current) return;
        setContent(editorRef.current?.getValue() ?? "");
      });
    });

    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, [readFile.data?.file.path, language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: minimap }, wordWrap: wordWrap ? "on" : "off", fontSize, theme });
  }, [fontSize, minimap, theme, wordWrap]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const saveFile = useMutation({
    mutationFn: () => apiPut<{ ok: true; file: FileEntry }>(`${apiBase}/write`, { path: filePath, content, expectedModifiedAt: file?.modifiedAt }),
    onSuccess: async () => {
      setOriginalContent(content);
      setLastResult("Saved.");
      await queryClient.invalidateQueries({ queryKey: ["files-editor-read", apiBase, filePath] });
      await queryClient.invalidateQueries({ queryKey: ["files-list"] });
    },
    onError: (error) => setLastResult(error instanceof Error ? error.message : "Could not save")
  });

  function formatContent() {
    if (file?.extension !== ".json") {
      setLastResult("Format is available for JSON files.");
      return;
    }
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      setContent(formatted);
      editorRef.current?.setValue(formatted);
      setLastResult("Formatted.");
    } catch {
      setLastResult("Invalid JSON.");
    }
  }

  function goBack() {
    if (typeof window === "undefined") return;
    window.history.back();
  }

  return (
    <section className="flex h-screen min-h-0 flex-col bg-panel-bg">
      <div className="flex min-h-[81px] flex-wrap items-center justify-between gap-3 border-b border-panel-line bg-white px-8 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button
              className="flex h-9 w-9 items-center justify-center rounded-md border border-panel-line hover:bg-slate-50"
              onClick={goBack}
              title="Back"
              type="button"
            >
              <ArrowLeft size={16} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold text-panel-text">{file?.name ?? "File Editor"}</h1>
              <p className="mt-1 truncate text-sm text-panel-muted">{filePath || "Select a file from File Manager"}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {lastResult ? <span className="rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">{lastResult}</span> : null}
          {dirty ? <span className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">Unsaved</span> : <span className="flex items-center gap-1 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700"><Check size={14} /> Saved</span>}
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" disabled={readFile.isFetching} onClick={() => readFile.refetch()} type="button">
            <RefreshCw size={15} /> Reload
          </button>
          <button className="flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm hover:bg-slate-50" onClick={formatContent} type="button">
            <Code2 size={15} /> Format
          </button>
          <button className="flex h-9 items-center gap-2 rounded-md bg-panel-accent px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={!dirty || saveFile.isPending || !filePath} onClick={() => saveFile.mutate()} type="button">
            <Save size={15} /> Save
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-panel-line bg-white px-8 py-3">
        <label className="flex items-center gap-2 text-sm"><input checked={wordWrap} onChange={(event) => setWordWrap(event.target.checked)} type="checkbox" /> Wrap</label>
        <label className="flex items-center gap-2 text-sm"><input checked={minimap} onChange={(event) => setMinimap(event.target.checked)} type="checkbox" /> Minimap</label>
        <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setTheme(event.target.value as "vs" | "vs-dark")} value={theme}>
          <option value="vs">Light</option>
          <option value="vs-dark">Dark</option>
        </select>
        <input className="h-9 w-20 rounded-md border border-panel-line px-2 text-sm" max={24} min={11} onChange={(event) => setFontSize(Number(event.target.value))} type="number" value={fontSize} />
        {file ? <span className="text-sm text-panel-muted">Mode {file.permissions} · {language}</span> : null}
      </div>

      <div className="min-h-0 flex-1 p-6">
        {!filePath ? (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-panel-line bg-white text-panel-muted">No file selected.</div>
        ) : readFile.isError ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-panel-danger">{readFile.error instanceof Error ? readFile.error.message : "Could not open file"}</div>
        ) : readFile.isLoading ? (
          <div className="flex h-full items-center justify-center rounded-md border border-panel-line bg-white text-panel-muted">Loading editor...</div>
        ) : (
          <div className="h-full overflow-hidden rounded-md border border-panel-line bg-white" ref={editorHostRef} />
        )}
      </div>
    </section>
  );
}
