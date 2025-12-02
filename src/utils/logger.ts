import pino, { type Logger } from "pino";

let _logger: Logger | null = null;
let _loggerLevel: string | null = null;

function getLogger(): Logger {
  const currentLevel = process.env.LOG_LEVEL ?? "info";

  // Recreate logger if level changed
  if (!_logger || _loggerLevel !== currentLevel) {
    _loggerLevel = currentLevel;
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
  return _logger;
}

export const logger = new Proxy({} as Logger, {
  get(_, prop) {
    return (getLogger() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export function createLogger(name: string) {
  return getLogger().child({ name });
}
