import { prisma } from "./prisma.js";
import { resolvePublicA } from "./publicDns.js";
import { currentVpsIp } from "./serverIp.js";
import { sysagent } from "./sysagent.js";
import { certificateNamesCoverHost } from "./deploymentDomainSsl.js";
import { isWildcardHostname } from "./nginxNames.js";

type CertificateLike = {
  exists?: boolean;
  expiry?: string | null;
  names?: string[];
};

type DomainRef = {
  id: string;
  name: string;
  forceSsl?: boolean | null;
};

export function managedDomainHostnames(domainName: string, includeWww = true) {
  const clean = domainName.trim().toLowerCase().replace(/\.$/, "");
  if (!clean) return [];
  if (isWildcardHostname(clean)) return [{ hostname: clean, kind: "CUSTOM" as const }];
  const hosts: Array<{ hostname: string; kind: "APEX" | "WWW" | "CUSTOM" }> = [{ hostname: clean, kind: "APEX" }];
  if (includeWww && clean.split(".").filter(Boolean).length <= 2) {
    hosts.push({ hostname: `www.${clean}`, kind: "WWW" as const });
  }
  return hosts;
}

export async function syncDomainHostRows(domain: DomainRef, options?: { includeWww?: boolean }) {
  const desired = managedDomainHostnames(domain.name, options?.includeWww ?? true);
  const rows = [];
  for (const host of desired) {
    const row = await prisma.domainHost.upsert({
      where: { domainId_hostname: { domainId: domain.id, hostname: host.hostname } },
      update: { kind: host.kind },
      create: {
        domainId: domain.id,
        hostname: host.hostname,
        kind: host.kind
      }
    });
    rows.push(row);
  }
  return rows;
}

export function sslHostCoverage(domain: { name: string; forceSsl?: boolean | null }, certificate: CertificateLike | null | undefined) {
  const expiryDate = certificate?.expiry ? new Date(certificate.expiry) : null;
  const expired = expiryDate ? expiryDate.getTime() <= Date.now() : false;
  return managedDomainHostnames(domain.name).map((host) => {
    const covered = Boolean(certificate?.exists && certificateNamesCoverHost(host.hostname, certificate.names ?? []));
    const sslEnabled = covered && !expired;
    return {
      host: host.hostname,
      hostname: host.hostname,
      kind: host.kind,
      sslEnabled,
      covered,
      expiry: sslEnabled ? certificate?.expiry ?? null : null,
      sslStatus: sslEnabled ? "VALID" : covered && expired ? "EXPIRED" : domain.forceSsl ? "PENDING" : "MISSING"
    };
  });
}

export async function refreshDomainHostSsl(domain: DomainRef, certificate?: CertificateLike | null) {
  await syncDomainHostRows(domain);
  const cert = certificate === undefined
    ? await sysagent.certificateFindReusable(domain.name).catch(() => null)
    : certificate;
  const coverage = sslHostCoverage(domain, cert);
  const now = new Date();
  await Promise.all(coverage.map((host) =>
    prisma.domainHost.update({
      where: { domainId_hostname: { domainId: domain.id, hostname: host.hostname } },
      data: {
        sslEnabled: host.sslEnabled,
        sslStatus: host.sslStatus as any,
        sslExpiry: host.sslEnabled && host.expiry ? new Date(host.expiry) : null,
        lastCheckedAt: now,
        lastError: host.sslEnabled ? null : cert?.exists ? "Certificate SAN does not cover this hostname." : "No matching certificate."
      }
    })
  ));
  const allValid = coverage.length > 0 && coverage.every((host) => host.sslEnabled);
  await prisma.domain.update({
    where: { id: domain.id },
    data: {
      sslEnabled: allValid,
      sslExpiry: allValid && cert?.expiry ? new Date(cert.expiry) : null
    }
  });
  return coverage;
}

export async function refreshDomainHostDns(domain: DomainRef, expectedIp?: string) {
  await syncDomainHostRows(domain);
  const targetIp = expectedIp ?? await currentVpsIp();
  const now = new Date();
  const results = [];
  for (const host of managedDomainHostnames(domain.name)) {
    let records: string[] = [];
    let status: "READY" | "PENDING" | "MISMATCH" = "PENDING";
    let error: string | null = null;
    try {
      records = await resolvePublicA(host.hostname);
      status = records.includes(targetIp) ? "READY" : "MISMATCH";
      if (status === "MISMATCH") {
        error = `${host.hostname} resolves to ${records.join(", ") || "no A record"}, expected ${targetIp}.`;
      }
    } catch (caught) {
      status = "PENDING";
      error = caught instanceof Error ? caught.message : "Public DNS lookup failed.";
    }
    await prisma.domainHost.update({
      where: { domainId_hostname: { domainId: domain.id, hostname: host.hostname } },
      data: {
        dnsStatus: status as any,
        dnsRecords: records,
        lastCheckedAt: now,
        lastError: error
      }
    });
    results.push({ hostname: host.hostname, kind: host.kind, dnsStatus: status, records, expectedIp: targetIp, error });
  }
  return results;
}
