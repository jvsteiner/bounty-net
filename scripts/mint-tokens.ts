#!/usr/bin/env npx tsx
/**
 * Mint ALPHA tokens for testing bounty-net
 *
 * This script mints test tokens on the Unicity testnet using Alphalite.
 * Tokens are stored in the identity's wallet file at ~/.bounty-net/wallets/<identity>.json
 *
 * Usage:
 *   npx tsx scripts/mint-tokens.ts --identity <name> --amount <amount>
 *
 * Environment:
 *   UNICITY_AGGREGATOR_APIKEY - API key for the aggregator (required for minting)
 *
 * Example:
 *   npx tsx scripts/mint-tokens.ts --identity jamie-bounty --amount 1000
 */

import "dotenv/config";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { Wallet, AlphaClient, RootTrustBase } from "@jvsteiner/alphalite";

// Hex-encoded coin ID for ALPHA (same as in src/constants/coins.ts)
const ALPHA_COIN_ID = "414c504841";

// Constants
const BOUNTY_NET_DIR = join(homedir(), ".bounty-net");
const CONFIG_PATH = join(BOUNTY_NET_DIR, "config.json");
const WALLETS_DIR = join(BOUNTY_NET_DIR, "wallets");
const TRUSTBASE_PATH = join(import.meta.dirname, "..", "src", "trustbase.json");

const DEFAULT_AGGREGATOR_URL = "https://goggregator-test.unicity.network";

interface Config {
  identities: Record<
    string,
    {
      privateKey: string;
      nametag: string;
    }
  >;
}

interface ParsedArgs {
  identity: string;
  amount: bigint;
  aggregatorUrl: string;
  apiKey: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let identity = "";
  let amount = BigInt(100); // Default amount
  let aggregatorUrl =
    process.env.UNICITY_AGGREGATOR_URL ?? DEFAULT_AGGREGATOR_URL;
  let apiKey = process.env.UNICITY_AGGREGATOR_APIKEY ?? "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--identity" && args[i + 1]) {
      identity = args[i + 1];
      i++;
    } else if (args[i] === "--amount" && args[i + 1]) {
      amount = BigInt(args[i + 1]);
      i++;
    } else if (args[i] === "--aggregator" && args[i + 1]) {
      aggregatorUrl = args[i + 1];
      i++;
    } else if (args[i] === "--api-key" && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    }
  }

  if (!identity) {
    console.error(
      "Usage: npx tsx scripts/mint-tokens.ts --identity <name> [options]",
    );
    console.error("");
    console.error("Options:");
    console.error(
      "  --identity <name>     Identity name from config.json (required)",
    );
    console.error(
      "  --amount <amount>     Amount of ALPHA tokens to mint (default: 100)",
    );
    console.error("  --aggregator <url>    Aggregator URL (default: testnet)");
    console.error(
      "  --api-key <key>       API key (or set UNICITY_AGGREGATOR_APIKEY env var)",
    );
    process.exit(1);
  }

  if (!apiKey) {
    console.error("Error: API key required for minting.");
    console.error(
      "Set UNICITY_AGGREGATOR_APIKEY in .env file or use --api-key option",
    );
    process.exit(1);
  }

  return { identity, amount, aggregatorUrl, apiKey };
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    console.error("Run 'bounty-net identity create <name>' first");
    process.exit(1);
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as Config;
}

async function mintTokens(
  identity: string,
  amount: bigint,
  aggregatorUrl: string,
  apiKey: string,
): Promise<void> {
  console.log(`\nMinting ${amount} ALPHA tokens for identity: ${identity}\n`);
  console.log(`Aggregator: ${aggregatorUrl}\n`);

  // Load config
  const config = loadConfig();
  const identityConfig = config.identities[identity];

  if (!identityConfig) {
    console.error(`Identity not found: ${identity}`);
    console.error(
      "Available identities:",
      Object.keys(config.identities).join(", "),
    );
    process.exit(1);
  }

  console.log("Nametag:", identityConfig.nametag ?? "(none)");

  // Ensure wallets directory exists
  if (!existsSync(WALLETS_DIR)) {
    mkdirSync(WALLETS_DIR, { recursive: true });
  }

  // Load or create wallet
  const walletPath = join(WALLETS_DIR, `${identity}.json`);
  let wallet: Wallet;

  if (existsSync(walletPath)) {
    console.log(`Loading existing wallet from ${walletPath}`);
    const walletJson = JSON.parse(readFileSync(walletPath, "utf-8"));
    wallet = await Wallet.fromJSON(walletJson);
    console.log(`Wallet has ${wallet.listTokens().length} existing token(s)`);
  } else {
    console.log(`Creating new wallet for ${identity}`);
    wallet = await Wallet.create({
      name: identity,
      identityLabel: "default",
    });
  }

  // Create Alphalite client with API key
  const client = new AlphaClient({
    gatewayUrl: aggregatorUrl,
    apiKey,
  });

  // Load trust base
  if (existsSync(TRUSTBASE_PATH)) {
    const trustBaseJson = JSON.parse(readFileSync(TRUSTBASE_PATH, "utf-8"));
    const trustBase = RootTrustBase.fromJSON(trustBaseJson);
    client.setTrustBase(trustBase);
    console.log("Trust base loaded");
  } else {
    console.warn("Warning: No trust base found, minting without verification");
  }

  // Mint tokens using Alphalite (using hex-encoded coinId)
  console.log("\nMinting tokens...");

  const token = await client.mint(wallet, {
    coins: [[ALPHA_COIN_ID, amount]],
    label: `Minted ${amount} ALPHA at ${new Date().toISOString()}`,
  });

  console.log(`Token minted: ${token.id.slice(0, 32)}...`);

  // Save wallet with new token
  const walletJson = wallet.toJSON({ includeTokens: true });
  writeFileSync(walletPath, JSON.stringify(walletJson, null, 2));

  // Get updated balance
  const balance = wallet.getBalance(ALPHA_COIN_ID);

  console.log("\n=== Minting Complete ===");
  console.log("Token ID:", token.id);
  console.log("Amount minted:", amount.toString(), "ALPHA");
  console.log("Total balance:", balance.toString(), "ALPHA");
  console.log("Wallet saved to:", walletPath);
  console.log("");
  console.log("The token is now available in your wallet.");
}

// Main
const { identity, amount, aggregatorUrl, apiKey } = parseArgs();
mintTokens(identity, amount, aggregatorUrl, apiKey).catch((error) => {
  console.error("\nMinting failed:", error);
  process.exit(1);
});
