export function certificateIsUnexpired(expiry: string | null | undefined, now = Date.now()) {
  return Boolean(expiry) && new Date(expiry!).getTime() > now;
}

export function certificateIsDue(expiry: string | null | undefined, days: number, now = Date.now()) {
  return !certificateIsUnexpired(expiry, now + days * 86_400_000);
}
