export function nodeBuildTerminatedByMemorySignal(text: string) {
  return /exit code (?:-9|-15|137|143)\b|\bSIGKILL\b|\bSIGTERM\b|OOM killer|out of memory/i.test(text);
}

export function nextMiddlewareProxyIssue(text: string) {
  const lower = text.toLowerCase();
  return lower.includes("\"middleware\" file convention is deprecated")
    || lower.includes("middleware-to-proxy")
    || (lower.includes("please use \"proxy\"") && lower.includes("middleware"));
}

export function nextMiddlewareProxyRepairEligible(text: string) {
  return nextMiddlewareProxyIssue(text) && !nodeBuildTerminatedByMemorySignal(text);
}
