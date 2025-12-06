import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import enquirer from "enquirer";
import { PATHS } from "../../constants/paths.js";
import {
  createDefaultConfig,
  saveConfig,
  loadConfig,
} from "../../config/loader.js";
import { AlphaliteWalletService } from "../../services/wallet/alphalite-wallet.js";

const { Select, Input } = enquirer as any;

interface GitRemote {
  name: string;
  url: string;
}

/**
 * Get all git remotes with their URLs.
 */
function getAllRemotes(): GitRemote[] {
  try {
    const output = execSync("git remote -v", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!output) return [];

    const remotes = new Map<string, string>();
    for (const line of output.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
      if (match) {
        remotes.set(match[1], normalizeGitUrl(match[2]));
      }
    }

    return Array.from(remotes.entries()).map(([name, url]) => ({ name, url }));
  } catch {
    return [];
  }
}

/**
 * Try to detect the canonical repo URL from git remotes.
 * Returns: { url, auto } where auto=true if only one remote or found preferred.
 */
function detectRepoUrl(): { url: string; name: string } | null {
  const remotes = getAllRemotes();

  if (remotes.length === 0) {
    return null;
  }

  // If only one remote, use it
  if (remotes.length === 1) {
    return { url: remotes[0].url, name: remotes[0].name };
  }

  // Prefer 'upstream' then 'origin'
  for (const preferred of ["upstream", "origin"]) {
    const remote = remotes.find((r) => r.name === preferred);
    if (remote) {
      return { url: remote.url, name: remote.name };
    }
  }

  return null;
}

/**
 * Get all remotes for user selection.
 */
function getRemotesForSelection(): GitRemote[] {
  return getAllRemotes();
}

/**
 * Normalize git URL to https format.
 * git@github.com:org/repo.git -> https://github.com/org/repo
 */
function normalizeGitUrl(url: string): string {
  // Remove .git suffix
  url = url.replace(/\.git$/, "");

  // Convert SSH to HTTPS
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  return url;
}

export async function initCommand(): Promise<void> {
  // Ensure base directory exists
  fs.mkdirSync(PATHS.BASE_DIR, { recursive: true });

  if (fs.existsSync(PATHS.CONFIG)) {
    console.log(`Config already exists at: ${PATHS.CONFIG}`);
    console.log("Delete it first if you want to reinitialize.");
    return;
  }

  // Prompt for aggregator API key
  console.log("Bounty-Net requires a Unicity aggregator API key for token operations.");
  console.log("Get one at: https://unicity.network");
  console.log("");

  const apiKeyPrompt = new Input({
    name: "apiKey",
    message: "Aggregator API key (sk_...):",
  });

  let aggregatorApiKey: string | undefined;
  try {
    aggregatorApiKey = await apiKeyPrompt.run();
    if (aggregatorApiKey) {
      aggregatorApiKey = aggregatorApiKey.trim();
    }
  } catch {
    // User cancelled
    process.exit(1);
  }

  const config = createDefaultConfig() as Record<string, unknown>;
  if (aggregatorApiKey) {
    config.aggregatorApiKey = aggregatorApiKey;
  }
  saveConfig(config, PATHS.CONFIG);

  console.log("");
  console.log(`Created config at: ${PATHS.CONFIG}`);
  console.log("");
  console.log("Next steps:");
  console.log("");
  console.log("1. Create an identity:");
  console.log("   bounty-net identity create <name>");
  console.log("");
  console.log("2. Mint tokens for the identity:");
  console.log("   npx tsx scripts/mint-tokens.ts --identity <name> --amount 10000");
  console.log("");
  console.log("3. Register your nametag:");
  console.log("   bounty-net identity register <name>");
  console.log("");
  console.log("4. Start the daemon:");
  console.log("   bounty-net daemon start");
}

