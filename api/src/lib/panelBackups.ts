import { z } from "zod";
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

export async function runPanelBackup(input: unknown, request?: any) {
  const body = backupSchema.parse(input ?? {});
  const settings = await getBackupSettings();
  const includes = Object.entries(body)
    .filter(([key, value]) => key.startsWith("include") && value === true)
    .map(([key]) => key);
  const record = await prisma.panelBackup.create({
    data: { label: body.label, status: "RUNNING", includes, startedAt: new Date() }
  });

  try {
    const result = await sysagent.createBackup(body);
    let uploadResult: Awaited<ReturnType<typeof sysagent.uploadBackupToRemote>> | null = null;
    if (result.result.returncode === 0 && !result.result.dryRun && settings.remoteProvider === "GOOGLE_DRIVE" && settings.remoteTarget) {
      const googleDrive = await googleDriveConfig(settings);
      uploadResult = await sysagent.uploadBackupToRemote({ path: result.archivePath, remoteTarget: settings.remoteTarget, googleDrive });
      await sysagent.pruneRemoteBackups({ remoteTarget: settings.remoteTarget, keepLast: settings.retentionKeepLast, googleDrive });
    }
    await sysagent.pruneBackups({ keep_last: settings.retentionKeepLast });

    const ok = result.result.returncode === 0 && (!uploadResult || uploadResult.result.returncode === 0);
    const updated = await prisma.panelBackup.update({
      where: { id: record.id },
      data: {
        status: ok ? "SUCCEEDED" : "FAILED",
        archivePath: result.archivePath,
        sizeBytes: result.sizeBytes ?? null,
        includes: result.includes,
        result: { ...result, remote: uploadResult, settings: { remoteProvider: settings.remoteProvider, remoteTarget: settings.remoteTarget } } as any,
        finishedAt: new Date()
      }
    });
    if (request) {
      await audit(request, { action: "CREATE", resource: "panel_backup", resourceId: updated.id, description: `Created panel backup ${body.label}` });
    }
    return updated;
  } catch (error) {
    const updated = await prisma.panelBackup.update({
      where: { id: record.id },
      data: { status: "FAILED", result: { error: error instanceof Error ? error.message : String(error) } as any, finishedAt: new Date() }
    });
    if (request) {
      await audit(request, { action: "CREATE", resource: "panel_backup", resourceId: updated.id, description: `Panel backup ${body.label} failed` });
    }
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 500, record: updated });
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
