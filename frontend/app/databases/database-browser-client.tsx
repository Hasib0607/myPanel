"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, Database, Edit3, Plus, RefreshCw, Save, Search, Table2, Trash2, X } from "lucide-react";
import Link from "next/link";
import { apiDeleteBody, apiGet, apiPatch, apiPost } from "@/lib/api";

type Engine = "POSTGRESQL" | "MYSQL";
type Column = { name: string; type: string; nullable: string; primary?: boolean };
type TableListResult = { engine: Engine; database: string; tables: string[] };
type ColumnListResult = { engine: Engine; database: string; table: string; columns: Column[] };
type RowPreviewResult = { engine: Engine; database: string; table: string; format: "CSV" | "TSV" | string; rows: string };
type DatabaseOverview = {
  engines: Array<{
    engine: Engine;
    databases: Array<{ name: string; owner: string | null; tableCount?: number; rowCount?: number; sizeBytes?: number }>;
  }>;
};

type DatabaseBrowserClientProps = {
  apiBase?: string;
  engine: Engine;
  database: string;
  backHref?: string;
};

type TableTab = "data" | "columns" | "editor";
type RowValue = string | number | boolean | null;

function searchColumnLabel(selected: string[], columns: Column[]) {
  if (selected.length === 0) return "Select columns";
  if (selected.length === 1) return selected[0] ?? "1 column";
  if (selected.length === columns.length) return "All columns";
  return `${selected.length} columns`;
}

function searchScopeLabel(columns: string[] | undefined) {
  if (columns === undefined) return "all columns";
  if (columns.length === 0) return "no columns";
  if (columns.length === 1) return columns[0] ?? "1 column";
  return `${columns.length} columns`;
}

function parseCsvRecords(raw: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      record.push(current);
      current = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      record.push(current);
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0 || record.length > 0) {
    record.push(current);
    if (record.some((value) => value.length > 0)) records.push(record);
  }
  return records;
}

