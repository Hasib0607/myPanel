import { prisma } from "./prisma.js";
import { sysagent } from "./sysagent.js";
import { defaultVanityNameServerHostnames } from "./publicDns.js";
import { renderZone } from "../routes/dns.js";
import { currentVpsIp } from "./serverIp.js";

async function syncActiveNameserverRecords(domainId: string, domainName: string) {
  const vpsIp = await currentVpsIp();
  const nameServers = await prisma.nameServer.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { hostname: "asc" }]
  });

  for (const nameServer of nameServers) {
    const nsValue = `${nameServer.hostname}.`;
    const existingNs = await prisma.dnsRecord.findFirst({
      where: { domainId, type: "NS", name: "@", value: nsValue }
    });
    if (!existingNs) {
      await prisma.dnsRecord.create({ data: { domainId, type: "NS", name: "@", value: nsValue, ttl: 3600 } });
    }

    if (!nameServer.hostname.endsWith(`.${domainName}`)) continue;
    const label = nameServer.hostname.slice(0, -(domainName.length + 1));
    if (nameServer.ipv4 !== vpsIp) {
      nameServer.ipv4 = vpsIp;
      await prisma.nameServer.update({ where: { id: nameServer.id }, data: { ipv4: vpsIp } });
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

  return nameServers.length;
}

async function ensureDefaultVanityNameserverRecords(domainId: string, domainName: string) {
  const vpsIp = await currentVpsIp();
  for (const hostname of defaultVanityNameServerHostnames(domainName)) {
    const label = hostname.slice(0, -(domainName.length + 1));
    const nsValue = `${hostname}.`;
    const existingNs = await prisma.dnsRecord.findFirst({
      where: { domainId, type: "NS", name: "@", value: nsValue }
    });
    if (!existingNs) {
      await prisma.dnsRecord.create({ data: { domainId, type: "NS", name: "@", value: nsValue, ttl: 3600 } });
    }

    const existingA = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name: label } });
    if (existingA) {
      await prisma.dnsRecord.update({ where: { id: existingA.id }, data: { value: vpsIp, ttl: 3600 } });
    } else {
      await prisma.dnsRecord.create({ data: { domainId, type: "A", name: label, value: vpsIp, ttl: 3600 } });
    }
  }
}

async function removeUnconfiguredDefaultVanityNameserverRecords(domainId: string, domainName: string) {
  const activeNameservers = await prisma.nameServer.findMany({
    where: { active: true },
    select: { hostname: true }
  });
  const activeHostnames = new Set(activeNameservers.map((item) => item.hostname.toLowerCase()));

  for (const hostname of defaultVanityNameServerHostnames(domainName)) {
    if (activeHostnames.has(hostname)) continue;
    const label = hostname.slice(0, -(domainName.length + 1));
    await prisma.dnsRecord.deleteMany({
      where: {
        domainId,
        OR: [
          { type: "NS", name: "@", value: `${hostname}.` },
          { type: { in: ["A", "AAAA"] }, name: label }
        ]
      }
    });
  }
}

async function ensureDefaultApexRecords(domainId: string) {
  const vpsIp = await currentVpsIp();
  const apex = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name: "@" } });
  if (!apex) {
    await prisma.dnsRecord.create({ data: { domainId, type: "A", name: "@", value: vpsIp, ttl: 3600 } });
  } else if (apex.value !== vpsIp) {
    await prisma.dnsRecord.update({ where: { id: apex.id }, data: { value: vpsIp, ttl: 3600 } });
  }

  const www = await prisma.dnsRecord.findFirst({ where: { domainId, type: "A", name: "www" } });
  if (!www) {
    await prisma.dnsRecord.create({ data: { domainId, type: "A", name: "www", value: vpsIp, ttl: 3600 } });
  } else if (www.value !== vpsIp) {
    await prisma.dnsRecord.update({ where: { id: www.id }, data: { value: vpsIp, ttl: 3600 } });
  }
}

export async function publishDomainDnsZone(domainId: string) {
  const domainMeta = await prisma.domain.findUniqueOrThrow({ where: { id: domainId }, select: { name: true } });
  const activeNameserverCount = await syncActiveNameserverRecords(domainId, domainMeta.name);
  if (activeNameserverCount === 0) {
    await ensureDefaultVanityNameserverRecords(domainId, domainMeta.name);
  } else {
    await removeUnconfiguredDefaultVanityNameserverRecords(domainId, domainMeta.name);
  }
  await ensureDefaultApexRecords(domainId);

  const domain = await prisma.domain.findUniqueOrThrow({
    where: { id: domainId },
    include: { dnsRecords: { orderBy: [{ type: "asc" }, { name: "asc" }] } }
  });
  const zone = renderZone(domain.name, domain.dnsRecords);
  return sysagent.applyDnsZone({ domain: domain.name, zone });
}
