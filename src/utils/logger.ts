import pino, { type Logger, type DestinationStream } from "pino";
import fs from "fs";
import { PATHS } from "../constants/paths.js";

let _logger: Logger | null = null;
let _loggerLevel: string | null = null;
let _loggerMode: string | null = null;
let _logStream: DestinationStream | null = null;

function getLogger(): Logger {
  const currentLevel = process.env.LOG_LEVEL ?? "info";
  // DAEMON_MODE is set when running as background daemon
  const currentMode = process.env.DAEMON_MODE ?? "default";

  // Recreate logger if level or mode changed
  if (!_logger || _loggerLevel !== currentLevel || _loggerMode !== currentMode) {
    _loggerLevel = currentLevel;
    _loggerMode = currentMode;

    // In daemon mode, write synchronously to the log file
    // Transport workers don't inherit redirected file descriptors, so we write directly
    if (currentMode === "true") {
      _logStream = fs.createWriteStream(PATHS.DAEMON_LOG, { flags: "a" });
      _logger = pino(
        {
          level: currentLevel,
        },
        _logStream,
      );
      // Log that we're in daemon mode (this should appear in the log file)
      _logger.info({ name: "logger" }, `Logger initialized in daemon mode, writing to ${PATHS.DAEMON_LOG}`);
    } else {
      // For CLI/MCP server, use stderr via transport
      _logger = pino({
        level: currentLevel,
        transport:
          process.env.NODE_ENV !== "production"
            ? {
                target: "pino/file",
                options: { destination: 2 }, // stderr (important for MCP servers)
              }
            : undefined,
      });
    }
  }
  return _logger;
}

/**
 * Get the current log stream (for child loggers in daemon mode)
 */
export function getLogStream(): DestinationStream | undefined {
  getLogger(); // Ensure logger is initialized
  return _logStream ?? undefined;
}

export const logger = new Proxy({} as Logger, {
  get(_, prop) {
    return (getLogger() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export function createLogger(name: string) {
  return getLogger().child({ name });
}
