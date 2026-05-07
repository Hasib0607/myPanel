import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

export const domainDefaultFolders = [
  "public_html",
  "public_ftp",
  "etc",
  "logs",
  "mail",
  "tmp",
  "ssl",
  "backups",
  "private"
];

function fileManagerRoot() {
  return path.resolve(env.FILE_MANAGER_ROOT);
}

function assertSafeDomainName(domain: string) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    const error = new Error("Invalid domain folder name");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
}

export async function ensureDomainFileStructure(domain: string) {
  const normalizedDomain = domain.trim().toLowerCase();
  assertSafeDomainName(normalizedDomain);

  const root = fileManagerRoot();
  const domainRoot = path.resolve(root, normalizedDomain);
  const insideRoot = domainRoot === root || domainRoot.startsWith(`${root}${path.sep}`);
  if (!insideRoot) {
    const error = new Error("Domain folder escapes file manager root");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  await fs.mkdir(domainRoot, { recursive: true });
  await Promise.all(domainDefaultFolders.map((folder) => fs.mkdir(path.join(domainRoot, folder), { recursive: true })));
  await fs.mkdir(path.join(domainRoot, "public_html", ".well-known"), { recursive: true });

  const indexPath = path.join(domainRoot, "public_html", "index.html");
  await fs.writeFile(
    indexPath,
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${normalizedDomain}</title>
  </head>
  <body>
    <h1>${normalizedDomain}</h1>
  </body>
</html>
`,
    { flag: "wx" }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });

  return {
    domain: normalizedDomain,
    root: domainRoot,
    relativeRoot: normalizedDomain,
    folders: domainDefaultFolders
  };
}
