import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";

/**
 * Parse a GitHub URL to extract owner and repo
 */
function parseGitHubUrl(url: string): { owner: string; repo: string; branch: string } | null {
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
 * Fetch and parse .bounty-net file from a repository
 */
async function fetchBountyNetFile(repoUrl: string): Promise<{ maintainer: string } | null> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub URL: ${repoUrl}`);
  }

  const { owner, repo, branch } = parsed;

  // Try main branch first, then master
  const branches = branch === "main" ? ["main", "master"] : [branch];

  for (const b of branches) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/.bounty-net`;

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
 * Parse .bounty-net file content
 */
function parseBountyNetFile(content: string): { maintainer: string } | null {
  const lines = content.split("\n");

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
      if (key.toLowerCase() === "maintainer") {
        return { maintainer: value.trim() };
      }
    }
  }

  return null;
}

export async function lookupMaintainerCommand(repoUrl: string): Promise<void> {
  try {
    console.log(`Looking up maintainer for: ${repoUrl}`);
    console.log("");

    // Fetch .bounty-net file
    const bountyNet = await fetchBountyNetFile(repoUrl);

    if (!bountyNet) {
      console.log("No .bounty-net file found in repository.");
      console.log("");
      console.log("This repository has not configured bounty-net.");
      console.log("The maintainer needs to run: bounty-net init-repo");
      process.exit(1);
    }

    console.log(`Maintainer nametag: ${bountyNet.maintainer}`);

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
