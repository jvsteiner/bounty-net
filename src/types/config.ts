import { z } from "zod";

// Individual identity (keypair + nametag + wallet)
export const IdentitySchema = z.object({
  privateKey: z.string().min(64).max(64),
  nametag: z.string().optional(),
});

// Inbox configuration for a project
export const InboxSchema = z.object({
  identity: z.string(),
  repositories: z.array(z.string()),
  bounties: z.record(z.string(), z.number()).default({}),
  depositRequirements: z
    .object({
      default: z.number().default(100),
      critical: z.number().optional(),
      high: z.number().optional(),
      medium: z.number().optional(),
      low: z.number().optional(),
    })
    .default({}),
});

export const ConfigSchema = z.object({
  // Multiple identities - each has its own keypair and wallet
  identities: z.record(z.string(), IdentitySchema),

  // Unicity aggregator settings
  aggregatorUrl: z.string().url().default("https://goggregator-test.unicity.network"),
  aggregatorApiKey: z.string().optional(),

  relays: z
    .array(z.string().url())
    .default(["wss://nostr-relay.testnet.unicity.network"]),
  database: z.string().default("~/.bounty-net/bounty-net.db"),

  // Reporter config - uses one identity for outbound reports
  reporter: z
    .object({
      enabled: z.boolean().default(true),
      identity: z.string(),
      defaultDeposit: z.number().default(100),
      maxReportsPerHour: z.number().default(10),
    })
    .optional(),

  // Maintainer config - multiple inboxes, each with own identity
  maintainer: z
    .object({
      enabled: z.boolean().default(false),
      inboxes: z.array(InboxSchema).default([]),
    })
    .default({}),

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
export type Inbox = z.infer<typeof InboxSchema>;
export type Config = z.infer<typeof ConfigSchema>;
