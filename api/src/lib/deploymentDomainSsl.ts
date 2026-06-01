import type { Job } from "bullmq";
import type { DeploymentFramework } from "@prisma/client";
import { nodeStartUsesVitePreview } from "./deploymentDetection.js";
import { prisma } from "./prisma.js";
import { env } from "../config/env.js";
import path from "node:path";
import { sysagent } from "./sysagent.js";

export type BoundDomain = {
  id: string;
  name: string;
  forceSsl: boolean;
  sslEnabled?: boolean;
  parentDomainId?: string;
  documentRoot?: string | null;
  includeWww?: boolean;
};

export function boundDomainFromBinding(binding: {
  domain?: BoundDomain | null;
  subdomain?: { id: string; name: string; sslEnabled: boolean; domainId: string; domain: { name: string; documentRoot?: string | null } } | null;
}): BoundDomain | null {
  if (binding.subdomain) {
    return {
      id: `subdomain:${binding.subdomain.id}`,
      parentDomainId: binding.subdomain.domainId,
      name: `${binding.subdomain.name}.${binding.subdomain.domain.name}`,
      forceSsl: binding.subdomain.sslEnabled,
      sslEnabled: binding.subdomain.sslEnabled,
      documentRoot: binding.subdomain.domain.documentRoot,
      includeWww: false
    };
  }
  if (binding.domain) {
    return {
      ...binding.domain,
      forceSsl: binding.domain.forceSsl ?? true,
      sslEnabled: binding.domain.sslEnabled ?? false
    };
  }
  return null;
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
  return {
    sslCertificate: `/etc/letsencrypt/live/${domain.name}/fullchain.pem`,
    sslCertificateKey: `/etc/letsencrypt/live/${domain.name}/privkey.pem`
  };
}

export async function deploymentHttpsReady(domain: BoundDomain | null) {
  if (!domain?.name) return false;
  try {
    const status = await sysagent.certificateExists(domain.name);
    return Boolean(status.exists);
  } catch {
    return false;
  }
}

export async function deploymentSslCertificatePathsWhenReady(domain: BoundDomain | null) {
  if (!domain || !(await deploymentHttpsReady(domain))) return {};
  return deploymentSslCertificatePaths(domain);
}

export function deploymentFallbackRootPath(domain: BoundDomain | null) {
  if (!domain?.name) return null;
  const documentRoot = (domain.documentRoot || "public_html").replace(/^\/+|\/+$/g, "") || "public_html";
  return path.join(env.FILE_MANAGER_ROOT, domain.name, documentRoot);
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
  const subdomainBindings = await prisma.deploymentDomain.findMany({
    where: { subdomainId: { not: null } },
    include: {
      deployment: true,
      subdomain: { include: { domain: true } }
    }
  });
  const subdomainHit = subdomainBindings.find(
    (binding) => binding.subdomain && `${binding.subdomain.name}.${binding.subdomain.domain.name}` === fqdn
  );
  if (subdomainHit?.deployment) {
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
  return { deployment, domain, subdomainId: null as string | null, includeWww: true };
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
    loopbackProxyHost: nodeStartUsesVitePreview(input.startCommand),
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
}) {
  const bound: BoundDomain = {
    id: input.fqdn,
    name: input.fqdn.split(" ")[0] ?? input.fqdn,
    forceSsl: input.forceHttps,
    sslEnabled: input.forceHttps
  };
  const httpsReady = input.forceHttps ? await deploymentHttpsReady(bound) : false;
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
      ...(httpsReady ? deploymentSslCertificatePaths(bound) : {})
    })
  );
}

export async function ensureAcmeWebroot(domain: BoundDomain | null) {
  if (!domain?.name) return;
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
