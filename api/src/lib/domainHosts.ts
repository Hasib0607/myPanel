import { prisma } from "./prisma.js";
import { checkLetsEncryptCaa, resolvePublicA } from "./publicDns.js";
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

type SubdomainRef = {
  id: string;
  name: string;
  sslEnabled?: boolean | null;
  domain: {
    id: string;
    name: string;
  };
};

export function subdomainHostName(subdomain: SubdomainRef) {
  return `${subdomain.name.trim().toLowerCase().replace(/\.$/, "")}.${subdomain.domain.name.trim().toLowerCase().replace(/\.$/, "")}`;
}

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

export async function syncSubdomainHostRow(subdomain: SubdomainRef) {
  const hostname = subdomainHostName(subdomain);
  return prisma.domainHost.upsert({
    where: { domainId_hostname: { domainId: subdomain.domain.id, hostname } },
    update: {
      subdomainId: subdomain.id,
      kind: "CUSTOM"
    },
    create: {
      domainId: subdomain.domain.id,
      subdomainId: subdomain.id,
      hostname,
      kind: "CUSTOM",
      sslEnabled: Boolean(subdomain.sslEnabled),
      sslStatus: subdomain.sslEnabled ? "PENDING" as any : "MISSING" as any
    }
  });
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

export function subdomainSslHostCoverage(subdomain: SubdomainRef, certificate: CertificateLike | null | undefined) {
  const hostname = subdomainHostName(subdomain);
  const expiryDate = certificate?.expiry ? new Date(certificate.expiry) : null;
  const expired = expiryDate ? expiryDate.getTime() <= Date.now() : false;
  const covered = Boolean(certificate?.exists && certificateNamesCoverHost(hostname, certificate.names ?? []));
  const sslEnabled = covered && !expired;
  return {
    host: hostname,
    hostname,
    kind: "CUSTOM" as const,
    sslEnabled,
    covered,
    expiry: sslEnabled ? certificate?.expiry ?? null : null,
    sslStatus: sslEnabled ? "VALID" : covered && expired ? "EXPIRED" : subdomain.sslEnabled ? "PENDING" : "MISSING"
  };
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

export async function refreshSubdomainHostSsl(subdomain: SubdomainRef, certificate?: CertificateLike | null) {
  await syncSubdomainHostRow(subdomain);
  const cert = certificate === undefined
    ? await sysagent.certificateFindReusable(subdomainHostName(subdomain)).catch(() => null)
    : certificate;
  const coverage = subdomainSslHostCoverage(subdomain, cert);
  const now = new Date();
  await prisma.domainHost.update({
    where: { domainId_hostname: { domainId: subdomain.domain.id, hostname: coverage.hostname } },
    data: {
      subdomainId: subdomain.id,
      sslEnabled: coverage.sslEnabled,
      sslStatus: coverage.sslStatus as any,
      sslExpiry: coverage.sslEnabled && coverage.expiry ? new Date(coverage.expiry) : null,
      lastCheckedAt: now,
      lastError: coverage.sslEnabled ? null : cert?.exists ? "Certificate SAN does not cover this hostname." : "No matching certificate."
    }
  });
  await prisma.subdomain.update({
    where: { id: subdomain.id },
    data: { sslEnabled: coverage.sslEnabled }
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
      if (status === "READY" && domain.forceSsl) {
        const caa = await checkLetsEncryptCaa(host.hostname, { wildcard: isWildcardHostname(host.hostname) });
        if (!caa.allowed) {
          status = "MISMATCH";
          error = caa.message;
        }
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

export async function refreshSubdomainHostDns(subdomain: SubdomainRef, expectedIp?: string) {
  const row = await syncSubdomainHostRow(subdomain);
  const targetIp = expectedIp ?? await currentVpsIp();
  const now = new Date();
  let records: string[] = [];
  let status: "READY" | "PENDING" | "MISMATCH" = "PENDING";
  let error: string | null = null;
  try {
    records = await resolvePublicA(row.hostname);
    status = records.includes(targetIp) ? "READY" : "MISMATCH";
    if (status === "MISMATCH") {
      error = `${row.hostname} resolves to ${records.join(", ") || "no A record"}, expected ${targetIp}.`;
    }
    if (status === "READY" && subdomain.sslEnabled) {
      const caa = await checkLetsEncryptCaa(row.hostname, { wildcard: isWildcardHostname(row.hostname) });
      if (!caa.allowed) {
        status = "MISMATCH";
        error = caa.message;
      }
    }
  } catch (caught) {
    status = "PENDING";
    error = caught instanceof Error ? caught.message : "Public DNS lookup failed.";
  }
  await prisma.domainHost.update({
    where: { domainId_hostname: { domainId: subdomain.domain.id, hostname: row.hostname } },
    data: {
      dnsStatus: status as any,
      dnsRecords: records,
      lastCheckedAt: now,
      lastError: error
    }
  });
  return { hostname: row.hostname, kind: "CUSTOM" as const, dnsStatus: status, records, expectedIp: targetIp, error };
}
