import { z } from "zod";

// Individual identity (keypair + nametag + wallet)
export const IdentitySchema = z.object({
  privateKey: z.string().min(64).max(64),
  nametag: z.string().optional(),
});

export const ConfigSchema = z.object({
  // Multiple identities - each has its own keypair and wallet
  // All identities can both report bugs and receive bug reports
  identities: z.record(z.string(), IdentitySchema),

  // Default identity used when no --identity flag specified
  // First identity created gets this by default
  defaultIdentity: z.string().optional(),

  // Default deposit amount for bug reports
  defaultDeposit: z.number().default(100),

  // Unicity aggregator settings
  aggregatorUrl: z.string().url().default("https://goggregator-test.unicity.network"),
  aggregatorApiKey: z.string().optional(),

  relays: z
    .array(z.string().url())
    .default(["wss://nostr-relay.testnet.unicity.network"]),
  database: z.string().default("~/.bounty-net/bounty-net.db"),

  // UI config
  ui: z
    .object({
      ideProtocol: z
        .enum(["zed", "vscode", "cursor", "jetbrains"])
        .default("vscode"),
    })
    .optional(),
});

export type Identity = z.infer<typeof IdentitySchema>;
export type Config = z.infer<typeof ConfigSchema>;
