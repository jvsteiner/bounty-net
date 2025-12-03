import type { IdentityManager } from "../../services/identity/manager.js";
import type { DatabaseWrapper } from "../../storage/database.js";
import type { Config } from "../../types/config.js";
import { COINS } from "../../constants/coins.js";

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
  args: Record<string, unknown>,
) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

export function createSharedTools(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
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
  ];

  const handlers = new Map<string, ToolHandler>();

  handlers.set("get_balance", async (args) => {
    const identityName = (args.identity as string) ?? config.reporter?.identity;
    if (!identityName) {
      return {
        content: [{ type: "text", text: "No identity specified" }],
        isError: true,
      };
    }

    const identity = identityManager.get(identityName);
    if (!identity) {
      return {
        content: [
          { type: "text", text: `Identity not found: ${identityName}` },
        ],
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

  return { definitions, handlers };
}
