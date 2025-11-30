import fs from "fs";
import { PATHS } from "../constants/paths.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("daemon-process");

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

export function checkSingleton(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PATHS.DAEMON_PID)) {
    return { running: false };
  }

  const pidStr = fs.readFileSync(PATHS.DAEMON_PID, "utf-8").trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    // Invalid PID file - remove it
    fs.unlinkSync(PATHS.DAEMON_PID);
    return { running: false };
  }

  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }

  // Stale PID file - process died without cleanup
  logger.warn(`Removing stale PID file (process ${pid} not running)`);
  fs.unlinkSync(PATHS.DAEMON_PID);
  return { running: false };
}

export function writePidFile(): void {
  // Ensure directory exists
  fs.mkdirSync(PATHS.BASE_DIR, { recursive: true });
  fs.writeFileSync(PATHS.DAEMON_PID, process.pid.toString());
  logger.info(`PID file written: ${PATHS.DAEMON_PID} (${process.pid})`);
}

export function removePidFile(): void {
  try {
    if (fs.existsSync(PATHS.DAEMON_PID)) {
      fs.unlinkSync(PATHS.DAEMON_PID);
      logger.info("PID file removed");
    }
  } catch (error) {
    logger.warn(`Failed to remove PID file: ${error}`);
  }
}

export function setupCleanup(): void {
  const cleanup = () => {
    logger.info("Received shutdown signal");
    removePidFile();
    process.exit(0);
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("exit", () => {
    removePidFile();
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    removePidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${reason}`);
  });
}
