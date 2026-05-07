import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { ensureDomainFileStructure } from "../lib/domainFiles.js";
import { sysagent } from "../lib/sysagent.js";

const execFileAsync = promisify(execFile);
const textReadLimit = 1024 * 1024;
const uploadLimit = 10 * 1024 * 1024;
const treeEntryLimit = 1500;

const unsafeName = /[<>:"|?*\x00-\x1F]/;

const textExtensions = new Set([
  ".c", ".conf", ".config", ".css", ".csv", ".env", ".go", ".html", ".ini", ".js", ".json", ".jsx", ".log", ".md",
  ".nginx", ".php", ".prisma", ".py", ".rb", ".rs", ".sh", ".sql", ".svg", ".toml", ".tsx", ".ts", ".txt", ".xml",
  ".yaml", ".yml"
]);

const imageExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  kind: string;
  extension: string;
  size: number;
  modifiedAt: string;
  createdAt: string;
  permissions: string;
  mime: string | null;
  isHidden: boolean;
  isReadonly: boolean;
};

type TreeEntry = FileEntry & {
  children: TreeEntry[];
};

function rootPath() {
  return path.resolve(env.FILE_MANAGER_ROOT);
}

function toRelative(resolved: string) {
  const root = rootPath();
  const relative = path.relative(root, resolved).replaceAll(path.sep, "/");
  return relative === "" ? "." : relative;
}

function safePath(inputPath = ".") {
  const root = rootPath();
  const normalized = inputPath.replaceAll("\\", "/");
  const resolved = path.resolve(root, normalized);
  const insideRoot = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  if (!insideRoot) {
    const error = new Error("Path escapes file manager root");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return resolved;
}

function safeChild(parentPath: string, name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || unsafeName.test(name)) {
    const error = new Error("Unsafe file or folder name");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return safePath(path.posix.join(toRelative(parentPath), name));
}

function fileKind(name: string, isDirectory: boolean) {
  if (isDirectory) return "directory";
  const extension = path.extname(name).toLowerCase();
  if (imageExtensions.has(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (textExtensions.has(extension)) return "text";
  return "binary";
}

function mimeType(name: string) {
  const extension = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml"
  };
  return map[extension] ?? "application/octet-stream";
}

function permissions(mode: number) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

async function statEntry(resolved: string): Promise<FileEntry> {
  const stats = await fs.stat(resolved);
  const name = path.basename(resolved);
  const isDirectory = stats.isDirectory();
  return {
    name,
    path: toRelative(resolved),
    type: isDirectory ? "directory" : "file",
    kind: fileKind(name, isDirectory),
    extension: isDirectory ? "" : path.extname(name).toLowerCase(),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    createdAt: stats.birthtime.toISOString(),
    permissions: permissions(stats.mode),
    mime: isDirectory ? null : mimeType(name),
    isHidden: name.startsWith("."),
    isReadonly: (stats.mode & 0o200) === 0
  };
}

async function directoryEntries(dir: string): Promise<FileEntry[]> {
  const names = await fs.readdir(dir);
  const entries = await Promise.all(names.map((name) => statEntry(path.join(dir, name))));
  return entries;
}

function sortEntries(entries: FileEntry[], sort: string, direction: string) {
  const factor = direction === "desc" ? -1 : 1;
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    const left = sort === "size" ? a.size : sort === "modifiedAt" ? Date.parse(a.modifiedAt) : a.name.toLowerCase();
    const right = sort === "size" ? b.size : sort === "modifiedAt" ? Date.parse(b.modifiedAt) : b.name.toLowerCase();
    return left > right ? factor : left < right ? -factor : 0;
  });
}

