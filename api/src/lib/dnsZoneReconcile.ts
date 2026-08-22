import { publishDomainDnsZone } from "./domainDnsPublish.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";
import { sysagent } from "./sysagent.js";

export async function reconcileManagedDnsZones() {
  const domains = await prisma.domain.findMany({
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true }
  });
  const healthy: string[] = [];
  const repaired: string[] = [];
  const failed: Array<{ domain: string; error: string }> = [];

  for (const domain of domains) {
    try {
      const status = await sysagent.dnsZoneStatus(domain.name);
      if (status.ok) {
        healthy.push(domain.name);
        continue;
      }
      await publishDomainDnsZone(domain.id);
      const verified = await sysagent.dnsZoneStatus(domain.name);
      if (!verified.ok) throw new Error("zone remained unavailable after republish");
      repaired.push(domain.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ domain: domain.name, error: message });
      logger.warn("managed DNS zone reconciliation failed", { domain: domain.name, error: message });
    }
  }

  if (failed.length) {
    throw Object.assign(new Error(`Managed DNS reconciliation failed for ${failed.length} domain(s)`), {
      result: { checked: domains.length, healthy: healthy.length, repaired, failed }
    });
  }
  return { checked: domains.length, healthy: healthy.length, repaired, failed };
}
