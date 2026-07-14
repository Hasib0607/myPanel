import type { Job } from "bullmq";
import type { DeploymentFramework } from "@prisma/client";
import { nodeStartUsesVitePreview } from "./deploymentDetection.js";
import { prisma } from "./prisma.js";
import { env } from "../config/env.js";
import path from "node:path";
import { sysagent } from "./sysagent.js";
import { subdomainFolderName } from "./domainFiles.js";
import { certbotCertificateName, isWildcardHostname } from "./nginxNames.js";

export type BoundDomain = {
  id: string;
  name: string;
  forceSsl: boolean;
  sslEnabled?: boolean;
  parentDomainId?: string;
  documentRoot?: string | null;
  publicRootPath?: string | null;
  includeWww?: boolean;
  account?: { homeRoot?: string | null } | null;
};

function normalizeDocumentRoot(value?: string | null) {
  return (value || "public_html").replace(/^\/+|\/+$/g, "") || "public_html";
}

function publicHtmlRootPath(domainName: string, documentRoot?: string | null) {
  return path.join(env.FILE_MANAGER_ROOT, domainName, normalizeDocumentRoot(documentRoot));
}

function accountPublicRootPath(domain: { name: string; documentRoot?: string | null; account?: { homeRoot?: string | null } | null }) {
  if (domain.account?.homeRoot) {
    const documentRoot = normalizeDocumentRoot(domain.documentRoot);
    if (documentRoot === domain.name || documentRoot.startsWith(`${domain.name}/`)) {
      return path.join(domain.account.homeRoot, documentRoot);
    }
    return path.join(domain.account.homeRoot, domain.name, documentRoot);
  }
  return publicHtmlRootPath(domain.name, domain.documentRoot);
}

export function boundDomainFromBinding(binding: {
  domain?: BoundDomain | null;
  subdomain?: {
    id: string;
    name: string;
    sslEnabled: boolean;
    domainId: string;
    domain: { name: string; documentRoot?: string | null; account?: { homeRoot?: string | null } | null };
  } | null;
}): BoundDomain | null {
  if (binding.subdomain) {
    const parent = binding.subdomain.domain;
    const publicRootPath = parent.account?.homeRoot
      ? path.join(parent.account.homeRoot, "subdomains", subdomainFolderName(binding.subdomain.name))
      : path.join(env.FILE_MANAGER_ROOT, parent.name, "subdomains", subdomainFolderName(binding.subdomain.name));
    return {
      id: `subdomain:${binding.subdomain.id}`,
      parentDomainId: binding.subdomain.domainId,
      name: `${binding.subdomain.name}.${parent.name}`,
      forceSsl: binding.subdomain.sslEnabled,
      sslEnabled: binding.subdomain.sslEnabled,
      documentRoot: parent.documentRoot,
      publicRootPath,
      includeWww: false
    };
  }
  if (binding.domain) {
    return {
      ...binding.domain,
      forceSsl: binding.domain.forceSsl ?? true,
      sslEnabled: binding.domain.sslEnabled ?? false,
      publicRootPath: binding.domain.publicRootPath ?? accountPublicRootPath(binding.domain)
    };
  }
  return null;
}

export function deploymentIsRoutable(deployment: { status?: string | null } | null | undefined) {
  return deployment?.status === "RUNNING";
}

export function deploymentWantsSsl(domain: BoundDomain | null) {
  return Boolean(domain && (domain.forceSsl || domain.sslEnabled));
}

export function deploymentServerName(domain: { name: string; includeWww?: boolean } | null | undefined) {
  if (!domain?.name) return null;
  if (domain.includeWww === false) return domain.name;
  return `${domain.name} www.${domain.name}`;
}

export function deploymentSslCertificatePaths(domain: BoundDomain | null) {
  if (!domain?.name || !deploymentWantsSsl(domain)) return {};
  const certName = certbotCertificateName(domain.name);
  return {
    sslCertificate: `/etc/letsencrypt/live/${certName}/fullchain.pem`,
    sslCertificateKey: `/etc/letsencrypt/live/${certName}/privkey.pem`
  };
}

