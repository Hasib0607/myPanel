import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseParentNameServers(domain: string, output: string) {
  const expected = domain.toLowerCase().replace(/\.$/, "");
  return output.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const typeIndex = fields.findIndex((field, index) => index > 0 && field.toUpperCase() === "NS");
    if (typeIndex < 0 || fields[typeIndex - 1]?.toUpperCase() !== "IN") return [];
    if (fields[0]?.toLowerCase().replace(/\.$/, "") !== expected) return [];
    const hostname = fields[typeIndex + 1]?.toLowerCase().replace(/\.$/, "");
    return hostname && /^[a-z0-9.-]+$/.test(hostname) ? [hostname] : [];
  });
}

// Recursive NS lookups can SERVFAIL before this panel has published the zone.
// The parent registry's referral remains available and proves the delegation.
export async function resolveParentNameServers(domain: string) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let index = 1; index < labels.length; index += 1) {
    const parent = labels.slice(index).join(".");
    let servers: string[];
    try {
      servers = await dns.resolveNs(parent);
    } catch {
      continue;
    }
    const observations = await Promise.all(servers.slice(0, 4).map(async (server) => {
      try {
        const { stdout } = await execFileAsync("dig", [
          `@${server}`, domain, "NS", "+norecurse", "+noall", "+answer", "+authority", "+time=2", "+tries=1"
        ], { timeout: 3_000, maxBuffer: 64 * 1024 });
        return parseParentNameServers(domain, stdout);
      } catch {
        return [];
      }
    }));
    const records = [...new Set(observations.flat())];
    if (records.length > 0) return records.sort();
  }
  return [];
}
