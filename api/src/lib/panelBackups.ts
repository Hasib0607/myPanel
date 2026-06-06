import { z } from "zod";
import path from "node:path";
import { audit } from "./audit.js";
import { prisma } from "./prisma.js";
import { getSecret, putSecret } from "./secrets.js";
import { sysagent } from "./sysagent.js";

export const backupSchema = z.object({
  label: z.string().trim().min(1).max(80).default("manual"),
  appDir: z.string().trim().default("/opt/vps-panel"),
  includeApp: z.boolean().default(true),
  includeEnv: z.boolean().default(true),
  includeDatabase: z.boolean().default(true),
  includeAccounts: z.boolean().default(true),
  includeDeployments: z.boolean().default(true),
  includeNginx: z.boolean().default(true),
  includeDns: z.boolean().default(true),
  includeMail: z.boolean().default(true),
  includeSsl: z.boolean().default(true),
  includeLogs: z.boolean().default(false),
  excludePatterns: z.array(z.string()).default(["node_modules", ".next/cache", "cache", "tmp", "*.log"]),
  encryptPassphrase: z.string().optional()
});

export const backupSettingsSchema = z.object({
  scheduleEnabled: z.boolean().default(true),
  timezone: z.string().default("Asia/Dhaka"),
  scheduleTimes: z.array(z.string()).default(["11:01", "23:01"]),
  retentionKeepLast: z.number().int().min(1).max(500).default(2),
  remoteProvider: z.enum(["NONE", "GOOGLE_DRIVE", "S3", "R2", "B2", "SFTP"]).default("GOOGLE_DRIVE"),
  remoteTarget: z.string().default("mypanel-drive:vps-panel-backups"),
  googleDriveAuthMode: z.enum(["SERVICE_ACCOUNT", "OAUTH_REFRESH_TOKEN", "RCLONE_REMOTE"]).default("SERVICE_ACCOUNT"),
  googleDriveFolderId: z.string().default(""),
  googleDriveTeamDriveId: z.string().default(""),
  googleDriveClientIdConfigured: z.boolean().default(false),
  googleDriveClientSecretConfigured: z.boolean().default(false),
  googleDriveRefreshTokenConfigured: z.boolean().default(false),
  googleDriveServiceAccountConfigured: z.boolean().default(false),
  encryptionEnabled: z.boolean().default(false)
});

export type BackupSettings = z.infer<typeof backupSettingsSchema>;

type SysagentResultEnvelope = {
  result?: {
    dryRun?: boolean;
    liveCommandsDisabled?: boolean;
    returncode?: number;
    stderr?: string;
    stdout?: string;
  };
};

type BackupProgress = { phase: string; percent: number; message: string; result?: unknown };
type BackupProgressHandler = (progress: BackupProgress) => Promise<void> | void;

const googleSecretRefs = {
  clientId: "panel-backup:google-drive:client-id",
  clientSecret: "panel-backup:google-drive:client-secret",
  refreshToken: "panel-backup:google-drive:refresh-token",
  serviceAccountJson: "panel-backup:google-drive:service-account-json"
};

const backupSettingsInputSchema = backupSettingsSchema.extend({
  googleDriveClientId: z.string().optional(),
  googleDriveClientSecret: z.string().optional(),
  googleDriveRefreshToken: z.string().optional(),
  googleDriveServiceAccountJson: z.string().optional()
}).omit({
  googleDriveClientIdConfigured: true,
  googleDriveClientSecretConfigured: true,
  googleDriveRefreshTokenConfigured: true,
  googleDriveServiceAccountConfigured: true
});

async function googleConfiguredFlags() {
  const [clientId, clientSecret, refreshToken, serviceAccountJson] = await Promise.all([
    getSecret(googleSecretRefs.clientId),
    getSecret(googleSecretRefs.clientSecret),
    getSecret(googleSecretRefs.refreshToken),
    getSecret(googleSecretRefs.serviceAccountJson)
  ]);
  return {
    googleDriveClientIdConfigured: Boolean(clientId),
    googleDriveClientSecretConfigured: Boolean(clientSecret),
    googleDriveRefreshTokenConfigured: Boolean(refreshToken),
    googleDriveServiceAccountConfigured: Boolean(serviceAccountJson)
  };
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const settings = await prisma.guardianSetting.findUnique({ where: { key: "panel_backup_settings" } });
  const raw = (settings?.value ?? {}) as any;
  const flags = await googleConfiguredFlags();
  if (raw && !Array.isArray(raw.scheduleTimes)) {
    return backupSettingsSchema.parse({
      ...raw,
      scheduleEnabled: true,
      scheduleTimes: ["11:01", "23:01"],
      retentionKeepLast: 2,
      remoteProvider: raw.remoteProvider && raw.remoteProvider !== "NONE" ? raw.remoteProvider : "GOOGLE_DRIVE",
      remoteTarget: raw.remoteTarget || "mypanel-drive:vps-panel-backups",
      timezone: raw.timezone || "Asia/Dhaka",
      ...flags
    });
  }
  return backupSettingsSchema.parse({ ...raw, ...flags });
}

