import { sysagent } from "./sysagent.js";

let lastAttemptMs = 0;
let lastSuccessMs = 0;

export function panelUploadLimitsLastSuccessMs() {
  return lastSuccessMs;
}

export async function ensurePanelUploadLimits(force = false) {
  const now = Date.now();
  if (!force && lastSuccessMs > 0 && now - lastAttemptMs < 6 * 60 * 60 * 1000) {
    return { ok: true as const, skipped: true as const };
  }
  lastAttemptMs = now;
  try {
    const result = await sysagent.ensurePanelUploadLimits();
    lastSuccessMs = Date.now();
    return { ok: true as const, skipped: false as const, result };
  } catch (error) {
    return {
      ok: false as const,
      skipped: false as const,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
