import { loadConfig } from "../config/loader.js";
import { initializeDatabase, DatabaseWrapper } from "../storage/database.js";
import { IdentityManager } from "../services/identity/manager.js";
import { IpcServer } from "./ipc-server.js";
import { createCommandHandler } from "./handlers.js";
import { startSync } from "./sync.js";
import { checkSingleton, writePidFile, setupCleanup } from "./process.js";
import { createLogger } from "../utils/logger.js";
import { PATHS } from "../constants/paths.js";
import { startUiServer, UI_PORT } from "../ui/server.js";
import { getDaemonClient } from "../server/ipc-client.js";

export async function runDaemon(): Promise<void> {
  // Enable logging for daemon
  if (process.env.LOG_LEVEL === "silent") {
    process.env.LOG_LEVEL = "info";
  }
  const logger = createLogger("daemon");

  // Check singleton
  const status = checkSingleton();
  if (status.running) {
    logger.error(`Daemon already running (PID ${status.pid})`);
    process.exit(1);
  }

  // Write PID file and setup cleanup handlers
  writePidFile();
  setupCleanup();

  logger.info(`Daemon starting (PID ${process.pid})`);

  // Load config
  const config = await loadConfig();

  // Check if maintainer mode is enabled
  if (!config.maintainer?.enabled || config.maintainer.inboxes.length === 0) {
    logger.error(
      "No inboxes configured. Daemon requires maintainer.enabled=true with at least one inbox.",
    );
    process.exit(1);
  }

  // Initialize database
  const rawDb = initializeDatabase(config.database ?? PATHS.DATABASE);
  const db = new DatabaseWrapper(rawDb);

  // Initialize identity manager
  const identityManager = new IdentityManager(config);
  await identityManager.initialize();

  logger.info(`Loaded ${identityManager.listIdentities().length} identities`);

  // Start NOSTR sync for all inboxes
  await startSync(identityManager, db, config);

  // Start IPC server
  const handler = createCommandHandler(identityManager, db, config);
  const ipcServer = new IpcServer(handler);
  ipcServer.start();

  // Start UI server
  // Create an IPC client that connects back to ourselves for the UI to use
  const daemonClient = await getDaemonClient();
  startUiServer(db, identityManager, config, daemonClient);
  logger.info(`UI available at http://localhost:${UI_PORT}`);

  // Keep process alive
  logger.info("Daemon running. Press Ctrl+C to stop.");
}

export * from "./process.js";
export * from "./ipc-server.js";
export * from "./handlers.js";
export * from "./sync.js";
