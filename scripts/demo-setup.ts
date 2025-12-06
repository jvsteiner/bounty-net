#!/usr/bin/env npx tsx
/**
 * Demo Setup Script for Bounty-Net
 *
 * Sets up a complete demo environment with:
 * - Reporter identity with wallet and tokens
 * - Maintainer identity with wallet and tokens
 * - .bounty-net.yaml configured with correct wallet pubkey
 *
 * Usage:
 *   npx tsx scripts/demo-setup.ts [--reset]
 *
 * Options:
 *   --reset    Delete existing wallets and start fresh (DESTRUCTIVE)
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const BOUNTY_NET_DIR = join(homedir(), ".bounty-net");
const CONFIG_PATH = join(BOUNTY_NET_DIR, "config.json");
const WALLETS_DIR = join(BOUNTY_NET_DIR, "wallets");
const REPO_CONFIG_PATH = join(process.cwd(), ".bounty-net.yaml");

const REPORTER_IDENTITY = "reporter001";
const MAINTAINER_IDENTITY = "maintainer001";
const INITIAL_BALANCE = 1000;

interface Config {
  identities: Record<string, { privateKey: string; nametag?: string }>;
  relays: string[];
  aggregatorUrl: string;
  aggregatorApiKey?: string;
  database: string;
  reporter?: { enabled: boolean; identity: string; defaultDeposit: number; maxReportsPerHour: number };
  maintainer?: { enabled: boolean; inboxes: Array<{ identity: string; repositories: string[] }> };
}

function log(msg: string) {
  console.log(`\n✓ ${msg}`);
}

function error(msg: string) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function warn(msg: string) {
  console.warn(`\n⚠ ${msg}`);
}

function run(cmd: string, silent = false): string {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      stdio: silent ? "pipe" : ["pipe", "pipe", "pipe"],
      cwd: process.cwd()
    });
    return result.trim();
  } catch (e: any) {
    if (!silent) {
      console.error(`Command failed: ${cmd}`);
      console.error(e.stderr?.toString() || e.message);
    }
    throw e;
  }
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config: Config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getWalletPubkey(identity: string): string | null {
  const walletPath = join(WALLETS_DIR, `${identity}.json`);
  if (!existsSync(walletPath)) return null;

  try {
    const wallet = JSON.parse(readFileSync(walletPath, "utf-8"));
    return wallet.identities?.[0]?.publicKey || null;
  } catch {
    return null;
  }
}

function walletExists(identity: string): boolean {
  return existsSync(join(WALLETS_DIR, `${identity}.json`));
}

function getWalletBalance(identity: string): number {
  const walletPath = join(WALLETS_DIR, `${identity}.json`);
  if (!existsSync(walletPath)) return 0;

  try {
    const wallet = JSON.parse(readFileSync(walletPath, "utf-8"));
    const tokens = wallet.tokens || [];
    let total = 0;

    for (const entry of tokens) {
      try {
        const tokenData = JSON.parse(entry.token);
        const coinData = tokenData.genesis?.data?.coinData || [];
        for (const [coinId, amount] of coinData) {
          if (coinId === "414c504841") { // ALPHA
            total += parseInt(amount, 10);
          }
        }
      } catch {
        // Skip malformed tokens
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function deleteWallet(identity: string) {
  const walletPath = join(WALLETS_DIR, `${identity}.json`);
  if (existsSync(walletPath)) {
    rmSync(walletPath);
  }
}

async function mintTokens(identity: string, amount: number) {
  console.log(`   Minting ${amount} ALPHA for ${identity}...`);
  try {
    run(`npx tsx scripts/mint-tokens.ts --identity ${identity} --amount ${amount}`, true);
  } catch (e: any) {
    // Check if it's an API key issue
    if (e.stderr?.includes("API key required")) {
      error("Minting requires UNICITY_AGGREGATOR_APIKEY in .env file");
    }
    throw e;
  }
}

function generateRepoConfig(maintainerNametag: string, walletPubkey: string, repoUrl: string) {
  const yaml = `# Bounty-Net Configuration
# AI agents can report bugs to this repository's maintainer

maintainer: ${maintainerNametag}
wallet_pubkey: ${walletPubkey}
repo: ${repoUrl}

# Deposit required to submit a bug report (refunded if accepted)
deposit: 10

# Reward paid for valid bug reports (on top of deposit refund)
reward: 100
`;
  writeFileSync(REPO_CONFIG_PATH, yaml);
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");

  console.log("╔════════════════════════════════════════════╗");
  console.log("║       Bounty-Net Demo Setup Script         ║");
  console.log("╚════════════════════════════════════════════╝");

  // Step 1: Check/create config
  console.log("\n[1/6] Checking configuration...");

  let config = loadConfig();

  if (!config) {
    console.log("   Initializing bounty-net...");
    run("node dist/cli.js init", true);
    config = loadConfig();
    if (!config) error("Failed to initialize config");
  }

  log("Config exists at " + CONFIG_PATH);

  // Step 2: Check/create identities
  console.log("\n[2/6] Checking identities...");

  const hasReporter = config!.identities?.[REPORTER_IDENTITY];
  const hasMaintainer = config!.identities?.[MAINTAINER_IDENTITY];

  if (!hasReporter) {
    console.log(`   Creating ${REPORTER_IDENTITY} identity...`);
    run(`node dist/cli.js identity create ${REPORTER_IDENTITY}`, true);
    config = loadConfig()!;
  }

  if (!hasMaintainer) {
    console.log(`   Creating ${MAINTAINER_IDENTITY} identity...`);
    run(`node dist/cli.js identity create ${MAINTAINER_IDENTITY}`, true);
    config = loadConfig()!;
  }

  log(`Identities: ${REPORTER_IDENTITY}, ${MAINTAINER_IDENTITY}`);

  // Step 2b: Register nametags on NOSTR
  console.log("\n[2b/7] Registering nametags on NOSTR...");

  const reporterNametag = config!.identities[REPORTER_IDENTITY]?.nametag;
  const maintainerNametag = config!.identities[MAINTAINER_IDENTITY]?.nametag;

  if (reporterNametag) {
    console.log(`   Registering ${reporterNametag}...`);
    try {
      run(`node dist/cli.js identity register ${REPORTER_IDENTITY}`, true);
      console.log(`   ✓ ${reporterNametag} registered`);
    } catch (e: any) {
      // May already be registered or fail for other reasons
      if (e.stderr?.includes("already registered") || e.stdout?.includes("already registered")) {
        console.log(`   ${reporterNametag} already registered`);
      } else {
        warn(`Failed to register ${reporterNametag}: ${e.message}`);
      }
    }
  }

  if (maintainerNametag) {
    console.log(`   Registering ${maintainerNametag}...`);
    try {
      run(`node dist/cli.js identity register ${MAINTAINER_IDENTITY}`, true);
      console.log(`   ✓ ${maintainerNametag} registered`);
    } catch (e: any) {
      if (e.stderr?.includes("already registered") || e.stdout?.includes("already registered")) {
        console.log(`   ${maintainerNametag} already registered`);
      } else {
        warn(`Failed to register ${maintainerNametag}: ${e.message}`);
      }
    }
  }

  log("Nametags registered");

  // Step 3: Configure reporter and maintainer roles
  console.log("\n[3/7] Configuring roles...");

  config!.reporter = {
    enabled: true,
    identity: REPORTER_IDENTITY,
    defaultDeposit: 100,
    maxReportsPerHour: 10
  };

  config!.maintainer = {
    enabled: true,
    inboxes: [{
      identity: MAINTAINER_IDENTITY,
      repositories: ["github.com/jvsteiner/bounty-net"]
    }]
  };

  saveConfig(config!);
  log("Reporter and maintainer roles configured");

  // Step 4: Handle wallets
  console.log("\n[4/7] Setting up wallets...");

  if (!existsSync(WALLETS_DIR)) {
    mkdirSync(WALLETS_DIR, { recursive: true });
  }

  const reporterWalletExists = walletExists(REPORTER_IDENTITY);
  const maintainerWalletExists = walletExists(MAINTAINER_IDENTITY);

  if (reset) {
    warn("--reset flag: Deleting existing wallets");
    deleteWallet(REPORTER_IDENTITY);
    deleteWallet(MAINTAINER_IDENTITY);
  }

  // Mint tokens if wallets don't exist or were reset
  if (reset || !reporterWalletExists) {
    await mintTokens(REPORTER_IDENTITY, INITIAL_BALANCE);
  } else {
    const balance = getWalletBalance(REPORTER_IDENTITY);
    console.log(`   ${REPORTER_IDENTITY} wallet exists with ${balance} ALPHA`);
  }

  if (reset || !maintainerWalletExists) {
    await mintTokens(MAINTAINER_IDENTITY, INITIAL_BALANCE);
  } else {
    const balance = getWalletBalance(MAINTAINER_IDENTITY);
    console.log(`   ${MAINTAINER_IDENTITY} wallet exists with ${balance} ALPHA`);
  }

  log("Wallets ready");

  // Step 5: Get wallet pubkeys and verify
  console.log("\n[5/7] Verifying wallet pubkeys...");

  const reporterPubkey = getWalletPubkey(REPORTER_IDENTITY);
  const maintainerPubkey = getWalletPubkey(MAINTAINER_IDENTITY);

  if (!reporterPubkey) error(`Failed to get ${REPORTER_IDENTITY} wallet pubkey`);
  if (!maintainerPubkey) error(`Failed to get ${MAINTAINER_IDENTITY} wallet pubkey`);

  console.log(`   ${REPORTER_IDENTITY}: ${reporterPubkey!.slice(0, 20)}...`);
  console.log(`   ${MAINTAINER_IDENTITY}: ${maintainerPubkey!.slice(0, 20)}...`);

  log("Wallet pubkeys verified");

  // Step 6: Generate .bounty-net.yaml with correct pubkey
  console.log("\n[6/7] Generating .bounty-net.yaml...");

  const maintainerNametagForYaml = maintainerNametag || `${MAINTAINER_IDENTITY}@unicity`;
  const repoUrl = "https://github.com/jvsteiner/bounty-net";

  // Check if existing yaml has correct pubkey
  if (existsSync(REPO_CONFIG_PATH)) {
    const existingYaml = readFileSync(REPO_CONFIG_PATH, "utf-8");
    if (existingYaml.includes(maintainerPubkey!)) {
      console.log("   .bounty-net.yaml already has correct wallet_pubkey");
    } else {
      warn("Updating .bounty-net.yaml with correct wallet_pubkey");
      generateRepoConfig(maintainerNametagForYaml, maintainerPubkey!, repoUrl);
    }
  } else {
    generateRepoConfig(maintainerNametagForYaml, maintainerPubkey!, repoUrl);
  }

  log(".bounty-net.yaml configured");

  // Step 7: Verify nametag resolution works
  console.log("\n[7/7] Verifying nametag resolution...");

  try {
    const resolvedMaintainer = run(`node dist/cli.js identity resolve ${config!.identities[MAINTAINER_IDENTITY]?.nametag}`, true);
    if (resolvedMaintainer) {
      console.log(`   ${config!.identities[MAINTAINER_IDENTITY]?.nametag} → ${resolvedMaintainer.slice(0, 32)}...`);
    }
  } catch {
    warn(`Could not resolve maintainer nametag - reports may fail`);
  }

  log("Nametag resolution verified");

  // Summary
  console.log("\n╔════════════════════════════════════════════╗");
  console.log("║            Setup Complete!                 ║");
  console.log("╚════════════════════════════════════════════╝");

  const reporterBalance = getWalletBalance(REPORTER_IDENTITY);
  const maintainerBalance = getWalletBalance(MAINTAINER_IDENTITY);

  console.log(`
Identities:
  Reporter:   ${REPORTER_IDENTITY} (${reporterBalance} ALPHA)
  Maintainer: ${MAINTAINER_IDENTITY} (${maintainerBalance} ALPHA)

Wallet Pubkeys:
  Reporter:   ${reporterPubkey!.slice(0, 32)}...
  Maintainer: ${maintainerPubkey!.slice(0, 32)}...

Configuration:
  Config:     ${CONFIG_PATH}
  Repo YAML:  ${REPO_CONFIG_PATH}

Next Steps:
  1. Start the daemon:     node dist/cli.js daemon run
  2. In another terminal:  Connect MCP and submit a report
  3. Accept via UI:        http://localhost:1976

To reset everything:
  npx tsx scripts/demo-setup.ts --reset
`);
}

main().catch((e) => {
  console.error("\nSetup failed:", e.message);
  process.exit(1);
});
