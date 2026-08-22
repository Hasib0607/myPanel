function normalizeNameServer(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function nameServerGroupKey(hostname: string) {
  const labels = hostname.split(".").filter(Boolean);
  return labels.length > 1 ? labels.slice(1).join(".") : hostname;
}

export function configuredNameServerGroups(hostnames: string[]) {
  const groups = new Map<string, Set<string>>();
  for (const raw of hostnames) {
    const hostname = normalizeNameServer(raw);
    if (!hostname) continue;
    const key = nameServerGroupKey(hostname);
    const group = groups.get(key) ?? new Set<string>();
    group.add(hostname);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => [...group].sort());
}

export function matchingNameServerGroup(expectedGroups: string[][], actualHostnames: string[]) {
  const actual = new Set(actualHostnames.map(normalizeNameServer).filter(Boolean));
  return expectedGroups.find((group) => group.length > 0 && group.every((hostname) => actual.has(normalizeNameServer(hostname)))) ?? null;
}

export function nameServerAlternativesText(groups: string[][]) {
  if (groups.length === 0) return "no active nameservers configured";
  return groups.map((group) => group.join(", ")).join(" OR ");
}
