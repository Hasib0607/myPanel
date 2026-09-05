import { prisma } from "./prisma.js";
import { resolvePublicNameServers, resolvePublicA } from "./publicDns.js";
import { currentVpsIp } from "./serverIp.js";
import { configuredNameServerGroups, matchingNameServerGroup } from "./nameServerMatching.js";

// Fail closed: DNS lookup failures must not trigger ACME attempts.
export async function sslRenewalEligibility(domain: string) {
  const name = domain.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  const configured = await prisma.nameServer.findMany({
    where: { active: true }, select: { hostname: true }
  });
  const groups = configuredNameServerGroups(configured.map((row) => row.hostname));
  if (!groups.length) return { eligible: false, reason: "No active hosting nameservers configured" };
  // Local BIND can still host an old zone after the registrar's delegation moves.
  const lookup = await resolvePublicNameServers(name, { allowSystemFallback: false });
  const matched = matchingNameServerGroup(groups, lookup.nameServers);
  // A complete configured pair is sufficient, matching the domain onboarding policy.
  // Existing zones may also advertise older hosting aliases.
  const eligible = Boolean(matched);
  return {
    eligible,
    reason: eligible ? "Hosting nameservers match" : lookup.nameServers.length
      ? `Nameservers do not match hosting: ${lookup.nameServers.join(", ")}`
      : "Public nameservers unavailable; renewal deferred"
  };
}

export async function sslHttpRenewalEligibility(hostnames: string[]) {
  const ip = await currentVpsIp();
  for (const hostname of hostnames) {
    const records = await resolvePublicA(hostname).catch(() => []);
    if (!records.includes(ip)) return { eligible: false, reason: `${hostname} is not served by this VPS (${records.join(", ") || "no public A record"}); HTTP renewal skipped` };
  }
  return { eligible: true, reason: "HTTP challenge hostnames point to this VPS" };
}