export async function deploymentHttpsReady(domain: BoundDomain | null) {
  if (!domain?.name) return false;
  try {
    const status = await sysagent.certificateFindReusable(domain.name);
    return Boolean(status.exists);
  } catch {
    return false;
  }
}

export async function deploymentSslCertificatePathsWhenReady(domain: BoundDomain | null) {
  if (!domain) return {};
  try {
    const status = await sysagent.certificateFindReusable(domain.name);
    if (!status.exists) return {};
    return {
      sslCertificate: status.certificate,
      sslCertificateKey: status.privateKey
    };
  } catch {
    return {};
  }
}

export function deploymentFallbackRootPath(domain: BoundDomain | null) {
  if (!domain?.name) return null;
  return domain.publicRootPath ?? accountPublicRootPath(domain);
}

function nginxResourceName(prefix: string, name: string) {
  return `${prefix}-${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

export async function publishPublicHtmlNginxVhost(domain: BoundDomain | null) {
  const serverName = deploymentServerName(domain);
  const rootPath = deploymentFallbackRootPath(domain);
  if (!domain?.name || !serverName || !rootPath) return null;
  const sslPaths = await deploymentSslCertificatePathsWhenReady(domain);
  const httpsReady = Boolean(sslPaths.sslCertificate && sslPaths.sslCertificateKey);
  return sysagent.writeStaticNginxVhost({
    name: nginxResourceName("domain", domain.name),
    serverName,
    rootPath,
    forceHttps: Boolean(domain.forceSsl && httpsReady),
    ...(httpsReady ? sslPaths : {})
  });
}

export async function retireDeploymentNginxRoute(deploymentId: string, domain: BoundDomain | null) {
  const serverName = deploymentServerName(domain);
  if (!domain?.name || !serverName) return null;
  return sysagent.deploymentRetireNginxRoute({
    deploymentId,
    serverName
  });
}

export async function ensureParentDomainDeploymentProxy(deploymentId: string, domain: BoundDomain | null) {
  if (!domain) return;
  const domainId = domain.id.startsWith("subdomain:") ? domain.parentDomainId : domain.id;
  if (!domainId) return;
  await prisma.domain.update({
    where: { id: domainId },
    data: {
      hostingMode: "DEPLOYMENT_PROXY",
      hostingDeploymentId: deploymentId
    }
  });
}

/** Only apex domains (example.com) should request www; subdomains like admin.example.com must not. */
export function deploymentCertbotIncludeWww(domain: BoundDomain) {
  if (domain.includeWww === false) return false;
  const labels = domain.name.split(".").filter(Boolean);
  return labels.length <= 2;
}

export function deploymentSslContactEmail(domain: BoundDomain | null) {
  if (!domain?.name) return "admin@localhost";
  const parts = domain.name.split(".").filter(Boolean);
  if (parts.length >= 2) {
    return `admin@${parts.slice(-2).join(".")}`;
  }
  return `admin@${domain.name}`;
}

export async function enableDeploymentTlsInDatabase(domain: BoundDomain) {
  if (domain.id.startsWith("subdomain:")) {
    const subdomainId = domain.id.slice("subdomain:".length);
    await prisma.subdomain.update({
      where: { id: subdomainId },
      data: { sslEnabled: true }
    });
    return { ...domain, sslEnabled: true, forceSsl: true };
  }
  await prisma.domain.update({
    where: { id: domain.id },
    data: { sslEnabled: true, forceSsl: true }
  });
  return { ...domain, sslEnabled: true, forceSsl: true };
}

export async function disableDeploymentTlsInDatabase(domain: BoundDomain, options?: { clearForceSsl?: boolean }) {
  const clearForceSsl = options?.clearForceSsl ?? false;
  if (domain.id.startsWith("subdomain:")) {
    const subdomainId = domain.id.slice("subdomain:".length);
    await prisma.subdomain.update({
      where: { id: subdomainId },
      data: { sslEnabled: false }
    });
    return { ...domain, sslEnabled: false, forceSsl: false };
  }
  await prisma.domain.update({
    where: { id: domain.id },
    data: clearForceSsl ? { sslEnabled: false, forceSsl: false } : { sslEnabled: false }
  });
  return clearForceSsl
    ? { ...domain, sslEnabled: false, forceSsl: false }
    : { ...domain, sslEnabled: false };
}

/** Clear sslEnabled when nginx must stay HTTP-only until a certificate exists. Keeps forceSsl so deploy still issues SSL. */
export async function clearStaleDeploymentSslEnabled(domain: BoundDomain) {
  if (!domain.sslEnabled) return domain;
  return disableDeploymentTlsInDatabase(domain, { clearForceSsl: false });
}

export async function syncDeploymentTlsWithCertificate(domain: BoundDomain | null) {
  if (!domain) return { domain, httpsReady: false };
  const httpsReady = await deploymentHttpsReady(domain);
  if (httpsReady) {
    return { domain: await enableDeploymentTlsInDatabase(domain), httpsReady: true };
  }
  if (domain.sslEnabled) {
    return { domain: await clearStaleDeploymentSslEnabled(domain), httpsReady: false };
  }
  return { domain, httpsReady: false };
}

export async function findDeploymentProxyTarget(fqdn: string) {
  const normalizedFqdn = fqdn.toLowerCase();
  const subdomainBindings = await prisma.deploymentDomain.findMany({
    where: { subdomainId: { not: null } },
    include: {
      deployment: true,
      subdomain: { include: { domain: true } }
    }
  });
  const subdomainHit = subdomainBindings.find(
    (binding) => binding.subdomain && subdomainBindingMatchesFqdn(binding.subdomain, normalizedFqdn)
  );
  if (subdomainHit?.deployment) {
    if (!deploymentIsRoutable(subdomainHit.deployment)) return null;
    return {
      deployment: subdomainHit.deployment,
      domain: subdomainHit.subdomain!.domain,
      subdomainId: subdomainHit.subdomainId,
      includeWww: false
    };
  }

  const apexBinding = await prisma.deploymentDomain.findFirst({
    where: { domain: { name: fqdn } },
    include: { deployment: true, domain: true }
  });
  if (apexBinding?.deployment && apexBinding.domain) {
    if (!deploymentIsRoutable(apexBinding.deployment)) return null;
    return {
      deployment: apexBinding.deployment,
      domain: apexBinding.domain,
      subdomainId: null as string | null,
      includeWww: true
    };
  }

  const domain = await prisma.domain.findFirst({
    where: { name: fqdn },
    include: {
      deployments: { orderBy: { createdAt: "desc" }, take: 1 },
      deploymentBindings: { include: { deployment: true }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] }
    }
  });
  if (!domain) return null;
  const deployment = domain.hostingDeploymentId
    ? await prisma.deployment.findUnique({ where: { id: domain.hostingDeploymentId } })
    : domain.deploymentBindings[0]?.deployment ?? domain.deployments[0] ?? null;
  if (!deployment) return null;
  if (!deploymentIsRoutable(deployment)) return null;
  return { deployment, domain, subdomainId: null as string | null, includeWww: true };
}

export function subdomainBindingMatchesFqdn(
  subdomain: { name: string; domain: { name: string } },
  fqdn: string
) {
  const normalizedFqdn = fqdn.toLowerCase();
  const parent = subdomain.domain.name.toLowerCase();
  const name = subdomain.name.toLowerCase();
  if (name === "*") {
    const suffix = `.${parent}`;
    if (!normalizedFqdn.endsWith(suffix)) return false;
    const left = normalizedFqdn.slice(0, -suffix.length);
    return Boolean(left) && !left.includes(".");
  }
  return `${name}.${parent}` === normalizedFqdn;
}

export function deploymentNginxPublicDirectory(input: {
  framework: DeploymentFramework;
  publicDirectory?: string | null;
  outputDirectory?: string | null;
}) {
  if (input.framework === "LARAVEL") return input.publicDirectory ?? "public";
  return input.outputDirectory ?? input.publicDirectory ?? "dist";
}

export function buildDeploymentNginxRequest(input: {
  deploymentId: string;
  fqdn: string;
  upstreamPort: number;
  rootPath: string;
  framework: DeploymentFramework;
  startCommand?: string | null;
  publicDirectory?: string | null;
  outputDirectory?: string | null;
  fallbackRootPath: string | null;
  forceSsl: boolean;
  requireSsl?: boolean;
  sslCertificate?: string;
  sslCertificateKey?: string;
}) {
  return {
    deploymentId: input.deploymentId,
    serverName: input.fqdn,
    upstreamPort: input.upstreamPort,
    rootPath: input.rootPath,
    framework: input.framework,
    // Vite preview rejects unknown hosts, but Next.js middleware needs the public
    // Host to construct same-origin rewrites behind an HTTPS reverse proxy.
    loopbackProxyHost: input.framework === "NODEJS" && nodeStartUsesVitePreview(input.startCommand),
    publicDirectory: deploymentNginxPublicDirectory(input),
    fallbackRootPath: input.fallbackRootPath,
    forceSsl: input.forceSsl,
    requireSsl: input.requireSsl ?? false,
    ...(input.sslCertificate && input.sslCertificateKey
      ? { sslCertificate: input.sslCertificate, sslCertificateKey: input.sslCertificateKey }
      : {})
  };
}

export async function publishDeploymentProxyNginx(input: {
  deploymentId: string;
  fqdn: string;
  upstreamPort: number;
  rootPath: string;
  framework: DeploymentFramework;
  startCommand?: string | null;
  publicDirectory?: string | null;
  outputDirectory?: string | null;
  fallbackRootPath: string | null;
  forceHttps: boolean;
  requireSsl?: boolean;
  sslCertificate?: string;
  sslCertificateKey?: string;
}) {
  const bound: BoundDomain = {
    id: input.fqdn,
    name: input.fqdn.split(" ")[0] ?? input.fqdn,
    forceSsl: input.forceHttps,
    sslEnabled: input.forceHttps
  };
  const hasExplicitCertificate = Boolean(input.sslCertificate && input.sslCertificateKey);
  const reusableSslPaths = hasExplicitCertificate || !input.forceHttps ? {} : await deploymentSslCertificatePathsWhenReady(bound);
  const httpsReady = hasExplicitCertificate || Boolean(reusableSslPaths.sslCertificate && reusableSslPaths.sslCertificateKey);
  return sysagent.deploymentNginx(
    buildDeploymentNginxRequest({
      deploymentId: input.deploymentId,
      fqdn: input.fqdn,
      upstreamPort: input.upstreamPort,
      rootPath: input.rootPath,
      framework: input.framework,
      startCommand: input.startCommand,
      publicDirectory: input.publicDirectory,
      outputDirectory: input.outputDirectory,
      fallbackRootPath: input.fallbackRootPath,
      forceSsl: input.forceHttps && httpsReady,
      requireSsl: input.requireSsl ?? false,
      ...(hasExplicitCertificate
        ? { sslCertificate: input.sslCertificate, sslCertificateKey: input.sslCertificateKey }
        : httpsReady ? reusableSslPaths : {})
    })
  );
}

export async function ensureAcmeWebroot(domain: BoundDomain | null) {
  if (!domain?.name) return;
  if (isWildcardHostname(domain.name)) return;
  await sysagent.ensureAcmeWebroot({
    domain: domain.name,
    webRoot: deploymentFallbackRootPath(domain) ?? undefined
  });
}

export async function waitForQueueJob(job: Job, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await job.getState();
    if (state === "completed") return job.returnvalue;
    if (state === "failed") throw new Error(job.failedReason ?? "SSL job failed");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("SSL job timed out");
}