export async function initRepoCommand(options: {
  identity?: string;
  nametag?: string;
  repo?: string;
  deposit?: number;
  reward?: number;
}): Promise<void> {
  const cwd = process.cwd();
  const bountyNetFile = path.join(cwd, ".bounty-net.yaml");

  // Check if we're in a git repo
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.error("Error: Not in a git repository root.");
    console.error("Run this command from the root of your repository.");
    process.exit(1);
  }

  // Check if .bounty-net.yaml already exists
  if (fs.existsSync(bountyNetFile)) {
    console.log("File already exists: .bounty-net.yaml");
    console.log("");
    console.log(fs.readFileSync(bountyNetFile, "utf-8"));
    console.log("");
    console.log("Delete it first if you want to reinitialize.");
    return;
  }

  // Determine the nametag to use
  let nametag = options.nametag;
  let identityName = options.identity;

  if (!nametag) {
    // Try to find nametag from config
    try {
      const config = await loadConfig();
      const identityNames = Object.keys(config.identities);

      if (identityNames.length === 0) {
        console.error("Error: No identities configured.");
        console.error("");
        console.error("First create an identity:");
        console.error("  bounty-net identity create my-identity");
        console.error(
          "  bounty-net identity register my-identity --nametag me@unicity",
        );
        process.exit(1);
      }

      // If identity specified, use that one
      if (identityName) {
        const identity = config.identities[identityName];
        if (!identity) {
          console.error(`Error: Identity not found: ${identityName}`);
          process.exit(1);
        }
        if (identity.nametag) {
          nametag = identity.nametag;
        }
      }
      // If only one identity, use it automatically
      else if (identityNames.length === 1) {
        identityName = identityNames[0];
        const identity = config.identities[identityName];
        if (identity.nametag) {
          nametag = identity.nametag;
          console.log(`Using identity: ${identityName}`);
        }
      }
      // Multiple identities - prompt user to choose
      else {
        const choices = identityNames.map((name) => {
          const identity = config.identities[name];
          return {
            name: name,
            message: identity.nametag ? `${name} (${identity.nametag})` : name,
            value: name,
          };
        });

        const prompt = new Select({
          name: "identity",
          message: "Select an identity:",
          choices,
        });

        try {
          identityName = await prompt.run();
          const identity = config.identities[identityName];
          if (identity.nametag) {
            nametag = identity.nametag;
          }
        } catch {
          // User cancelled
          process.exit(1);
        }
      }
    } catch {
      // Config doesn't exist
      console.error(
        "Error: No configuration found. Run 'bounty-net init' first.",
      );
      process.exit(1);
    }
  }

  if (!nametag) {
    console.error(
      `Error: Identity '${identityName}' has no nametag registered.`,
    );
    console.error("");
    console.error("Register a nametag first:");
    console.error(
      `  bounty-net identity register ${identityName} --nametag your-name@unicity`,
    );
    console.error("");
    console.error("Or specify a nametag directly:");
    console.error("  bounty-net init-repo --nametag your-name@unicity");
    process.exit(1);
  }

  // Get the wallet pubkey for this identity
  const config = await loadConfig();
  const identity = config.identities[identityName!];
  let privateKey = identity.privateKey;
  if (privateKey.startsWith("env:")) {
    const envVar = privateKey.slice(4);
    const value = process.env[envVar];
    if (!value) {
      console.error(`Environment variable ${envVar} not set`);
      process.exit(1);
    }
    privateKey = value;
  }
  const walletPubkey = await AlphaliteWalletService.deriveWalletPubkey(privateKey);

  // Determine the repo URL
  let repoUrl = options.repo;

  if (!repoUrl) {
    const detected = detectRepoUrl();
    if (detected) {
      repoUrl = detected.url;
      console.log(`Using remote: ${detected.name} (${detected.url})`);
    } else {
      // No preferred remote found, check if there are any remotes at all
      const allRemotes = getRemotesForSelection();

      if (allRemotes.length === 0) {
        console.error("Error: No git remotes configured.");
        console.error("");
        console.error("Specify the repository URL manually:");
        console.error(
          "  bounty-net init-repo --repo https://github.com/org/repo",
        );
        process.exit(1);
      }

      // Multiple remotes but none are 'upstream' or 'origin' - prompt user
      const choices = allRemotes.map((remote) => ({
        name: remote.url,
        message: `${remote.name} (${remote.url})`,
        value: remote.url,
      }));

      const prompt = new Select({
        name: "remote",
        message: "Select a git remote:",
        choices,
      });

      try {
        repoUrl = await prompt.run();
      } catch {
        // User cancelled
        process.exit(1);
      }
    }
  }

  // Create the .bounty-net.yaml file
  const deposit = options.deposit ?? 10; // Default deposit
  const reward = options.reward ?? 100; // Default reward
  const content = `# Bounty-Net Configuration
# AI agents can report bugs to this repository's maintainer

maintainer: ${nametag}
wallet_pubkey: ${walletPubkey}
repo: ${repoUrl}

# Deposit required to submit a bug report (refunded if accepted)
deposit: ${deposit}

# Reward paid for valid bug reports (on top of deposit refund)
reward: ${reward}
`;

  fs.writeFileSync(bountyNetFile, content);

  console.log(`Created: .bounty-net.yaml`);
  console.log("");
  console.log(content);
  console.log("Next steps:");
  console.log("1. Commit .bounty-net.yaml to your repository");
  console.log("2. Start the daemon: bounty-net daemon start");
  console.log("3. AI agents can now discover how to report bugs to you");
}
