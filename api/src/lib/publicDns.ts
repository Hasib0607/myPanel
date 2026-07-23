import dns from "node:dns/promises";
import { env } from "../config/env.js";
import { currentVpsIp } from "./serverIp.js";

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

const DNS_TYPE_A = 1;
const DNS_TYPE_NS = 2;
const DNS_RCODE_SERVFAIL = 2;
const LETS_ENCRYPT_CA = "letsencrypt.org";

function resolverList() {
  return env.DOMAIN_NAMESERVER_RESOLVERS.split(",").map((resolver) => resolver.trim()).filter(Boolean);
}

function dohUrlList() {
  return env.DOMAIN_NAMESERVER_DOH_URLS.split(",").map((url) => url.trim()).filter(Boolean);
}

function normalizeNameServer(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function defaultVanityNameServerHostnames(domain: string) {
  return [`ns1.${domain}`, `ns2.${domain}`];
}

async function resolveWithDoh(hostname: string, recordType: "A" | "NS", errors: string[]) {
  const typeCode = recordType === "A" ? DNS_TYPE_A : DNS_TYPE_NS;

  for (const baseUrl of dohUrlList()) {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", String(typeCode));
      const response = await fetch(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5000)
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json") && !contentType.includes("application/dns-json")) {
        errors.push(`${baseUrl}: non-JSON response`);
        continue;
      }
      const body = await response.json() as DnsJsonResponse;
      if (body.Status === DNS_RCODE_SERVFAIL) {
        errors.push(`${baseUrl}: SERVFAIL`);
        continue;
      }
      const records = (body.Answer ?? [])
        .filter((answer) => answer.type === typeCode && answer.data)
        .map((answer) => (recordType === "A" ? answer.data ?? "" : normalizeNameServer(answer.data ?? "")))
        .filter(Boolean);
      if (records.length > 0) {
        return recordType === "NS" ? [...new Set(records)].sort() : records;
      }
      errors.push(`${baseUrl}: status ${body.Status ?? response.status}`);
    } catch (error) {
      errors.push(`${baseUrl}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  }

  return recordType === "A" ? [] : [];
}

async function resolveWithResolvers<T>(
  lookup: (resolver: dns.Resolver) => Promise<T>,
  onError: (resolverAddress: string, error: unknown) => void
) {
  for (const resolverAddress of resolverList()) {
    const resolver = new dns.Resolver();
    resolver.setServers([resolverAddress]);
    try {
      return await lookup(resolver);
    } catch (error) {
      onError(resolverAddress, error);
    }
  }
  return null;
}

export async function resolvePublicA(hostname: string) {
  const errors: string[] = [];

  const resolverRecords = await resolveWithResolvers(
    async (resolver) => {
      const records = await resolver.resolve4(hostname);
      if (records.length > 0) return records;
      throw new Error("empty");
    },
    (resolverAddress, error) => {
      errors.push(`${resolverAddress}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  );
  if (resolverRecords) return resolverRecords;

  const dohRecords = await resolveWithDoh(hostname, "A", errors);
  if (dohRecords.length > 0) return dohRecords;

  try {
    const records = await dns.resolve4(hostname);
    if (records.length > 0) return records;
  } catch (error) {
    errors.push(`system: ${error instanceof Error ? error.message : "lookup failed"}`);
  }

  throw Object.assign(new Error(formatMissingARecordError(hostname, errors)), { statusCode: 400 });
}

export type PublicCaaRecord = {
  critical?: number;
  tag?: string;
  value?: string;
  issue?: string;
  issuewild?: string;
  iodef?: string;
};

function normalizeCaaValue(value: string) {
  return value.trim().toLowerCase().replace(/^"|"$/g, "");
}

function caaAuthorizesLetsEncrypt(value: string | undefined) {
  const normalized = normalizeCaaValue(value ?? "");
  if (!normalized || normalized === ";") return false;
  return normalized.split(";")[0]?.trim() === LETS_ENCRYPT_CA;
}

function caaLookupNames(hostname: string) {
  const clean = hostname.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  const labels = clean.split(".").filter(Boolean);
  const names = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    names.push(labels.slice(index).join("."));
  }
  return names;
}

function normalizeCaaRecords(records: PublicCaaRecord[]) {
  return records.map((record) => {
    const tag = (record.tag ?? (record.issue !== undefined ? "issue" : record.issuewild !== undefined ? "issuewild" : record.iodef !== undefined ? "iodef" : "")).toLowerCase();
    const value = record.value ?? record.issue ?? record.issuewild ?? record.iodef ?? "";
    return { tag, value: normalizeCaaValue(value) };
  });
}

