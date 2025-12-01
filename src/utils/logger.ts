import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino/file",
          options: { destination: 2 }, // stderr (important for MCP servers)
        }
      : undefined,
});

export function createLogger(name: string) {
  return logger.child({ name });
}
