import { certificateNamesCoverHost } from "./deploymentDomainSsl.js";

type CertificateLike = {
  exists?: boolean;
  expiry?: string | null;
  names?: string[];
};

type ServedCertificateLike = {
  exists?: boolean;
  matches?: boolean;
  names?: string[];
  subject?: string | null;
  issuer?: string | null;
  notAfter?: string | null;
  error?: string | null;
};

type DnsHostLike = {
  dnsStatus?: string | null;
  lastError?: string | null;
};

export function sslExpiryStatus(expiry: Date | null) {
  if (!expiry) return { state: "missing" as const, daysRemaining: null as number | null, alert: false };
  const daysRemaining = Math.ceil((expiry.getTime() - Date.now()) / 86_400_000);
  return {
    state: daysRemaining < 0 ? "expired" as const : daysRemaining < 14 ? "expiring" as const : "valid" as const,
    daysRemaining,
    alert: daysRemaining < 14
  };
}

export function sslHostStatus(host: string, cert: CertificateLike | null, served?: ServedCertificateLike | null, dns?: DnsHostLike | null) {
  const dnsStatus = dns?.dnsStatus ?? null;
  const dnsNotReady = dnsStatus === "PENDING" || dnsStatus === "MISMATCH";
  const certExists = Boolean(cert?.exists);
  const certificateMatches = certExists && certificateNamesCoverHost(host, cert?.names ?? []);
  const expiry = certificateMatches && cert?.expiry ? new Date(cert.expiry) : null;
  const expiryState = sslExpiryStatus(expiry);
  const servedKnown = served !== undefined;
  const servedMatches = !servedKnown || Boolean(served?.exists && certificateNamesCoverHost(host, served.names ?? []));
  const sslEnabled = Boolean(certificateMatches && expiryState.state !== "expired" && servedMatches && !dnsNotReady);

  let status = "VALID";
  let message = "Live certificate matches this hostname.";
  let action = "No action needed.";

  if (dnsNotReady) {
    status = "DNS_PENDING";
    message = dns?.lastError || `${host} DNS is not pointing to this VPS yet.`;
    action = "Update DNS at the registrar or wait for propagation, then retry SSL.";
  } else if (!certExists) {
    status = "CERT_MISSING";
    message = "No reusable certificate was found for this hostname.";
    action = "Issue certificate after DNS is ready.";
  } else if (!certificateMatches) {
    status = "CERT_SAN_MISMATCH";
    message = `Certificate exists, but SAN does not cover ${host}.`;
    action = "Renew or issue a certificate that includes this exact hostname.";
  } else if (expiryState.state === "expired") {
    status = "CERT_EXPIRED";
    message = "Certificate is expired.";
    action = "Renew certificate.";
  } else if (!servedMatches) {
    status = "HTTPS_ROUTE_MISMATCH";
    message = served?.exists
      ? `Nginx is serving a different certificate${served.subject ? ` (${served.subject})` : ""}.`
      : served?.error || "Nginx is not serving a certificate for this hostname.";
    action = "Republish the HTTPS vhost or let Guardian auto-heal reissue and reload Nginx.";
  } else if (expiryState.state === "expiring") {
    status = "CERT_EXPIRING";
    message = `Certificate is expiring in ${expiryState.daysRemaining} days.`;
    action = "Renew certificate soon.";
  }

  return {
    host,
    sslEnabled,
    sslExpiry: sslEnabled ? expiry : null,
    status,
    message,
    action,
    dnsStatus,
    servedSubject: served?.subject ?? null,
    servedIssuer: served?.issuer ?? null,
    servedNames: served?.names ?? [],
    ...sslExpiryStatus(sslEnabled ? expiry : null)
  };
}
