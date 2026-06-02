import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { sysagent } from "./sysagent.js";

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

export const subdomainDefaultFolders = [
];
const legacySubdomainFolders = [
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

function assertSafeSubdomainName(subdomain: string) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(subdomain)) {
    const error = new Error("Invalid subdomain folder name");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
}

function isPermissionError(error: unknown) {
  return error instanceof Error && "code" in error && ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM");
}

async function createDomainFileStructureLocally(normalizedDomain: string, domainRoot: string) {
  await fs.mkdir(domainRoot, { recursive: true });
  await Promise.all(domainDefaultFolders.map((folder) => fs.mkdir(path.join(domainRoot, folder), { recursive: true })));
  await fs.mkdir(path.join(domainRoot, "public_html", ".well-known", "acme-challenge"), { recursive: true });

  return {
    domain: normalizedDomain,
    root: domainRoot,
    relativeRoot: normalizedDomain,
    folders: domainDefaultFolders
  };
}

async function createSubdomainFileStructureLocally(parentDomain: string, subdomain: string, subdomainRoot: string) {
  await fs.mkdir(subdomainRoot, { recursive: true });
  await Promise.all(subdomainDefaultFolders.map((folder) => fs.mkdir(path.join(subdomainRoot, folder), { recursive: true })));
  await fs.mkdir(path.join(subdomainRoot, ".well-known", "acme-challenge"), { recursive: true });
  await Promise.all(legacySubdomainFolders.map((folder) => fs.rm(path.join(subdomainRoot, folder), { recursive: true, force: true })));

  const fqdn = `${subdomain}.${parentDomain}`;
  return {
    domain: parentDomain,
    subdomain,
    fqdn,
    root: subdomainRoot,
    relativeRoot: path.posix.join(parentDomain, "subdomains", subdomain),
    folders: subdomainDefaultFolders
  };
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

  try {
    return await createDomainFileStructureLocally(normalizedDomain, domainRoot);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    const result = await sysagent.createDomainScaffold({ domain: normalizedDomain });
    if (result.dryRun) {
      const dryRunError = new Error("Sysagent live file manager operations are disabled. Set ALLOW_LIVE_FILE_MANAGER=true and restart vps-panel-sysagent.");
      (dryRunError as Error & { statusCode?: number }).statusCode = 503;
      throw dryRunError;
    }
    return {
      domain: result.domain,
      root: result.root,
      relativeRoot: result.relativeRoot,
      folders: result.folders
    };
  }
}

export async function ensureSubdomainFileStructure(parentDomain: string, subdomain: string) {
  const normalizedDomain = parentDomain.trim().toLowerCase();
  const normalizedSubdomain = subdomain.trim().toLowerCase();
  assertSafeDomainName(normalizedDomain);
  assertSafeSubdomainName(normalizedSubdomain);

  await ensureDomainFileStructure(normalizedDomain);
  const root = fileManagerRoot();
  const relativeRoot = path.posix.join(normalizedDomain, "subdomains", normalizedSubdomain);
  const subdomainRoot = path.resolve(root, relativeRoot);
  const insideRoot = subdomainRoot === root || subdomainRoot.startsWith(`${root}${path.sep}`);
  if (!insideRoot) {
    const error = new Error("Subdomain folder escapes file manager root");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  try {
    return await createSubdomainFileStructureLocally(normalizedDomain, normalizedSubdomain, subdomainRoot);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    const result = await sysagent.createSubdomainScaffold({ domain: normalizedDomain, subdomain: normalizedSubdomain });
    if (result.dryRun) {
      const dryRunError = new Error("Sysagent live file manager operations are disabled. Set ALLOW_LIVE_FILE_MANAGER=true and restart vps-panel-sysagent.");
      (dryRunError as Error & { statusCode?: number }).statusCode = 503;
      throw dryRunError;
    }
    return {
      domain: result.domain,
      subdomain: result.subdomain,
      fqdn: result.fqdn,
      root: result.root,
      relativeRoot: result.relativeRoot,
      folders: result.folders
    };
  }
}