export async function saveBackupSettings(value: unknown) {
  const input = backupSettingsInputSchema.parse(value ?? {});
  await Promise.all([
    input.googleDriveClientId?.trim() ? putSecret({ ref: googleSecretRefs.clientId, value: input.googleDriveClientId.trim(), kind: "GENERIC", label: "Panel backup Google Drive client ID" }) : null,
    input.googleDriveClientSecret?.trim() ? putSecret({ ref: googleSecretRefs.clientSecret, value: input.googleDriveClientSecret.trim(), kind: "GENERIC", label: "Panel backup Google Drive client secret" }) : null,
    input.googleDriveRefreshToken?.trim() ? putSecret({ ref: googleSecretRefs.refreshToken, value: input.googleDriveRefreshToken.trim(), kind: "GENERIC", label: "Panel backup Google Drive refresh token" }) : null,
    input.googleDriveServiceAccountJson?.trim() ? putSecret({ ref: googleSecretRefs.serviceAccountJson, value: input.googleDriveServiceAccountJson.trim(), kind: "GENERIC", label: "Panel backup Google Drive service account JSON" }) : null
  ]);
  const flags = await googleConfiguredFlags();
  const body = backupSettingsSchema.parse({ ...input, ...flags });
  return prisma.guardianSetting.upsert({
    where: { key: "panel_backup_settings" },
    update: { value: body as any },
    create: { key: "panel_backup_settings", value: body as any }
  });
}

export async function googleDriveConfig(settings: BackupSettings) {
  if (settings.remoteProvider !== "GOOGLE_DRIVE" || settings.googleDriveAuthMode === "RCLONE_REMOTE") return null;
  return {
    authMode: settings.googleDriveAuthMode,
    folderId: settings.googleDriveFolderId,
    teamDriveId: settings.googleDriveTeamDriveId,
    clientId: await getSecret(googleSecretRefs.clientId),
    clientSecret: await getSecret(googleSecretRefs.clientSecret),
    refreshToken: await getSecret(googleSecretRefs.refreshToken),
    serviceAccountJson: await getSecret(googleSecretRefs.serviceAccountJson)
  };
}

function backupCommandError(action: string, envelope: SysagentResultEnvelope) {
  const result = envelope.result;
  if (!result) return null;
  if (result.dryRun || result.liveCommandsDisabled) {
    return `${action} did not run on the server. Set ALLOW_LIVE_BACKUP=true on vps-panel-sysagent, then restart vps-panel-sysagent and vps-panel-workers.`;
  }
  if (result.returncode !== 0) {
    return result.stderr?.trim() || result.stdout?.trim() || `${action} failed with exit code ${result.returncode ?? "unknown"}.`;
  }
  return null;
}

function readableErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const jsonMatch = raw.match(/:\s*(\{.*\})$/s);
  if (!jsonMatch) return raw;
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {
    return raw;
  }
  return raw;
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function sizeToBigInt(value?: number | string | bigint | null) {
  if (typeof value === "bigint") return value > 0n ? value : null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? BigInt(Math.floor(value)) : null;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  }
  return null;
}

function formatBytes(value?: number | string | bigint | null) {
  const parsed = sizeToBigInt(value);
  if (!parsed) return "";
  const asNumber = Number(parsed);
  if (asNumber >= 1024 ** 4) return `${(asNumber / 1024 ** 4).toFixed(2)} TB`;
  if (asNumber >= 1024 ** 3) return `${(asNumber / 1024 ** 3).toFixed(2)} GB`;
  if (asNumber >= 1024 ** 2) return `${(asNumber / 1024 ** 2).toFixed(2)} MB`;
  if (asNumber >= 1024) return `${(asNumber / 1024).toFixed(1)} KB`;
  return `${parsed.toString()} B`;
}

function backupSizeForDb(value?: number | string | bigint | null) {
  return sizeToBigInt(value);
}

function panelBackupForJson<T extends { sizeBytes?: bigint | number | string | null }>(record: T): Omit<T, "sizeBytes"> & { sizeBytes: string | null } {
  return {
    ...record,
    sizeBytes: sizeToBigInt(record.sizeBytes)?.toString() ?? null
  };
}

