import path from "node:path";
import { DeploymentFramework } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sysagent, type SysagentCommandResult } from "../lib/sysagent.js";
import {
  boundDomainFromBinding,
  deploymentFallbackRootPath,
  deploymentIsRoutable,
  deploymentServerName,
  publishDeploymentProxyNginx
} from "../lib/deploymentDomainSsl.js";
import { certbotCertificateName } from "../lib/nginxNames.js";

function assertCommand(action: string, result: SysagentCommandResult | undefined) {
  if (!result) throw new Error(`${action} did not return a command result`);
  if (result.dryRun) throw new Error(`${action} did not run live`);
  if (result.returncode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${action} failed${detail ? `: ${detail}` : ""}`);
  }
}

function assertPublished(action: string, result: Record<string, unknown>) {
  if (!result.rolledBack) return;
  const postReloadCheck = result.postReloadCheck as { stderr?: string; stdout?: string } | undefined;
  const detail = [postReloadCheck?.stderr, postReloadCheck?.stdout].filter(Boolean).join("\n").trim();
  throw new Error(`${action} rolled back${detail ? `: ${detail}` : ""}`);
}

function splitSubdomainFqdn(fqdn: string) {
  const normalized = fqdn.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#:]/)[0]?.replace(/\.$/, "");
  if (!normalized || !normalized.includes(".")) throw new Error("Pass a subdomain FQDN like *.example.com or app.example.com");
  if (normalized.startsWith("*.")) return { name: "*", parent: normalized.slice(2), fqdn: normalized };
  const [name, ...parentParts] = normalized.split(".");
  return { name, parent: parentParts.join("."), fqdn: normalized };
}

function deploymentAppPath(deployment: { rootPath: string; rootDirectory?: string | null }) {
  const rootDirectory = (deployment.rootDirectory || ".").replace(/^\/+|\/+$/g, "");
  return rootDirectory && rootDirectory !== "." ? path.join(deployment.rootPath, rootDirectory) : deployment.rootPath;
}

async function main() {
  const target = splitSubdomainFqdn(process.argv[2] ?? "");
  const subdomain = await prisma.subdomain.findFirstOrThrow({
    where: {
      name: target.name,
      domain: { name: target.parent }
    },
    include: { domain: true }
  });
  const domainName = `${subdomain.name}.${subdomain.domain.name}`;
  const certificate = await sysagent.certificateFindReusable(certbotCertificateName(domainName));
  if (!certificate.exists) {
    throw new Error(`No reusable certificate found for ${domainName}. Issue SSL first, then rerun this repair.`);
  }

  await prisma.subdomain.update({
    where: { id: subdomain.id },
    data: { sslEnabled: true }
  });

  const bindings = await prisma.deploymentDomain.findMany({
    where: { subdomainId: subdomain.id },
    include: {
      deployment: true,
      subdomain: { include: { domain: true } },
      domain: true
    }
  });
  if (bindings.length === 0) {
    throw new Error(`${domainName} is not bound to any deployment. Add it to the project first.`);
  }

  const repaired = [];
  for (const binding of bindings) {
    if (!deploymentIsRoutable(binding.deployment)) {
      repaired.push({ deployment: binding.deployment.slug, skipped: true, reason: `Deployment status is ${binding.deployment.status}` });
      continue;
    }
    const bound = boundDomainFromBinding(binding);
    const serverName = deploymentServerName(bound);
    if (!bound || !serverName) continue;

    const result = await publishDeploymentProxyNginx({
      deploymentId: binding.deployment.id,
      fqdn: serverName,
      upstreamPort: binding.deployment.port,
      rootPath: deploymentAppPath(binding.deployment),
      framework: binding.deployment.framework as DeploymentFramework,
      startCommand: binding.deployment.startCommand,
      publicDirectory: binding.deployment.publicDirectory,
      outputDirectory: binding.deployment.outputDirectory,
      fallbackRootPath: deploymentFallbackRootPath(bound),
      forceHttps: true,
      requireSsl: true,
      sslCertificate: certificate.certificate,
      sslCertificateKey: certificate.privateKey
    });
    assertCommand("Nginx test", result.test as SysagentCommandResult);
    assertCommand("Nginx reload", result.reload as SysagentCommandResult);
    assertPublished("Nginx publish", result);
    repaired.push({
      deployment: binding.deployment.slug,
      domain: bound.name,
      serverName,
      certificate: certificate.domain,
      route: result.serverName,
      configPath: result.configPath
    });
  }

  console.log(JSON.stringify({ ok: true, target: domainName, repaired }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
