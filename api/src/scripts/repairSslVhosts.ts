import path from "node:path";
import { DeploymentFramework, type Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { runDomainHostSync } from "../lib/domainHostSync.js";
import { ensureSubdomainFileStructure } from "../lib/domainFiles.js";
import {
  boundDomainFromBinding,
  certificateNamesCoverHost,
  deploymentFallbackRootPath,
  deploymentServerName,
  deploymentSslCertificatePathsWhenReady,
  publishDeploymentProxyNginx,
  publishPublicHtmlNginxVhost
} from "../lib/deploymentDomainSsl.js";
import { managedDomainHostnames, refreshDomainHostSsl, refreshSubdomainHostSsl, syncDomainHostRows, syncSubdomainHostRow, subdomainHostName } from "../lib/domainHosts.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
import { currentVpsIp } from "../lib/serverIp.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";
import { certificateLookupName, certbotCertificateName, isWildcardHostname, nginxResourceName } from "../lib/nginxNames.js";

const domainRepairInclude = {
  account: { select: { homeRoot: true } },
  deployments: { orderBy: { createdAt: "desc" as const }, take: 1 },
  deploymentBindings: { include: { deployment: true }, orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }], take: 1 }
};

type RepairDomain = Prisma.DomainGetPayload<{ include: typeof domainRepairInclude }>;

const subdomainRepairInclude = {
  domain: { select: { id: true, name: true } },
  deploymentBindings: {
    include: {
      deployment: true,
      domain: true,
      subdomain: { include: { domain: true } }
    }
  }
};

type RepairSubdomain = Prisma.SubdomainGetPayload<{ include: typeof subdomainRepairInclude }>;

function normalizeDocumentRoot(value?: string | null) {
  return (value || "public_html").replace(/^\/+|\/+$/g, "") || "public_html";
}

function deploymentAppPath(deployment: { rootPath: string; rootDirectory?: string | null }) {
  const rootDirectory = (deployment.rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return rootDirectory && rootDirectory !== "." ? path.join(deployment.rootPath, rootDirectory) : deployment.rootPath;
}

function commandFailed(result: unknown) {
  const row = result as SysagentCommandResult | undefined;
  return row && typeof row.returncode === "number" && row.returncode !== 0;
}

function assertPublish(label: string, result: Record<string, unknown> | null | undefined) {
  if (!result) return;
  const failure = commandFailed(result.test) ? result.test : commandFailed(result.reload) ? result.reload : null;
  if (failure) {
    const row = failure as SysagentCommandResult;
    const detail = [row.stderr, row.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const domainNames = new Set<string>();
  let limit = Number(process.env.REPAIR_SSL_VHOST_LIMIT || 5000);
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--limit=")) limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--domain=")) domainNames.add(arg.slice("--domain=".length).trim().toLowerCase());
    else if (arg.trim()) domainNames.add(arg.trim().toLowerCase());
  }
  return { domainNames: [...domainNames].filter(Boolean), limit: Math.min(Math.max(limit || 5000, 1), 20_000), dryRun };
}

async function staticSubdomainSslPaths(fqdn: string, wantsSsl: boolean) {
  if (!wantsSsl && !isWildcardHostname(fqdn)) return {};
  const lookup = isWildcardHostname(fqdn) ? certbotCertificateName(fqdn) : fqdn;
  const cert = await sysagent.certificateFindReusable(lookup).catch(() => null);
  if (!cert?.exists || !certificateNamesCoverHost(fqdn, cert.names ?? [])) return {};
  return { sslCertificate: cert.certificate, sslCertificateKey: cert.privateKey };
}

function deploymentCanBeRepairedAsProxy(deployment: { status?: string | null; port?: number | null } | null | undefined) {
  if (!deployment?.port) return false;
  return deployment.status !== "STOPPED" && deployment.status !== "FAILED";
}