function rcloneTransferPercent(text: string) {
  const matches = [...text.matchAll(/Transferred:\s+.*?,\s*([0-9]+(?:\.[0-9]+)?)%/gi)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  const value = Number(last);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function rcloneTransferLine(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...lines].reverse().find((line) => /Transferred:/i.test(line)) ?? "";
}

function latestRcloneLine(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...lines].reverse().find((line) => {
    if (/^Transferred:\s+0\s+B\s*\/\s*0\s+B/i.test(line)) return false;
    if (/^Checks:/i.test(line)) return false;
    if (/^Elapsed time:/i.test(line)) return false;
    return true;
  }) ?? "";
}

function safeBackupLabel(label: string) {
  return label.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "manual";
}

function backupStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function backupTarget(backupRoot: string, label: string, encrypted: boolean) {
  const safeLabel = safeBackupLabel(label);
  const stamp = backupStamp();
  const archivePath = path.posix.join(backupRoot, `mypanel-${safeLabel}-${stamp}.tar.gz`);
  return {
    archivePath,
    finalPath: encrypted ? archivePath.replace(/\.tar\.gz$/, ".tar.gz.gpg") : archivePath,
    stagingDir: path.posix.join(backupRoot, `.staging-${safeLabel}-${stamp}`)
  };
}

async function waitForCreateBackupJob(
  jobId: string,
  onProgress?: BackupProgressHandler
): Promise<Awaited<ReturnType<typeof sysagent.createBackup>>> {
  const startedAt = Date.now();
  const maxWaitMs = 6 * 60 * 60 * 1000;
  let lastError = "";
  while (Date.now() - startedAt < maxWaitMs) {
    const elapsedMs = Date.now() - startedAt;
    const job = await sysagent.backupCreateJob(jobId).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (job?.status === "SUCCEEDED" || job?.status === "FAILED") {
      return {
        archivePath: job.archivePath,
        stagingDir: job.stagingDir,
        includes: job.includes,
        sizeBytes: job.sizeBytesText ?? job.sizeBytes ?? null,
        result: job.result
      };
    }
    const currentSize = job?.sizeBytesText ?? job?.sizeBytes ?? null;
    const percent = sizeToBigInt(currentSize) ? 35 : 5;
    const size = formatBytes(currentSize);
    await onProgress?.({
      phase: "CREATING_ARCHIVE",
      percent,
      message: `${lastError ? "Server backup is still running independently; waiting for status reconnect." : "Creating archive on server."}${size ? ` Current archive size: ${size}.` : " Preparing files and database dumps."} Elapsed: ${formatElapsed(elapsedMs)}.`
    });
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`Server backup did not finish within 6 hours.${lastError ? ` Last status check: ${lastError}` : ""}`);
}

async function waitForUploadBackupJob(
  jobId: string,
  onProgress?: BackupProgressHandler
): Promise<Awaited<ReturnType<typeof sysagent.uploadBackupToRemote>>> {
  const startedAt = Date.now();
  const maxWaitMs = 2 * 60 * 60 * 1000;
  let lastError = "";
  while (Date.now() - startedAt < maxWaitMs) {
    const elapsedMs = Date.now() - startedAt;
    const job = await sysagent.backupUploadJob(jobId).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (job?.status === "SUCCEEDED" || job?.status === "FAILED") {
      return {
        archivePath: job.archivePath,
        remoteTarget: job.remoteTarget,
        remotePath: job.remotePath,
        result: job.result
      };
    }
    const transferText = `${job?.result?.stderr ?? ""}\n${job?.result?.stdout ?? ""}`;
    const transferPercent = rcloneTransferPercent(transferText);
    const transferLine = rcloneTransferLine(transferText);
    const latestLine = latestRcloneLine(transferText);
    const percent = transferPercent === null ? 56 : Math.min(89, Math.max(56, Math.floor(56 + transferPercent * 0.33)));
    const detail = transferLine
      ? transferLine
      : latestLine
        ? `Latest rclone log: ${latestLine}`
        : "Waiting for rclone transfer stats";
    await onProgress?.({
      phase: "UPLOADING",
      percent,
      message: `${lastError ? "Google Drive upload is still running independently; waiting for status reconnect." : "Google Drive upload job is running."} ${detail}. Elapsed: ${formatElapsed(elapsedMs)}.`
    });
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`Google Drive upload did not finish within 2 hours.${lastError ? ` Last status check: ${lastError}` : ""}`);
}