export function evaluateLetsEncryptCaaRecords(records: PublicCaaRecord[], options: { wildcard?: boolean } = {}) {
  const normalized = normalizeCaaRecords(records);
  const issue = normalized.filter((record) => record.tag === "issue");
  const issueWild = normalized.filter((record) => record.tag === "issuewild");
  const relevant = options.wildcard && issueWild.length > 0 ? issueWild : issue;
  if (relevant.length === 0) return { allowed: true, reason: "No CAA issue restriction found." };
  if (relevant.some((record) => caaAuthorizesLetsEncrypt(record.value))) {
    return { allowed: true, reason: "CAA allows Let's Encrypt." };
  }
  const values = relevant.map((record) => record.value || "(empty)").join(", ");
  return {
    allowed: false,
    reason: `CAA blocks Let's Encrypt. Current ${options.wildcard && issueWild.length > 0 ? "issuewild" : "issue"} values: ${values}. Add issue "letsencrypt.org" or remove the blocking CAA record.`
  };
}

export async function checkLetsEncryptCaa(hostname: string, options: { wildcard?: boolean } = {}) {
  const errors: string[] = [];
  for (const lookupName of caaLookupNames(hostname)) {
    try {
      const records = await dns.resolveCaa(lookupName);
      if (records.length === 0) continue;
      const result = evaluateLetsEncryptCaaRecords(records as PublicCaaRecord[], options);
      return {
        hostname,
        lookupName,
        allowed: result.allowed,
        records,
        message: result.allowed ? `CAA at ${lookupName} allows Let's Encrypt.` : `${result.reason} Found at ${lookupName}.`
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENODOMAIN" || code === "SERVFAIL") {
        errors.push(`${lookupName}: ${error instanceof Error ? error.message : "lookup failed"}`);
        continue;
      }
      errors.push(`${lookupName}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  }
  return {
    hostname,
    lookupName: null as string | null,
    allowed: true,
    records: [] as PublicCaaRecord[],
    message: errors.length ? `No blocking CAA record found. Lookup notes: ${errors.join("; ")}` : "No CAA record found; Let's Encrypt is allowed."
  };
}

export type PublicNameServerLookup = {
  nameServers: string[];
  errors: string[];
};

export async function resolvePublicNameServers(domain: string): Promise<PublicNameServerLookup> {
  const errors: string[] = [];

  const resolverRecords = await resolveWithResolvers(
    async (resolver) => {
      const records = await resolver.resolveNs(domain);
      if (records.length > 0) {
        return records.map((nameServer) => normalizeNameServer(nameServer)).sort();
      }
      throw new Error("empty");
    },
    (resolverAddress, error) => {
      errors.push(`${resolverAddress}: ${error instanceof Error ? error.message : "lookup failed"}`);
    }
  );
  if (resolverRecords) return { nameServers: resolverRecords, errors };

  const dohRecords = await resolveWithDoh(domain, "NS", errors);
  if (dohRecords.length > 0) return { nameServers: dohRecords, errors };

  try {
    const records = await dns.resolveNs(domain);
    if (records.length > 0) {
      return {
        nameServers: records.map((nameServer) => normalizeNameServer(nameServer)).sort(),
        errors
      };
    }
  } catch (error) {
    errors.push(`system: ${error instanceof Error ? error.message : "lookup failed"}`);
  }

  return { nameServers: [], errors };
}

async function resolveNameServersFromParentZone(domain: string) {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return [];

  const parentZone = labels.slice(1).join(".");
  let parentNameServers: string[] = [];
  try {
    parentNameServers = await dns.resolveNs(parentZone);
  } catch {
    return [];
  }

  const parentIps: string[] = [];
  for (const host of parentNameServers) {
    try {
      parentIps.push(...await dns.resolve4(host));
    } catch {
      // Try the next parent nameserver host.
    }
  }
  if (parentIps.length === 0) return [];

  const resolver = new dns.Resolver();
  resolver.setServers([...new Set(parentIps)]);
  try {
    const records = await resolver.resolveNs(domain);
    return records.map((nameServer) => normalizeNameServer(nameServer)).sort();
  } catch {
    return [];
  }
}

async function resolveAuthoritativeA(hostname: string, nameserverIp: string) {
  const resolver = new dns.Resolver();
  resolver.setServers([nameserverIp]);
  try {
    const records = await resolver.resolve4(hostname);
    return records.length > 0 ? records : [];
  } catch {
    return [];
  }
}

function isServfailError(errors: string[]) {
  return errors.some((entry) => /servfail/i.test(entry));
}

function formatMissingARecordError(hostname: string, errors: string[]) {
  return `No public A record found for ${hostname}. Resolver checks: ${errors.join("; ")}`;
}

export async function diagnosePublicDnsFailure(
  hostname: string,
  errors: string[],
  knownVanityNameServers: string[] = []
) {
  if (!isServfailError(errors)) return null;

  const apex = hostname.includes(".") ? hostname.split(".").slice(-2).join(".") : hostname;
  if (apex !== hostname && !hostname.endsWith(`.${apex}`)) return null;

  const domain = apex;
  const [{ nameServers, errors: nsErrors }, parentNameServers] = await Promise.all([
    resolvePublicNameServers(domain),
    resolveNameServersFromParentZone(domain)
  ]);
  const delegationErrors = [...errors, ...nsErrors];

  const vanityNameServers = [...new Set([
    ...nameServers.filter((nameServer) => nameServer.endsWith(`.${domain}`)),
    ...parentNameServers.filter((nameServer) => nameServer.endsWith(`.${domain}`)),
    ...knownVanityNameServers.map((nameServer) => normalizeNameServer(nameServer)).filter((nameServer) => nameServer.endsWith(`.${domain}`))
  ])].sort();

  if (vanityNameServers.length === 0) {
    if (isServfailError(delegationErrors)) {
      return [
        `Public DNS cannot resolve ${hostname} (SERVFAIL).`,
        "If this domain uses child nameservers (for example ns1.example.com on the same VPS), add glue records at your registrar.",
        "Otherwise confirm the domain is registered, nameservers point to this server, and click Publish on the domain DNS page.",
        `Resolver checks: ${errors.join("; ")}`
      ].join(" ");
    }
    return null;
  }

  const vpsIp = await currentVpsIp();
  const localChecks = await Promise.all(
    vanityNameServers.map(async (nameServer) => ({
      nameServer,
      records: await resolveAuthoritativeA(nameServer, vpsIp)
    }))
  );
  const missingGlue = localChecks.filter((check) => !check.records.includes(vpsIp));
  const glueHosts = vanityNameServers.join(", ");

  if (missingGlue.length === vanityNameServers.length) {
    return [
      `Public DNS cannot resolve ${domain} because child nameserver glue is missing for ${glueHosts}.`,
      `At your domain registrar, add glue (register nameserver) records: ${vanityNameServers.map((nameServer) => `${nameServer} -> ${vpsIp}`).join("; ")}.`,
      "Then in this panel open the domain DNS page, click Publish, and use Nameservers -> Sync records so ns1/ns2 A records exist in the zone.",
      `Resolver checks: ${errors.join("; ")}`
    ].join(" ");
  }

  return [
    `Public DNS returns SERVFAIL for ${hostname}. The zone on this VPS looks correct, but registrar glue for ${glueHosts} may still be missing or propagating.`,
    `Confirm glue records at your registrar point to ${vpsIp}, then retry Issue Certificate in a few minutes.`,
    `Resolver checks: ${errors.join("; ")}`
  ].join(" ");
}

export async function assertPublicARecordPointsTo(
  hostname: string,
  expectedIp: string,
  options: { knownVanityNameServers?: string[] } = {}
) {
  let records: string[];
  let resolverErrors: string[] = [];

  try {
    records = await resolvePublicA(hostname);
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 400 && error instanceof Error) {
      resolverErrors = error.message.includes("Resolver checks:")
        ? [error.message.split("Resolver checks: ")[1] ?? error.message]
        : [error.message];
      const diagnosis = await diagnosePublicDnsFailure(hostname, resolverErrors, options.knownVanityNameServers);
      if (diagnosis) {
        throw Object.assign(new Error(diagnosis), { statusCode: 400 });
      }
    }
    throw error;
  }

  if (!records.includes(expectedIp)) {
    throw Object.assign(
      new Error(`${hostname} A record must point to this VPS (${expectedIp}). Current A records: ${records.join(", ") || "none"}`),
      { statusCode: 400 }
    );
  }

  return records;
}