function parseRows(raw: string, format: string) {
  const records = format === "CSV"
    ? parseCsvRecords(raw)
    : raw.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split("\t"));
  if (records.length === 0) return { headers: [] as string[], rows: [] as Record<string, string>[] };
  const headers = records[0] ?? [];
  const rows = records.slice(1).map((cells) => {
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
  return { headers, rows };
}

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function humanBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function matchesSearch(value: string, query: string) {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

function nullable(column: Column) {
  return column.nullable.toUpperCase() === "YES";
}

function normalizeDraftValue(column: Column, value: string): RowValue {
  if (nullable(column) && value.trim().toUpperCase() === "NULL") return null;
  return value;
}

function createValues(columns: Column[], draft: Record<string, string>) {
  return Object.fromEntries(columns.map((column) => [column.name, normalizeDraftValue(column, draft[column.name] ?? "")]));
}

function changedValues(columns: Column[], before: Record<string, string>, draft: Record<string, string>, primaryColumn: string) {
  return Object.fromEntries(
    columns
      .filter((column) => column.name !== primaryColumn && (draft[column.name] ?? "") !== (before[column.name] ?? ""))
      .map((column) => [column.name, normalizeDraftValue(column, draft[column.name] ?? "")])
  );
}

export function DatabaseBrowserClient({ apiBase = "/databases", engine, database, backHref = "/databases" }: DatabaseBrowserClientProps) {
  const [selectedTable, setSelectedTable] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(100);
  const [tableSearch, setTableSearch] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const [rowSearch, setRowSearch] = useState("");
  const [rowSearchColumns, setRowSearchColumns] = useState<string[]>([]);
  const [appliedRowSearch, setAppliedRowSearch] = useState("");
  const [appliedRowSearchColumns, setAppliedRowSearchColumns] = useState<string[] | undefined>(undefined);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TableTab>("data");
  const [notice, setNotice] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const target = { engine, database };
  const overview = useQuery({
    queryKey: ["database-browser-overview", apiBase],
    queryFn: () => apiGet<DatabaseOverview>(apiBase)
  });
  const tables = useQuery({
    queryKey: ["database-browser-tables", apiBase, engine, database],
    queryFn: () => apiPost<TableListResult>(`${apiBase}/tables`, target)
  });
  const columns = useQuery({
    enabled: Boolean(selectedTable),
    queryKey: ["database-browser-columns", apiBase, engine, database, selectedTable],
    queryFn: () => apiPost<ColumnListResult>(`${apiBase}/columns`, { ...target, table: selectedTable })
  });
  const rowSearchTerm = appliedRowSearch.trim();
  const rowSearchColumnKey = appliedRowSearchColumns?.join("|") ?? "all";
  const rows = useQuery({
    enabled: Boolean(selectedTable),
    queryKey: ["database-browser-rows", apiBase, engine, database, selectedTable, limit, offset, rowSearchTerm, rowSearchColumnKey],
    queryFn: () => apiPost<RowPreviewResult>(`${apiBase}/rows`, { ...target, table: selectedTable, limit, offset, search: rowSearchTerm || undefined, searchColumns: appliedRowSearchColumns })
  });

  useEffect(() => {
    if (!selectedTable && (tables.data?.tables.length ?? 0) > 0) setSelectedTable(tables.data?.tables[0] ?? "");
  }, [selectedTable, tables.data?.tables]);

  useEffect(() => {
    setColumnSearch("");
    setRowSearch("");
    setRowSearchColumns([]);
    setAppliedRowSearch("");
    setAppliedRowSearchColumns(undefined);
    setColumnPickerOpen(false);
    setActiveTab("data");
  }, [selectedTable]);

  useEffect(() => {
    const available = new Set((columns.data?.columns ?? []).map((column) => column.name));
    setRowSearchColumns((current) => current.filter((column) => available.has(column)));
    setAppliedRowSearchColumns((current) => current?.filter((column) => available.has(column)));
  }, [columns.data?.columns]);

  const databaseInfo = overview.data?.engines.find((item) => item.engine === engine)?.databases.find((item) => item.name === database);
  const parsed = useMemo(() => parseRows(rows.data?.rows ?? "", rows.data?.format ?? "TSV"), [rows.data]);
  const filteredTables = useMemo(
    () => (tables.data?.tables ?? []).filter((table) => matchesSearch(table, tableSearch)),
    [tables.data?.tables, tableSearch]
  );
  const filteredColumns = useMemo(
    () => (columns.data?.columns ?? []).filter((column) =>
      matchesSearch(column.name, columnSearch)
      || matchesSearch(column.type, columnSearch)
      || matchesSearch(column.nullable, columnSearch)
      || (column.primary && matchesSearch("primary", columnSearch))
    ),
    [columns.data?.columns, columnSearch]
  );
  const filteredRows = parsed.rows;
  const primaryColumn = columns.data?.columns.find((column) => column.primary)?.name ?? null;
  const editableColumns = columns.data?.columns ?? [];
  const selectedSearchColumns = rowSearchColumns;

  const refreshTable = async () => {
    await Promise.all([tables.refetch(), columns.refetch(), rows.refetch(), overview.refetch()]);
  };

  const createRow = useMutation({
    mutationFn: () => apiPost(`${apiBase}/row`, { ...target, table: selectedTable, values: createValues(editableColumns, draft) }),
    onSuccess: async () => {
      setNotice({ text: "Row inserted.", tone: "success" });
      setCreating(false);
      setDraft({});
      await refreshTable();
    },
    onError: (error) => setNotice({ text: error instanceof Error ? error.message : "Could not insert row.", tone: "error" })
  });

  const updateRow = useMutation({
    mutationFn: () => {
      if (!primaryColumn || !editing) throw new Error("Primary key is required for row edit.");
      const values = changedValues(editableColumns, editing, draft, primaryColumn);
      if (Object.keys(values).length === 0) throw new Error("No changed values to save.");
      return apiPatch(`${apiBase}/row`, { ...target, table: selectedTable, keyColumn: primaryColumn, keyValue: editing[primaryColumn], values });
    },
    onSuccess: async () => {
      setNotice({ text: "Row updated.", tone: "success" });
      setEditing(null);
      setDraft({});
      await refreshTable();
    },
    onError: (error) => setNotice({ text: error instanceof Error ? error.message : "Could not update row.", tone: "error" })
  });

  const deleteRow = useMutation({
    mutationFn: (row: Record<string, string>) => {
      if (!primaryColumn) throw new Error("Primary key is required for row delete.");
      return apiDeleteBody(`${apiBase}/row`, { ...target, table: selectedTable, keyColumn: primaryColumn, keyValue: row[primaryColumn] });
    },
    onSuccess: async () => {
      setNotice({ text: "Row deleted.", tone: "success" });
      await refreshTable();
    },
    onError: (error) => setNotice({ text: error instanceof Error ? error.message : "Could not delete row.", tone: "error" })
  });

  function openCreate() {
    setEditing(null);
    setCreating(true);
    setDraft(Object.fromEntries(editableColumns.map((column) => [column.name, ""])));
    setActiveTab("editor");
  }

  function openEdit(row: Record<string, string>) {
    setCreating(false);
    setEditing(row);
    setDraft({ ...row });
    setActiveTab("editor");
  }

  function applyRowSearch() {
    setAppliedRowSearch(rowSearch.trim());
    setAppliedRowSearchColumns(rowSearch.trim() ? rowSearchColumns : undefined);
    setOffset(0);
    setColumnPickerOpen(false);
  }

  function clearRowSearch() {
    setRowSearch("");
    setAppliedRowSearch("");
    setAppliedRowSearchColumns(undefined);
    setOffset(0);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="border-b border-panel-line bg-white px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Link className="mb-3 inline-flex items-center gap-2 text-sm font-medium text-panel-muted hover:text-panel-ink" href={backHref}>
              <ChevronLeft size={16} /> Databases
            </Link>
            <div className="flex items-center gap-3">
              <Database size={24} />
              <div className="min-w-0">
                <h1 className="truncate text-2xl font-semibold text-panel-ink">{database}</h1>
                <div className="text-sm text-panel-muted">{engine === "MYSQL" ? "MySQL / MariaDB" : "PostgreSQL"} database browser</div>
              </div>
            </div>
          </div>
          <button className="inline-flex h-10 items-center gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50" onClick={refreshTable} type="button">
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-sm text-panel-muted">
          <span className="rounded-md bg-slate-100 px-3 py-1">{compactNumber(databaseInfo?.tableCount ?? tables.data?.tables.length ?? 0)} tables</span>
          <span className="rounded-md bg-slate-100 px-3 py-1">{compactNumber(databaseInfo?.rowCount ?? 0)} rows</span>
          <span className="rounded-md bg-slate-100 px-3 py-1">{humanBytes(databaseInfo?.sizeBytes ?? 0)}</span>
          {primaryColumn ? <span className="rounded-md bg-emerald-50 px-3 py-1 text-emerald-700">PK {primaryColumn}</span> : <span className="rounded-md bg-amber-50 px-3 py-1 text-amber-700">No primary key selected</span>}
        </div>
      </div>

      <div className="grid grid-cols-[280px_1fr]">
        <aside className="min-h-[calc(100vh-150px)] border-r border-panel-line bg-white">
          <div className="border-b border-panel-line px-4 py-3 text-sm font-semibold">Tables</div>
          <div className="border-b border-panel-line px-3 py-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-panel-muted" size={14} />
              <input
                className="h-9 w-full rounded-md border border-panel-line bg-white pl-8 pr-8 text-sm outline-none ring-panel-accent focus:ring-2"
                onChange={(event) => setTableSearch(event.target.value)}
                placeholder="Search tables..."
                type="search"
                value={tableSearch}
              />
              {tableSearch ? (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-panel-muted hover:bg-slate-100 hover:text-panel-ink"
                  onClick={() => setTableSearch("")}
                  title="Clear search"
                  type="button"
                >
                  <X size={14} />
                </button>
              ) : null}
            </label>
          </div>
          <div className="max-h-[calc(100vh-250px)] overflow-auto p-3">
            {filteredTables.map((table) => (
              <button
                className={`mb-1 flex h-10 w-full items-center gap-2 rounded-md px-3 text-left text-sm ${selectedTable === table ? "bg-slate-900 text-white" : "hover:bg-slate-50"}`}
                key={table}
                onClick={() => {
                  setSelectedTable(table);
                  setOffset(0);
                  setEditing(null);
                  setCreating(false);
                }}
                type="button"
              >
                <Table2 size={15} />
                <span className="truncate font-medium">{table}</span>
              </button>
            ))}
            {tables.isLoading ? <div className="p-3 text-sm text-panel-muted">Loading tables...</div> : null}
            {!tables.isLoading && (tables.data?.tables.length ?? 0) === 0 ? <div className="p-3 text-sm text-panel-muted">No tables found.</div> : null}
            {!tables.isLoading && (tables.data?.tables.length ?? 0) > 0 && filteredTables.length === 0 ? (
              <div className="p-3 text-sm text-panel-muted">No tables match &quot;{tableSearch}&quot;.</div>
            ) : null}
          </div>
        </aside>

        <main className="min-w-0 p-5">
          {notice ? (
            <div className={`mb-4 rounded-md border px-4 py-3 text-sm ${notice.tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
              {notice.text}
            </div>
          ) : null}

          <div className="mb-4 rounded-md border border-panel-line bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
              <div>
                <div className="font-semibold">{selectedTable || "Select a table"}</div>
                <div className="text-xs text-panel-muted">
                  {editableColumns.length} table columns · showing {rowSearchTerm ? `${filteredRows.length} of ` : ""}{parsed.rows.length} rows
                  {rowSearchTerm ? ` matching search in ${searchScopeLabel(appliedRowSearchColumns)}` : ""}
                </div>
              </div>
            </div>

            <div className="flex gap-1 border-b border-panel-line px-4 pt-3">
              {([
                { id: "data" as const, label: "Data" },
                { id: "columns" as const, label: "Columns" },
                { id: "editor" as const, label: "Row Editor" }
              ]).map((tab) => (
                <button
                  className={`rounded-t-md border border-b-0 px-4 py-2 text-sm font-semibold transition-colors ${
                    activeTab === tab.id
                      ? "border-panel-line bg-white text-panel-ink"
                      : "border-transparent bg-transparent text-panel-muted hover:text-panel-ink"
                  }`}
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === "data" ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-line px-4 py-3">
                  <form
                    className="flex min-w-[280px] flex-1 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      applyRowSearch();
                    }}
                  >
                    <label className="relative block min-w-[220px] flex-1 max-w-xl">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-panel-muted" size={14} />
                      <input
                        className="h-9 w-full rounded-md border border-panel-line bg-white pl-8 pr-8 text-sm outline-none ring-panel-accent focus:ring-2 disabled:bg-slate-50"
                        disabled={!selectedTable}
                        onChange={(event) => setRowSearch(event.target.value)}
                        placeholder="Search rows..."
                        type="search"
                        value={rowSearch}
                      />
                      {rowSearch || appliedRowSearch ? (
                        <button
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-panel-muted hover:bg-slate-100 hover:text-panel-ink"
                          onClick={clearRowSearch}
                          title="Clear search"
                          type="button"
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                    </label>
                    <button
                      className="inline-flex h-9 items-center gap-2 rounded-md bg-panel-ink px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                      disabled={!selectedTable}
                      type="submit"
                    >
                      <Search size={14} /> Search
                    </button>
                  </form>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                      <button
                        className="inline-flex h-9 min-w-[150px] items-center justify-between gap-2 rounded-md border border-panel-line bg-white px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
                        disabled={!selectedTable || editableColumns.length === 0}
                        onClick={() => setColumnPickerOpen((open) => !open)}
                        type="button"
                      >
                        <span className="truncate">{searchColumnLabel(rowSearchColumns, editableColumns)}</span>
                        <ChevronDown size={14} />
                      </button>
                      {columnPickerOpen ? (
                        <div className="absolute right-0 top-10 z-20 w-72 rounded-md border border-panel-line bg-white shadow-lg">
                          <div className="border-b border-panel-line p-2">
                            <button
                              className="flex h-8 w-full items-center rounded-md px-2 text-left text-sm font-medium hover:bg-slate-50"
                              onClick={() => {
                                setRowSearchColumns([]);
                                setOffset(0);
                              }}
                              type="button"
                            >
                              Clear selection
                            </button>
                          </div>
                          <div className="max-h-72 overflow-auto p-2">
                            {editableColumns.map((column) => {
                              const checked = selectedSearchColumns.includes(column.name);
                              return (
                                <label className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-slate-50" key={column.name}>
                                  <input
                                    checked={checked}
                                    className="h-4 w-4 rounded border-panel-line text-panel-accent"
                                    onChange={(event) => {
                                      setRowSearchColumns((current) => {
                                        return event.target.checked ? Array.from(new Set([...current, column.name])) : current.filter((item) => item !== column.name);
                                      });
                                      setOffset(0);
                                    }}
                                    type="checkbox"
                                  />
                                  <span className="truncate font-mono text-xs">{column.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <select className="h-9 rounded-md border border-panel-line px-2 text-sm" onChange={(event) => setLimit(Number(event.target.value))} value={limit}>
                      {[50, 100, 250, 500].map((value) => <option key={value} value={value}>{value} rows</option>)}
                    </select>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} type="button">Prev</button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => setOffset(offset + limit)} type="button">Next</button>
                    <button className="inline-flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-50" disabled={!selectedTable || editableColumns.length === 0} onClick={openCreate} type="button">
                      <Plus size={15} /> Row
                    </button>
                  </div>
                </div>

                <div className="overflow-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase text-panel-muted">
                      <tr>
                        <th className="sticky left-0 z-10 w-24 bg-slate-50 px-3 py-3">Actions</th>
                        {parsed.headers.map((header) => <th className="whitespace-nowrap px-3 py-3" key={header}>{header}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row, index) => (
                        <tr className="border-t border-panel-line bg-white hover:bg-slate-50" key={`${row[primaryColumn ?? ""] ?? index}-${index}`}>
                          <td className="sticky left-0 z-10 bg-inherit px-3 py-2">
                            <div className="flex gap-1">
                              <button className="rounded-md border border-panel-line p-1.5 hover:bg-white disabled:opacity-40" disabled={!primaryColumn} onClick={() => openEdit(row)} title="Edit row" type="button"><Edit3 size={14} /></button>
                              <button
                                className="rounded-md border border-panel-line p-1.5 text-panel-danger hover:bg-red-50 disabled:opacity-40"
                                disabled={!primaryColumn || deleteRow.isPending}
                                onClick={() => window.confirm("Delete this row?") && deleteRow.mutate(row)}
                                title="Delete row"
                                type="button"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                          {parsed.headers.map((header) => (
                            <td className="max-w-80 truncate px-3 py-2 font-mono text-xs" key={header} title={row[header] ?? ""}>{row[header] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.isLoading ? <div className="p-6 text-sm text-panel-muted">Loading rows...</div> : null}
                  {!rows.isLoading && selectedTable && !rowSearchTerm && parsed.rows.length === 0 ? <div className="p-6 text-sm text-panel-muted">No rows found in this page.</div> : null}
                  {!rows.isLoading && selectedTable && rowSearchTerm && parsed.rows.length === 0 ? (
                    <div className="p-6 text-sm text-panel-muted">No rows match &quot;{rowSearchTerm}&quot; in this table.</div>
                  ) : null}
                </div>
              </>
            ) : null}

            {activeTab === "columns" ? (
              <div className="p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-panel-ink">Table columns</div>
                  {columnSearch ? <span className="text-xs text-panel-muted">{filteredColumns.length} shown</span> : null}
                </div>
                <label className="relative mb-3 block max-w-xl">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-panel-muted" size={14} />
                  <input
                    className="h-9 w-full rounded-md border border-panel-line bg-white pl-8 pr-8 text-sm outline-none ring-panel-accent focus:ring-2"
                    onChange={(event) => setColumnSearch(event.target.value)}
                    placeholder="Search columns..."
                    type="search"
                    value={columnSearch}
                  />
                  {columnSearch ? (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-panel-muted hover:bg-slate-100 hover:text-panel-ink"
                      onClick={() => setColumnSearch("")}
                      title="Clear search"
                      type="button"
                    >
                      <X size={14} />
                    </button>
                  ) : null}
                </label>
                <div className="overflow-auto rounded-md border border-panel-line">
                  <div className="grid grid-cols-[1fr_1fr_100px] gap-2 border-b border-panel-line bg-slate-50 px-3 py-2 text-xs font-semibold uppercase text-panel-muted">
                    <span>Name</span>
                    <span>Type</span>
                    <span>Nullable</span>
                  </div>
                  {filteredColumns.map((column) => (
                    <div className="grid grid-cols-[1fr_1fr_100px] gap-2 border-b border-panel-line px-3 py-2 text-sm last:border-b-0" key={column.name}>
                      <span className="truncate font-mono font-semibold">{column.name}</span>
                      <span className="truncate text-panel-muted">{column.type}</span>
                      <span className={column.primary ? "font-medium text-emerald-700" : "text-panel-muted"}>{column.primary ? "primary" : column.nullable}</span>
                    </div>
                  ))}
                  {selectedTable && editableColumns.length > 0 && filteredColumns.length === 0 ? (
                    <div className="px-3 py-6 text-sm text-panel-muted">No columns match &quot;{columnSearch}&quot;.</div>
                  ) : null}
                  {!selectedTable ? <div className="px-3 py-6 text-sm text-panel-muted">Select a table to view columns.</div> : null}
                </div>
              </div>
            ) : null}

            {activeTab === "editor" ? (
              <div className="p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-panel-ink">{creating ? "Add row" : editing ? "Edit row" : "Row editor"}</div>
                  <button
                    className="inline-flex h-9 items-center gap-2 rounded-md bg-panel-accent px-3 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={!selectedTable || editableColumns.length === 0}
                    onClick={openCreate}
                    type="button"
                  >
                    <Plus size={15} /> New row
                  </button>
                </div>
                {creating || editing ? (
                  <div className="space-y-4">
                    <div className="grid max-h-[calc(100vh-360px)] grid-cols-1 gap-3 overflow-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
                      {editableColumns.map((column) => (
                        <label className="space-y-1 text-xs font-medium text-panel-muted" key={column.name}>
                          {column.name}
                          <input
                            className="h-9 w-full rounded-md border border-panel-line px-2 font-mono text-sm text-panel-ink disabled:bg-slate-100"
                            disabled={Boolean(editing && column.name === primaryColumn)}
                            onChange={(event) => setDraft((current) => ({ ...current, [column.name]: event.target.value }))}
                            value={draft[column.name] ?? ""}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button className="inline-flex h-9 items-center gap-2 rounded-md bg-panel-ink px-3 text-sm font-semibold text-white disabled:opacity-50" disabled={createRow.isPending || updateRow.isPending} onClick={() => creating ? createRow.mutate() : updateRow.mutate()} type="button">
                        <Save size={15} /> Save
                      </button>
                      <button className="inline-flex h-9 items-center gap-2 rounded-md border border-panel-line px-3 text-sm font-semibold hover:bg-slate-50" onClick={() => { setCreating(false); setEditing(null); setDraft({}); }} type="button">
                        <X size={15} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-panel-line p-8 text-sm text-panel-muted">
                    Select a row from the Data tab to edit, or click New row to insert one.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