async function buildTree(dir: string, depth: number, state: { count: number }): Promise<TreeEntry[]> {
  if (depth < 0 || state.count > treeEntryLimit) return [];
  const entries = sortEntries(await directoryEntries(dir), "name", "asc").filter((entry) => entry.type === "directory");
  const result = [];
  for (const entry of entries) {
    state.count += 1;
    if (state.count > treeEntryLimit) break;
    const children: TreeEntry[] = await buildTree(safePath(entry.path), depth - 1, state);
    result.push({ ...entry, children });
  }
  return result;
}

async function looksBinary(file: string, size: number) {
  if (size === 0) return false;
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, 4096));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function checksum(file: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

function isPermissionError(error: unknown) {
  return error instanceof Error && "code" in error && ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM");
}

const listQuery = z.object({
  path: z.string().default("."),
  search: z.string().default(""),
  sort: z.enum(["name", "size", "modifiedAt"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(250).default(100)
});

const pathQuery = z.object({ path: z.string() });
const createSchema = z.object({ parentPath: z.string().default("."), name: z.string(), content: z.string().default("") });
const folderSchema = z.object({ parentPath: z.string().default("."), name: z.string() });
const domainScaffoldSchema = z.object({ domain: z.string().trim().toLowerCase() });
const saveSchema = z.object({ path: z.string(), content: z.string(), expectedModifiedAt: z.string().optional() });
const renameSchema = z.object({ path: z.string(), name: z.string() });
const copyMoveSchema = z.object({ sourcePath: z.string(), targetParentPath: z.string().default("."), name: z.string().optional(), overwrite: z.boolean().default(false) });
const deleteSchema = z.object({ paths: z.array(z.string()).min(1).max(100) });
const uploadSchema = z.object({ parentPath: z.string().default("."), name: z.string(), contentBase64: z.string(), overwrite: z.boolean().default(false) });
const chmodSchema = z.object({ path: z.string(), mode: z.string().regex(/^[0-7]{3,4}$/) });
const archiveSchema = z.object({ sourcePaths: z.array(z.string()).min(1).max(100), archivePath: z.string() });
const extractSchema = z.object({ archivePath: z.string(), targetPath: z.string().default("."), overwrite: z.boolean().default(false) });

export const fileRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/overview", async () => {
    const root = rootPath();
    await fs.mkdir(root, { recursive: true });
    return {
      root,
      platform: os.platform(),
      pathSeparator: path.sep,
      textReadLimit,
      uploadLimit,
      writable: true
    };
  });

  app.get("/list", async (request) => {
    const query = listQuery.parse(request.query);
    const dir = safePath(query.path);
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) throw app.httpErrors.badRequest("Path is not a directory");

    let entries = await directoryEntries(dir);
    if (query.search) {
      const search = query.search.toLowerCase();
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(search));
    }
    entries = sortEntries(entries, query.sort, query.direction);
    const start = (query.page - 1) * query.pageSize;
    const breadcrumbs = toRelative(dir).split("/").filter(Boolean).reduce<Array<{ name: string; path: string }>>((items, part) => {
      const parent = items.at(-1)?.path ?? "";
      items.push({ name: part === "." ? "root" : part, path: parent ? `${parent}/${part}` : part });
      return items;
    }, [{ name: "root", path: "." }]);

    return {
      current: await statEntry(dir),
      breadcrumbs,
      items: entries.slice(start, start + query.pageSize),
      total: entries.length,
      page: query.page,
      pageSize: query.pageSize
    };
  });

  app.get("/tree", async (request) => {
    const query = z.object({ path: z.string().default("."), depth: z.coerce.number().int().min(0).max(5).default(2) }).parse(request.query);
    const dir = safePath(query.path);
    return { root: await statEntry(dir), children: await buildTree(dir, query.depth, { count: 0 }) };
  });

  app.get("/read", async (request) => {
    const query = pathQuery.parse(request.query);
    const file = safePath(query.path);
    const stats = await fs.stat(file);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    if (stats.size > textReadLimit) throw app.httpErrors.payloadTooLarge("File is too large for editor");
    if (await looksBinary(file, stats.size)) throw app.httpErrors.unsupportedMediaType("Binary file cannot be opened in text editor");
    return { file: await statEntry(file), content: await fs.readFile(file, "utf8") };
  });

  app.put("/write", { bodyLimit: textReadLimit + 4096 }, async (request) => {
    const body = saveSchema.parse(request.body);
    const file = safePath(body.path);
    const stats = await fs.stat(file);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    if (body.expectedModifiedAt && stats.mtime.toISOString() !== body.expectedModifiedAt) {
      throw app.httpErrors.conflict("File changed on disk; reload before saving");
    }
    if (Buffer.byteLength(body.content, "utf8") > textReadLimit) throw app.httpErrors.payloadTooLarge("Content is too large");
    try {
      await fs.writeFile(file, body.content, "utf8");
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      await sysagent.writeFile({ path: body.path, content: body.content });
    }
    return { ok: true, file: await statEntry(file) };
  });

  app.post("/files", { bodyLimit: textReadLimit + 4096 }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const parent = safePath(body.parentPath);
    const file = safeChild(parent, body.name);
    try {
      await fs.writeFile(file, body.content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      await sysagent.createFile({ parentPath: body.parentPath, name: body.name, content: body.content, overwrite: false });
    }
    return reply.code(201).send(await statEntry(file));
  });

  app.post("/folders", async (request, reply) => {
    const body = folderSchema.parse(request.body);
    const parent = safePath(body.parentPath);
    const folder = safeChild(parent, body.name);
    try {
      await fs.mkdir(folder, { recursive: false });
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      await sysagent.createFolder({ parentPath: body.parentPath, name: body.name });
    }
    return reply.code(201).send(await statEntry(folder));
  });

  app.post("/domain-scaffold", async (request, reply) => {
    const body = domainScaffoldSchema.parse(request.body);
    const scaffold = await ensureDomainFileStructure(body.domain);
    const root = safePath(scaffold.relativeRoot);
    await audit(request, {
      action: "CREATE",
      resource: "file",
      description: `Prepared default file folders for ${scaffold.domain}`,
      metadata: { domain: scaffold.domain, folders: scaffold.folders }
    });
    return reply.code(201).send({ root: await statEntry(root), scaffold });
  });

  app.patch("/rename", async (request) => {
    const body = renameSchema.parse(request.body);
    const source = safePath(body.path);
    const target = safeChild(path.dirname(source), body.name);
    await fs.rename(source, target);
    return { ok: true, file: await statEntry(target) };
  });

  app.post("/copy", async (request) => {
    const body = copyMoveSchema.parse(request.body);
    const source = safePath(body.sourcePath);
    const targetParent = safePath(body.targetParentPath);
    const target = safeChild(targetParent, body.name ?? path.basename(source));
    if (!body.overwrite) {
      await fs.access(target).then(() => {
        throw app.httpErrors.conflict("Target already exists");
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await fs.cp(source, target, { recursive: true, force: body.overwrite, errorOnExist: !body.overwrite });
    return { ok: true, file: await statEntry(target) };
  });

  app.post("/move", async (request) => {
    const body = copyMoveSchema.parse(request.body);
    const source = safePath(body.sourcePath);
    const targetParent = safePath(body.targetParentPath);
    const target = safeChild(targetParent, body.name ?? path.basename(source));
    if (!body.overwrite) {
      await fs.access(target).then(() => {
        throw app.httpErrors.conflict("Target already exists");
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await fs.rename(source, target);
    return { ok: true, file: await statEntry(target) };
  });

  app.delete("/delete", async (request) => {
    const body = deleteSchema.parse(request.body);
    const removed = [];
    for (const itemPath of body.paths) {
      const resolved = safePath(itemPath);
      try {
        await fs.rm(resolved, { recursive: true, force: true });
      } catch (error) {
        if (!isPermissionError(error)) throw error;
        await sysagent.deleteFiles({ paths: [itemPath] });
      }
      removed.push(itemPath);
    }
    await audit(request, { action: "DELETE", resource: "file", description: `Deleted ${removed.length} file manager item(s)`, metadata: { paths: removed } });
    return { ok: true, removed };
  });

  app.post("/upload", { bodyLimit: uploadLimit * 1.4 }, async (request, reply) => {
    const body = uploadSchema.parse(request.body);
    const parent = safePath(body.parentPath);
    const file = safeChild(parent, body.name);
    const buffer = Buffer.from(body.contentBase64, "base64");
    if (buffer.byteLength > uploadLimit) throw app.httpErrors.payloadTooLarge("Upload is too large");
    try {
      await fs.writeFile(file, buffer, { flag: body.overwrite ? "w" : "wx" });
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      await sysagent.createFile({ parentPath: body.parentPath, name: body.name, contentBase64: body.contentBase64, overwrite: body.overwrite });
    }
    return reply.code(201).send(await statEntry(file));
  });

  app.get("/download", async (request) => {
    const query = pathQuery.parse(request.query);
    const file = safePath(query.path);
    const stats = await fs.stat(file);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    const contentBase64 = await fs.readFile(file, "base64");
    return { file: await statEntry(file), contentBase64 };
  });

  app.get("/checksum", async (request) => {
    const query = pathQuery.parse(request.query);
    const file = safePath(query.path);
    const stats = await fs.stat(file);
    if (!stats.isFile()) throw app.httpErrors.badRequest("Path is not a file");
    return { path: query.path, algorithm: "sha256", hash: await checksum(file) };
  });

  app.post("/chmod", async (request) => {
    const body = chmodSchema.parse(request.body);
    const target = safePath(body.path);
    if (process.platform === "win32") {
      return { dryRun: true, path: body.path, mode: body.mode, reason: "chmod is Linux-oriented; Windows local mode is dry-run" };
    }
    try {
      await fs.chmod(target, Number.parseInt(body.mode, 8));
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      await sysagent.chmodFile({ path: body.path, mode: body.mode });
    }
    return { ok: true, file: await statEntry(target) };
  });

  app.post("/archive/create", async (request) => {
    const body = archiveSchema.parse(request.body);
    const archive = safePath(body.archivePath);
    if (path.extname(archive).toLowerCase() !== ".zip") throw app.httpErrors.badRequest("Archive path must end with .zip");
    const sources = body.sourcePaths.map((itemPath) => safePath(itemPath));
    const command = process.platform === "win32"
      ? { file: "powershell.exe", args: ["-NoProfile", "-Command", "Compress-Archive", "-LiteralPath", ...sources, "-DestinationPath", archive, "-Force"], cwd: undefined }
      : { file: "zip", args: ["-r", archive, ...sources.map((source) => path.relative(path.dirname(archive), source))], cwd: path.dirname(archive) };
    try {
      await execFileAsync(command.file, command.args, command.cwd ? { cwd: command.cwd } : undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return { dryRun: true, command: [command.file, ...command.args], reason: "Archive command blocked by local execution policy" };
      }
      throw error;
    }
    return { ok: true, file: await statEntry(archive) };
  });

  app.post("/archive/extract", async (request) => {
    const body = extractSchema.parse(request.body);
    const archive = safePath(body.archivePath);
    const target = safePath(body.targetPath);
    if (path.extname(archive).toLowerCase() !== ".zip") throw app.httpErrors.badRequest("Only .zip extraction is supported");
    const command = process.platform === "win32"
      ? { file: "powershell.exe", args: ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", archive, "-DestinationPath", target, ...(body.overwrite ? ["-Force"] : [])] }
      : { file: "unzip", args: [body.overwrite ? "-o" : "-n", archive, "-d", target] };
    try {
      await execFileAsync(command.file, command.args);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return { dryRun: true, command: [command.file, ...command.args], reason: "Archive command blocked by local execution policy" };
      }
      throw error;
    }
    return { ok: true, target: await statEntry(target) };
  });
};
