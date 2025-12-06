import fs from "fs";
import path from "path";
import os from "os";
import { ConfigSchema, type Config } from "../types/config.js";
import { PATHS } from "../constants/paths.js";
import { createLogger } from "../utils/logger.js";

// Lazy logger to respect LOG_LEVEL set at runtime
const getLogger = () => createLogger("config");

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
        `Run 'bounty-net init' to create a default config.`,
    );
  }

  getLogger().info(`Loading config from ${foundPath}`);

  // Load and parse
  const raw = fs.readFileSync(foundPath, "utf-8");
  let json = JSON.parse(raw);

  // Migrate old config format to new format
  json = migrateConfig(json);

  // Find which identities are actually used (default identity or all if none specified)
  const usedIdentities = new Set<string>();
  if (json.defaultIdentity) {
    usedIdentities.add(json.defaultIdentity);
  } else {
    // If no default, all identities could be used
    for (const name of Object.keys(json.identities || {})) {
      usedIdentities.add(name);
    }
  }

  // Only resolve env vars for used identities
  const interpolated = interpolateEnvSelective(json, usedIdentities);

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

/**
 * Migrate old config format (reporter/maintainer sections) to new format (defaultIdentity/defaultDeposit)
 */
function migrateConfig(json: Record<string, unknown>): Record<string, unknown> {
  let migrated = false;

  // Migrate reporter.identity -> defaultIdentity
  if (json.reporter && typeof json.reporter === "object") {
    const reporter = json.reporter as Record<string, unknown>;
    if (reporter.identity && !json.defaultIdentity) {
      json.defaultIdentity = reporter.identity;
      migrated = true;
    }
    if (reporter.defaultDeposit && !json.defaultDeposit) {
      json.defaultDeposit = reporter.defaultDeposit;
      migrated = true;
    }
    delete json.reporter;
  }

  // Remove maintainer section (no longer needed)
  if (json.maintainer) {
    delete json.maintainer;
    migrated = true;
  }

  if (migrated) {
    getLogger().info("Migrated config from old format to new format");
  }

  return json;
}

function interpolateEnvSelective(
  obj: unknown,
  usedIdentities: Set<string>,
  currentPath: string[] = [],
): unknown {
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
    return obj.map((item, i) =>
      interpolateEnvSelective(item, usedIdentities, [
        ...currentPath,
        String(i),
      ]),
    );
  }

  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const newPath = [...currentPath, key];

      // Skip unused identities
      if (
        currentPath.length === 1 &&
        currentPath[0] === "identities" &&
        !usedIdentities.has(key)
      ) {
        result[key] = value; // Keep as-is without resolving env vars
        continue;
      }

      result[key] = interpolateEnvSelective(value, usedIdentities, newPath);
    }
    return result;
  }

  return obj;
}

export function createDefaultConfig(): object {
  return {
    identities: {},
    relays: ["wss://nostr-relay.testnet.unicity.network"],
    aggregatorUrl: "https://goggregator-test.unicity.network",
    database: "~/.bounty-net/bounty-net.db",
    defaultDeposit: 100,
  };
}

export function saveConfig(config: object, configPath: string): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  getLogger().info(`Config saved to ${configPath}`);
}
