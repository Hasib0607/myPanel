import { env } from "../config/env.js";

const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
let cachedIp: { value: string; expiresAt: number } | null = null;

function isIpv4(value: string) {
  return ipv4Pattern.test(value.trim());
}

async function detectPublicIp() {
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip"]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const value = (await response.text()).trim();
      if (response.ok && isIpv4(value)) return value;
    } catch {
      // Try the next detector, then fall back to configured VPS_IP.
    }
  }
  return null;
}

export async function currentVpsIp() {
  if (cachedIp && cachedIp.expiresAt > Date.now()) return cachedIp.value;

  const detected = await detectPublicIp();
  const fallback = isIpv4(env.VPS_IP) ? env.VPS_IP : "127.0.0.1";
  const value = detected ?? fallback;
  cachedIp = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}
