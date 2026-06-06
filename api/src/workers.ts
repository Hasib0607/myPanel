import "./jobs/mailWorker.js";
import "./jobs/deployWorker.js";
import "./jobs/sslWorker.js";
import "./jobs/guardianWorker.js";
import { startBackupScheduler } from "./jobs/backupScheduler.js";
import { logger } from "./lib/logger.js";

startBackupScheduler();
logger.info("workers started");