export async function runPanelBackup(input: unknown, request?: any, onProgress?: BackupProgressHandler) {
  const body = backupSchema.parse(input ?? {});
  const settings = await getBackupSettings();
  const includes = Object.entries(body)
    .filter(([key, value]) => key.startsWith("include") && value === true)
    .map(([key]) => key);
  const record = await prisma.panelBackup.create({
    data: { label: body.label, status: "RUNNING", includes, startedAt: new Date() }
  });

  try {
    const plan = await sysagent.backupPlan();
    const target = backupTarget(plan.backupRoot, body.label, Boolean(body.encryptPassphrase));
    const createBody = { ...body, archivePath: target.archivePath, stagingDir: target.stagingDir };
    await onProgress?.({ phase: "CREATING_ARCHIVE", percent: 0, message: "Starting full server archive." });
    const createJob = await sysagent.createBackupJob(createBody);
    const result = createJob.status === "RUNNING" ? await waitForCreateBackupJob(createJob.jobId, onProgress) : {
      archivePath: createJob.archivePath,
      stagingDir: createJob.stagingDir,
      includes: createJob.includes,
      sizeBytes: createJob.sizeBytesText ?? createJob.sizeBytes ?? null,
      result: createJob.result
    };
    let uploadResult: Awaited<ReturnType<typeof sysagent.uploadBackupToRemote>> | null = null;
    const createError = backupCommandError("Backup archive creation", result);
    if (createError) {
      throw Object.assign(new Error(createError), { result });
    }
    if (!sizeToBigInt(result.sizeBytes)) {
      throw Object.assign(new Error("Backup archive was not created or is empty. Check sysagent backup logs and available disk space."), { result });
    }
    await onProgress?.({ phase: "ARCHIVE_CREATED", percent: 55, message: `Archive created${formatBytes(result.sizeBytes) ? ` (${formatBytes(result.sizeBytes)})` : ""}.`, result });
    if (settings.remoteProvider === "GOOGLE_DRIVE" && settings.remoteTarget) {
      const googleDrive = await googleDriveConfig(settings);
      await onProgress?.({ phase: "UPLOADING", percent: 56, message: "Starting Google Drive upload." });
      const uploadJob = await sysagent.uploadBackupJob({ path: result.archivePath, remoteTarget: settings.remoteTarget, googleDrive });
      uploadResult = uploadJob.status === "RUNNING" ? await waitForUploadBackupJob(uploadJob.jobId, onProgress) : {
        archivePath: uploadJob.archivePath,
        remoteTarget: uploadJob.remoteTarget,
        remotePath: uploadJob.remotePath,
        result: uploadJob.result
      };
      const uploadError = backupCommandError("Google Drive upload", uploadResult);
      if (uploadError) {
        throw Object.assign(new Error(uploadError), { result: { ...result, remote: uploadResult } });
      }
      await onProgress?.({ phase: "PRUNING_REMOTE", percent: 90, message: "Google Drive upload completed. Pruning old Drive backups.", result: uploadResult });
      await sysagent.pruneRemoteBackups({ remoteTarget: settings.remoteTarget, keepLast: settings.retentionKeepLast, googleDrive });
    }
    await onProgress?.({ phase: "PRUNING_LOCAL", percent: 95, message: "Pruning old local backups." });
    await sysagent.pruneBackups({ keep_last: settings.retentionKeepLast });

    const ok = result.result.returncode === 0 && (!uploadResult || uploadResult.result.returncode === 0);
    const updated = await prisma.panelBackup.update({
      where: { id: record.id },
      data: {
        status: ok ? "SUCCEEDED" : "FAILED",
        archivePath: result.archivePath,
        sizeBytes: backupSizeForDb(result.sizeBytes),
        includes: result.includes,
        result: { ...result, remote: uploadResult, settings: { remoteProvider: settings.remoteProvider, remoteTarget: settings.remoteTarget } } as any,
        finishedAt: new Date()
      }
    });
    const jsonUpdated = panelBackupForJson(updated);
    if (request) {
      await audit(request, { action: "CREATE", resource: "panel_backup", resourceId: updated.id, description: `Created panel backup ${body.label}` });
    }
    await onProgress?.({ phase: ok ? "SUCCEEDED" : "FAILED", percent: 100, message: ok ? "Backup completed." : "Backup finished with errors.", result: jsonUpdated });
    return jsonUpdated;
  } catch (error) {
    const message = readableErrorMessage(error);
    const updated = await prisma.panelBackup.update({
      where: { id: record.id },
      data: { status: "FAILED", result: { error: message, details: (error as any).result } as any, finishedAt: new Date() }
    });
    const jsonUpdated = panelBackupForJson(updated);
    if (request) {
      await audit(request, { action: "CREATE", resource: "panel_backup", resourceId: updated.id, description: `Panel backup ${body.label} failed` });
    }
    await onProgress?.({ phase: "FAILED", percent: 100, message, result: jsonUpdated });
    throw Object.assign(new Error(message), { statusCode: 500, record: jsonUpdated });
  }
}

export function defaultFullBackup(label: string) {
  return backupSchema.parse({
    label,
    appDir: "/opt/vps-panel",
    includeApp: true,
    includeEnv: true,
    includeDatabase: true,
    includeAccounts: true,
    includeDeployments: true,
    includeNginx: true,
    includeDns: true,
    includeMail: true,
    includeSsl: true,
    includeLogs: false
  });
}
