import type { IdentityManager } from "../../services/identity/manager.js";
import type { DatabaseWrapper } from "../../storage/database.js";
import type { Config } from "../../types/config.js";
import { ReputationRepository } from "../../storage/repositories/reputation.js";
import { COINS } from "../../constants/coins.js";
import { readLocalBountyNetFile, fetchBountyNetFile } from "../../cli/commands/repo.js";

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ToolHandler = (
  args: Record<string, unknown>
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

export function createSharedTools(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
) {
  const definitions: Tool[] = [
    {
      name: "get_balance",
      description: "Check wallet balance for an identity",
      inputSchema: {
        type: "object",
        properties: {
          identity: {
            type: "string",
            description: "Identity name (default: reporter identity)",
          },
          coin_id: {
            type: "string",
            description: "Token ID (default: ALPHA)",
          },
        },
      },
    },
    {
      name: "resolve_maintainer",
      description:
        "Resolve maintainer's NOSTR pubkey. If no arguments provided, reads from local .bounty-net.yaml. Can also fetch from a remote repository URL or resolve a nametag directly.",
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Repository URL to fetch .bounty-net.yaml from",
          },
          nametag: {
            type: "string",
            description: "Maintainer's nametag to resolve directly",
          },
        },
      },
    },
    {
      name: "get_reputation",
      description: "Get reputation stats for a pubkey",
      inputSchema: {
        type: "object",
        properties: {
          pubkey: {
            type: "string",
            description: "NOSTR pubkey (hex)",
          },
        },
        required: ["pubkey"],
      },
    },
    {
      name: "get_my_identity",
      description: "Get this server's NOSTR identity information",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];

  const handlers = new Map<string, ToolHandler>();

  handlers.set("get_balance", async (args) => {
    const identityName =
      (args.identity as string) ?? config.reporter?.identity;
    if (!identityName) {
      return {
        content: [{ type: "text", text: "No identity specified" }],
        isError: true,
      };
    }

    const identity = identityManager.get(identityName);
    if (!identity) {
      return {
        content: [{ type: "text", text: `Identity not found: ${identityName}` }],
        isError: true,
      };
    }

    const coinId = (args.coin_id as string) ?? COINS.ALPHA;
    const balance = await identity.wallet.getBalance(coinId);

    return {
      content: [
        {
          type: "text",
          text: `Balance for ${identityName}: ${balance} ${coinId === COINS.ALPHA ? "ALPHA" : coinId}`,
        },
      ],
    };
  });

  handlers.set("resolve_maintainer", async (args) => {
    const repoUrl = args.repo_url as string | undefined;
    let nametag = args.nametag as string | undefined;
    let source = "";

    // If nametag provided directly, use it
    if (nametag) {
      source = "provided nametag";
    }
    // If repo_url provided, fetch .bounty-net.yaml from remote
    else if (repoUrl) {
      try {
        const remoteConfig = await fetchBountyNetFile(repoUrl);
        if (remoteConfig) {
          nametag = remoteConfig.maintainer;
          source = `remote .bounty-net.yaml from ${repoUrl}`;
        } else {
          return {
            content: [
              {
                type: "text",
                text: `No .bounty-net.yaml found in repository: ${repoUrl}`,
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch .bounty-net.yaml: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    }
    // Otherwise, try local .bounty-net.yaml
    else {
      const localConfig = readLocalBountyNetFile();
      if (localConfig) {
        nametag = localConfig.maintainer;
        source = "local .bounty-net.yaml";
      } else {
        return {
          content: [
            {
              type: "text",
              text: "No arguments provided and no .bounty-net.yaml found in current directory. Provide repo_url or nametag.",
            },
          ],
          isError: true,
        };
      }
    }

    // Resolve nametag to pubkey
    const reporterIdentity = identityManager.getReporterIdentity();
    if (!reporterIdentity) {
      return {
        content: [
          {
            type: "text",
            text: `Found maintainer nametag: ${nametag} (from ${source})\nCannot resolve to pubkey: no reporter identity configured.`,
          },
        ],
      };
    }

    const pubkey = await reporterIdentity.client.resolveNametag(nametag);
    if (pubkey) {
      return {
        content: [
          {
            type: "text",
            text: `Maintainer: ${nametag}\nSource: ${source}\nPubkey: ${pubkey}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Maintainer: ${nametag}\nSource: ${source}\nPubkey: (nametag not registered on relay)`,
        },
      ],
    };
  });

  handlers.set("get_reputation", async (args) => {
    const pubkey = args.pubkey as string;
    const repRepo = new ReputationRepository(db);
    const stats = repRepo.getStats(pubkey);

    if (!stats) {
      return {
        content: [
          {
            type: "text",
            text: `No reputation data for pubkey: ${pubkey.slice(0, 16)}...`,
          },
        ],
      };
    }

    const accuracy =
      stats.total_reports > 0
        ? ((stats.accepted_reports / stats.total_reports) * 100).toFixed(1)
        : "N/A";

    return {
      content: [
        {
          type: "text",
          text: `Reputation for ${pubkey.slice(0, 16)}...
Total reports: ${stats.total_reports}
Accepted: ${stats.accepted_reports}
Rejected: ${stats.rejected_reports}
Accuracy: ${accuracy}%
Deposit tier: ${stats.deposit_tier}`,
        },
      ],
    };
  });

  handlers.set("get_my_identity", async () => {
    const identities = identityManager.listIdentities();
    const pubkeys = identityManager.getPublicKeys();

    let text = "Configured identities:\n";
    for (const name of identities) {
      const pubkey = pubkeys.get(name);
      const identity = identityManager.get(name);
      text += `\n${name}:\n`;
      text += `  pubkey: ${pubkey?.slice(0, 32)}...\n`;
      text += `  nametag: ${identity?.nametag ?? "(none)"}\n`;
    }

    if (config.reporter?.enabled) {
      text += `\nReporter identity: ${config.reporter.identity}`;
    }

    return {
      content: [{ type: "text", text }],
    };
  });

  return { definitions, handlers };
}
