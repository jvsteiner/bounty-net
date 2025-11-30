import fs from "fs";
import path from "path";
import os from "os";
import { ConfigSchema, type Config } from "../types/config.js";
import { PATHS } from "../constants/paths.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("config");

const CONFIG_PATHS = [
  "./bounty-net.json",
  PATHS.CONFIG,
  path.join(os.homedir(), ".config/bounty-net/config.json"),
];

export async function loadConfig(configPath?: string): Promise<Config> {
  // Use provided path or find config file
  let foundPath: string | null = configPath ?? null;

  if (!foundPath) {
    for (const p of CONFIG_PATHS) {
      if (fs.existsSync(p)) {
        foundPath = p;
        break;
      }
    }
  }

  if (!foundPath) {
    throw new Error(
      `Config file not found. Create one at: ${CONFIG_PATHS[0]}\n` +
        `Run 'bounty-net init' to create a default config.`
    );
  }

  logger.info(`Loading config from ${foundPath}`);

  // Load and parse
  const raw = fs.readFileSync(foundPath, "utf-8");
  const json = JSON.parse(raw);

  // Interpolate environment variables
  const interpolated = interpolateEnv(json);

  // Validate with Zod
  const result = ConfigSchema.safeParse(interpolated);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${errors}`);
  }

  return result.data;
}

function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Handle env: prefix
    if (obj.startsWith("env:")) {
      const envVar = obj.slice(4);
      const value = process.env[envVar];
      if (!value) {
        throw new Error(`Environment variable not set: ${envVar}`);
      }
      return value;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(interpolateEnv);
  }

  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnv(value);
    }
    return result;
  }

  return obj;
}

export function createDefaultConfig(): object {
  return {
    identities: {
      personal: {
        privateKey: "env:BOUNTY_NET_PERSONAL_KEY",
        nametag: "",
      },
    },
    relays: ["wss://nostr-relay.testnet.unicity.network"],
    database: "~/.bounty-net/bounty-net.db",
    reporter: {
      enabled: true,
      identity: "personal",
      defaultDeposit: 100,
      maxReportsPerHour: 10,
    },
    maintainer: {
      enabled: false,
      inboxes: [],
    },
  };
}

export function saveConfig(config: object, configPath: string): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  logger.info(`Config saved to ${configPath}`);
}
