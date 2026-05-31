import "./jobs/mailWorker.js";
import "./jobs/deployWorker.js";
import "./jobs/sslWorker.js";
import "./jobs/guardianWorker.js";
import { logger } from "./lib/logger.js";

logger.info("workers started");
