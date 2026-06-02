import { prisma } from "./prisma.js";
import { sysagent } from "./sysagent.js";
import { env } from "../config/env.js";
import { renderZone } from "../routes/dns.js";

async function syncVanityNameserverRecords(domainId: string, domainName: string) {
  const nameServers = await prisma.nameServer.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { hostname: "asc" }]
  });

  for (const nameServer of nameServers) {
    if (!nameServer.hostname.endsWith(`.${domainName}`)) continue;

    const label = nameServer.hostname.slice(0, -(domainName.length + 1));
    const nsValue = `${nameServer.hostname}.`;
    const existingNs = await prisma.dnsRecord.findFirst({
      where: { domainId, type: "NS", name: "@", value: nsValue }
    });
    if (!existingNs) {
      await prisma.dnsRecord.create({ data: { domainId, type: "NS", name: "@", value: nsValue, ttl: 3600 } });
    }

    if (nameServer.ipv4) {
      const existingA = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name: label } });
      if (existingA) {
        await prisma.dnsRecord.update({ where: { id: existingA.id }, data: { value: nameServer.ipv4, ttl: 3600 } });
      } else {
        await prisma.dnsRecord.create({ data: { domainId, type: "A", name: label, value: nameServer.ipv4, ttl: 3600 } });
      }
    }

    if (nameServer.ipv6) {
      const existingAaaa = await prisma.dnsRecord.findFirst({ where: { domainId, type: "AAAA", name: label } });
      if (existingAaaa) {
        await prisma.dnsRecord.update({ where: { id: existingAaaa.id }, data: { value: nameServer.ipv6, ttl: 3600 } });
      } else {
        await prisma.dnsRecord.create({ data: { domainId, type: "AAAA", name: label, value: nameServer.ipv6, ttl: 3600 } });
      }
    }
  }
}

async function ensureDefaultApexRecords(domainId: string) {
  const apex = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name: "@" } });
  if (!apex) {
    await prisma.dnsRecord.create({ data: { domainId, type: "A", name: "@", value: env.VPS_IP, ttl: 3600 } });
  } else if (apex.value !== env.VPS_IP) {
    await prisma.dnsRecord.update({ where: { id: apex.id }, data: { value: env.VPS_IP, ttl: 3600 } });
  }

  const www = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name: "www" } });
  if (!www) {
    await prisma.dnsRecord.create({ data: { domainId, type: "A", name: "www", value: env.VPS_IP, ttl: 3600 } });
  } else if (www.value !== env.VPS_IP) {
    await prisma.dnsRecord.update({ where: { id: www.id }, data: { value: env.VPS_IP, ttl: 3600 } });
  }
}

export async function publishDomainDnsZone(domainId: string) {
  const domainMeta = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, select: { name: true } });
  await syncVanityNameserverRecords(domainId, domainMeta.name);
  await ensureDefaultApexRecords(domainId);

  const domain = await prisma.domain.findUniqueOrThrow({
    where: { id: domainId },
    include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
  });
  const zone = renderZone(domain.name, domain.dnsRecords);
  return sysagent.applyDnsZone({ domain: domain.name, zone });
}
