import fs from "fs";
import path from "path";
import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";

export interface BountyNetConfig {
  maintainer: string;
  wallet_pubkey: string; // 33-byte compressed secp256k1 pubkey (hex) for token transfers
  repo?: string;
  deposit?: number;
  reward?: number;
}

/**
 * Read .bounty-net.yaml from the current working directory
 */
export function readLocalBountyNetFile(): BountyNetConfig | null {
  const cwd = process.cwd();
  const bountyNetFile = path.join(cwd, ".bounty-net.yaml");

  if (!fs.existsSync(bountyNetFile)) {
    return null;
  }

  const content = fs.readFileSync(bountyNetFile, "utf-8");
  return parseBountyNetFile(content);
}

/**
 * Parse a GitHub URL to extract owner and repo
 */
function parseGitHubUrl(
  url: string,
): { owner: string; repo: string; branch: string } | null {
  // Handle various GitHub URL formats:
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  // https://github.com/owner/repo/tree/branch

  let owner: string | undefined;
  let repo: string | undefined;
  let branch = "main"; // default

  // HTTPS format
  const httpsMatch = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (httpsMatch) {
    owner = httpsMatch[1];
    repo = httpsMatch[2];

    // Check for branch in URL
    const branchMatch = url.match(/\/tree\/([^\/]+)/);
    if (branchMatch) {
      branch = branchMatch[1];
    }
  }

  // SSH format
  const sshMatch = url.match(/git@github\.com:([^\/]+)\/([^\.]+)/);
  if (sshMatch) {
    owner = sshMatch[1];
    repo = sshMatch[2];
  }

  if (owner && repo) {
    return { owner, repo, branch };
  }
  return null;
}

/**
 * Fetch and parse .bounty-net.yaml file from a repository
 */
export async function fetchBountyNetFile(
  repoUrl: string,
): Promise<BountyNetConfig | null> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub URL: ${repoUrl}`);
  }

  const { owner, repo, branch } = parsed;

  // Try main branch first, then master
  const branches = branch === "main" ? ["main", "master"] : [branch];

  for (const b of branches) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/.bounty-net.yaml`;

    try {
      const response = await fetch(rawUrl);
      if (response.ok) {
        const content = await response.text();
        return parseBountyNetFile(content);
      }
    } catch {
      // Try next branch
    }
  }

  return null;
}

/**
 * Parse .bounty-net.yaml file content
 */
export function parseBountyNetFile(content: string): BountyNetConfig | null {
  const lines = content.split("\n");
  const result: Partial<BountyNetConfig> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith("#") || trimmed === "") {
      continue;
    }

    // Parse key: value
    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      const lowerKey = key.toLowerCase();
      if (lowerKey === "maintainer") {
        result.maintainer = value.trim();
      } else if (lowerKey === "repo") {
        result.repo = value.trim();
      } else if (lowerKey === "deposit") {
        const num = parseInt(value.trim(), 10);
        if (!isNaN(num)) {
          result.deposit = num;
        }
      } else if (lowerKey === "reward") {
        const num = parseInt(value.trim(), 10);
        if (!isNaN(num)) {
          result.reward = num;
        }
      } else if (lowerKey === "wallet_pubkey") {
        result.wallet_pubkey = value.trim();
      }
    }
  }

  if (result.maintainer) {
    return result as BountyNetConfig;
  }

  return null;
}

export async function lookupMaintainerCommand(repoUrl?: string): Promise<void> {
  try {
    // If no repo URL provided, try to read from local .bounty-net.yaml
    let bountyNet: BountyNetConfig | null = null;
    let source: string;

    if (!repoUrl) {
      bountyNet = readLocalBountyNetFile();
      if (bountyNet) {
        source = "local .bounty-net.yaml";
        repoUrl = bountyNet.repo;
      } else {
        console.error(
          "Error: No repository URL specified and no local .bounty-net.yaml found.",
        );
        console.error("");
        console.error("Usage:");
        console.error(
          "  bounty-net lookup-maintainer https://github.com/org/repo",
        );
        console.error("");
        console.error("Or run from a directory with a .bounty-net.yaml file.");
        process.exit(1);
      }
    } else {
      console.log(`Looking up maintainer for: ${repoUrl}`);
      console.log("");

      // Fetch .bounty-net.yaml file from remote
      bountyNet = await fetchBountyNetFile(repoUrl);
      source = "remote .bounty-net.yaml";

      if (!bountyNet) {
        console.log("No .bounty-net.yaml file found in repository.");
        console.log("");
        console.log("This repository has not configured bounty-net.");
        console.log("The maintainer needs to run: bounty-net init-repo");
        process.exit(1);
      }
    }

    console.log(`Source: ${source}`);
    console.log(`Maintainer nametag: ${bountyNet.maintainer}`);
    if (bountyNet.repo) {
      console.log(`Repository: ${bountyNet.repo}`);
    }

    // Try to resolve the nametag to a pubkey
    try {
      const config = await loadConfig();
      const identityNames = Object.keys(config.identities);

      if (identityNames.length > 0) {
        const identity = config.identities[identityNames[0]];
        const client = new BountyNetNostrClient(identity.privateKey);
        await client.connect(config.relays);

        const pubkey = await client.resolveNametag(bountyNet.maintainer);

        if (pubkey) {
          console.log(`Pubkey: ${pubkey}`);
        } else {
          console.log(`Pubkey: (nametag not registered on relay)`);
        }

        client.disconnect();
      }
    } catch {
      // Could not resolve - that's okay, we still have the nametag
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export const repoCommands = {
  lookupMaintainer: lookupMaintainerCommand,
};
