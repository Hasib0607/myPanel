import { defaultFullBackup, getBackupSettings, runPanelBackup } from "../lib/panelBackups.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

const CHECK_INTERVAL_MS = 30_000;
const LAST_SLOT_KEY = "panel_backup_last_scheduled_slot";

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

async function lastSlot() {
  const row = await prisma.guardianSetting.findUnique({ where: { key: LAST_SLOT_KEY } });
  return typeof (row?.value as any)?.slot === "string" ? (row?.value as any).slot as string : "";
}

async function setLastSlot(slot: string) {
  await prisma.guardianSetting.upsert({
    where: { key: LAST_SLOT_KEY },
    update: { value: { slot } },
    create: { key: LAST_SLOT_KEY, value: { slot } }
  });
}

export async function tickBackupScheduler(now = new Date()) {
  const settings = await getBackupSettings();
  if (!settings.scheduleEnabled) return { queued: false, reason: "disabled" };

  const parts = zonedParts(now, settings.timezone);
  const time = `${parts.hour}:${parts.minute}`;
  if (!settings.scheduleTimes.includes(time)) return { queued: false, reason: "not-due", time };

  const slot = `${parts.year}-${parts.month}-${parts.day}T${time}@${settings.timezone}`;
  if (await lastSlot() === slot) return { queued: false, reason: "already-ran", slot };

  await setLastSlot(slot);
  logger.info("scheduled panel backup started", { slot });
  const record = await runPanelBackup(defaultFullBackup(`scheduled-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`));
  logger.info("scheduled panel backup finished", { slot, backupId: record.id, status: record.status });
  return { queued: true, slot, backupId: record.id, status: record.status };
}

export function startBackupScheduler() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tickBackupScheduler();
    } catch (error) {
      logger.error("scheduled panel backup failed", { error });
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(run, CHECK_INTERVAL_MS);
}