async function repairDomain(domain: RepairDomain, dryRun: boolean) {
  await syncDomainHostRows(domain);
  const sslPaths = await deploymentSslCertificatePathsWhenReady({
    id: domain.id,
    name: domain.name,
    forceSsl: domain.forceSsl,
    sslEnabled: domain.sslEnabled,
    documentRoot: domain.documentRoot,
    account: domain.account,
    includeWww: true
  });
  const httpsReady = Boolean(sslPaths.sslCertificate && sslPaths.sslCertificateKey);
  const serverName = managedDomainHostnames(domain.name).map((host) => host.hostname).join(" ") || domain.name;
  if (dryRun) {
    return { domain: domain.name, mode: domain.hostingMode, serverName, httpsReady, dryRun: true };
  }

  let result: Record<string, unknown> | null = null;
  if (domain.hostingMode === "DEPLOYMENT_PROXY") {
    const deployment = domain.hostingDeploymentId
      ? await prisma.deployment.findUnique({ where: { id: domain.hostingDeploymentId } })
      : domain.deploymentBindings[0]?.deployment ?? domain.deployments[0] ?? null;
    if (deployment && deploymentCanBeRepairedAsProxy(deployment)) {
      result = await publishDeploymentProxyNginx({
        deploymentId: deployment.id,
        fqdn: serverName,
        upstreamPort: deployment.port,
        rootPath: deploymentAppPath(deployment),
        framework: deployment.framework as DeploymentFramework,
        startCommand: deployment.startCommand,
        publicDirectory: deployment.publicDirectory,
        outputDirectory: deployment.outputDirectory,
        fallbackRootPath: domain.account?.homeRoot
          ? path.join(domain.account.homeRoot, normalizeDocumentRoot(domain.documentRoot))
          : path.join(env.FILE_MANAGER_ROOT, domain.name, normalizeDocumentRoot(domain.documentRoot)),
        forceHttps: domain.forceSsl && httpsReady,
        requireSsl: false,
        ...sslPaths
      });
    } else {
      return { domain: domain.name, mode: domain.hostingMode, skipped: true, reason: "deployment proxy target is not repairable" };
    }
  } else if (domain.hostingMode === "REDIRECT") {
    if (!domain.redirectUrl) {
      return { domain: domain.name, mode: domain.hostingMode, skipped: true, reason: "redirect URL missing" };
    }
    result = await sysagent.writeRedirectNginxVhost({
      name: `domain-${nginxResourceName(domain.name)}`,
      serverName,
      redirectUrl: domain.redirectUrl,
      ...sslPaths
    }) as Record<string, unknown>;
  } else {
    result = await publishPublicHtmlNginxVhost({
      id: domain.id,
      name: domain.name,
      forceSsl: domain.forceSsl,
      sslEnabled: domain.sslEnabled,
      documentRoot: domain.documentRoot,
      account: domain.account,
      includeWww: true
    }) as Record<string, unknown>;
  }

  assertPublish(`domain ${domain.name}`, result);
  const cert = await sysagent.certificateFindReusable(domain.name).catch(() => null);
  const hosts = await refreshDomainHostSsl(domain, httpsReady && cert?.exists ? cert : null);
  return { domain: domain.name, mode: domain.hostingMode, serverName, httpsReady, result, hosts };
}

async function repairSubdomain(subdomain: RepairSubdomain, dryRun: boolean) {
  const fqdn = subdomainHostName(subdomain);
  await syncSubdomainHostRow(subdomain);
  const sslPaths = await staticSubdomainSslPaths(fqdn, subdomain.sslEnabled);
  const httpsReady = Boolean(sslPaths.sslCertificate && sslPaths.sslCertificateKey);
  const vpsIp = await currentVpsIp().catch(() => env.VPS_IP);
  const targetIsLocal = subdomain.target === env.VPS_IP || subdomain.target === vpsIp || subdomain.target === subdomain.domain.name || subdomain.target === fqdn;
  if (dryRun) {
    return { domain: fqdn, httpsReady, dryRun: true };
  }

  let result: Record<string, unknown> | null = null;
  const bindings = subdomain.deploymentBindings ?? [];
  const binding = bindings.find((row) => deploymentCanBeRepairedAsProxy(row.deployment));
  if (binding) {
    const bound = boundDomainFromBinding(binding);
    const serverName = deploymentServerName(bound) ?? fqdn;
    result = await publishDeploymentProxyNginx({
      deploymentId: binding.deployment.id,
      fqdn: serverName,
      upstreamPort: binding.deployment.port,
      rootPath: deploymentAppPath(binding.deployment),
      framework: binding.deployment.framework as DeploymentFramework,
      startCommand: binding.deployment.startCommand,
      publicDirectory: binding.deployment.publicDirectory,
      outputDirectory: binding.deployment.outputDirectory,
      fallbackRootPath: deploymentFallbackRootPath(bound),
      forceHttps: (subdomain.sslEnabled || isWildcardHostname(fqdn)) && httpsReady,
      requireSsl: false,
      ...sslPaths
    });
  } else if (targetIsLocal) {
    const scaffold = await ensureSubdomainFileStructure(subdomain.domain.name, subdomain.name);
    result = await sysagent.writeStaticNginxVhost({
      name: `domain-${nginxResourceName(fqdn)}`,
      serverName: fqdn,
      rootPath: path.join(env.FILE_MANAGER_ROOT, scaffold.relativeRoot),
      forceHttps: (subdomain.sslEnabled || isWildcardHostname(fqdn)) && httpsReady,
      ...sslPaths
    }) as Record<string, unknown>;
  } else {
    return { domain: fqdn, skipped: true, reason: `subdomain target is external: ${subdomain.target}` };
  }

  assertPublish(`subdomain ${fqdn}`, result);
  const cert = await sysagent.certificateFindReusable(certificateLookupName(fqdn)).catch(() => null);
  const host = await refreshSubdomainHostSsl(subdomain, httpsReady && cert?.exists ? cert : null);
  return { domain: fqdn, httpsReady, result, hosts: [host] };
}

async function main() {
  const options = parseArgs();
  const domainWhere = options.domainNames.length
    ? { name: { in: options.domainNames } }
    : { OR: [{ forceSsl: true }, { sslEnabled: true }] };
  const parentNames = options.domainNames.map((name) => name.startsWith("www.") ? name.slice(4) : name);
  const domains = await prisma.domain.findMany({
    where: domainWhere,
    take: options.limit,
    orderBy: { updatedAt: "desc" },
    include: domainRepairInclude
  });
  const subdomains = await prisma.subdomain.findMany({
    where: options.domainNames.length
      ? {
          OR: [
            { domain: { name: { in: parentNames } } },
            ...options.domainNames.map((fqdn) => {
              const [name, ...parent] = fqdn.split(".");
              return { name, domain: { name: parent.join(".") } };
            })
          ]
        }
      : { sslEnabled: true },
    take: options.limit,
    orderBy: { id: "asc" },
    include: subdomainRepairInclude
  });

  const repaired = [];
  const skipped = [];
  const errors = [];
  for (const domain of domains) {
    try {
      repaired.push(await repairDomain(domain, options.dryRun));
    } catch (error) {
      errors.push({ type: "domain", domain: domain.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const subdomain of subdomains) {
    try {
      const result = await repairSubdomain(subdomain, options.dryRun);
      if ((result as { skipped?: boolean }).skipped) skipped.push(result);
      else repaired.push(result);
    } catch (error) {
      errors.push({ type: "subdomain", domain: subdomainHostName(subdomain), error: error instanceof Error ? error.message : String(error) });
    }
  }

  const sync = options.dryRun ? null : await runDomainHostSync({ includeDns: true, queueRepair: true, limit: options.limit, domainNames: options.domainNames });
  console.log(JSON.stringify({ ok: errors.length === 0, dryRun: options.dryRun, repaired, skipped, errors, sync }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });
