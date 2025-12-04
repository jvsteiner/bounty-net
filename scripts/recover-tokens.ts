#!/usr/bin/env npx ts-node
/**
 * Emergency token recovery script
 *
 * Fetches historical token transfer events from NOSTR relays and attempts
 * to finalize any unclaimed tokens.
 *
 * Usage:
 *   npx ts-node scripts/recover-tokens.ts <identity-name>
 *
 * Example:
 *   npx ts-node scripts/recover-tokens.ts maintainer-test
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// SDK imports
import {
  TokenTransferProtocol,
  Filter,
  CallbackEventListener,
  NostrClient,
  NostrKeyManager,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import { TransferTransaction } from "@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";

const TOKEN_TRANSFER_KIND = 31113;

const TESTNET_TRUST_BASE = {
  version: 1,
  networkId: 3,
  epoch: 1,
  epochStartRound: 1,
  rootNodes: [
    {
      nodeId: "16Uiu2HAkyQRiA7pMgzgLj9GgaBJEJa8zmx9dzqUDa6WxQPJ82ghU",
      sigKey: "0x039afb2acb65f5fbc272d8907f763d0a5d189aadc9b97afdcc5897ea4dd112e68b",
      stake: 1
    }
  ],
  quorumThreshold: 1,
  stateHash: "",
  changeRecordHash: "",
  previousEntryHash: "",
  signatures: {
    "16Uiu2HAkyQRiA7pMgzgLj9GgaBJEJa8zmx9dzqUDa6WxQPJ82ghU": "0xf157c9fdd8a378e3ca70d354ccc4475ab2cd8de360127bc46b0aeab4b453a80f07fd9136a5843b60a8babaff23e20acc8879861f7651440a5e2829f7541b31f100"
  }
};

const DEFAULT_RELAYS = [
  "wss://relay.alphabill.org",
  "wss://relay.primal.net",
];

const DEFAULT_AGGREGATOR_URL = "https://aggregator-testnet.alphabill.org";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

interface Config {
  relays: string[];
  identities: Record<string, { privateKey: string; nametag?: string }>;
}

function loadConfig(): Config {
  const configPath = join(homedir(), ".bounty-net", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

async function recoverTokens(identityName: string) {
  console.log(`\n🔍 Token Recovery Script`);
  console.log(`========================\n`);

  // Load config
  const config = loadConfig();
  const identityConfig = config.identities[identityName];
  if (!identityConfig) {
    console.error(`❌ Identity not found: ${identityName}`);
    console.log(`Available identities: ${Object.keys(config.identities).join(", ")}`);
    process.exit(1);
  }

  console.log(`Identity: ${identityName}`);

  // Setup key manager and NOSTR client
  const keyManager = NostrKeyManager.fromPrivateKeyHex(identityConfig.privateKey);
  const pubkey = keyManager.getPublicKey();
  console.log(`Public key: ${pubkey}`);
  console.log(`Public key type: ${typeof pubkey}, length: ${pubkey.length}`);

  // Setup state transition client
  const apiKey = process.env.UNICITY_AGGREGATOR_APIKEY;
  if (!apiKey) {
    console.warn(`⚠️  UNICITY_AGGREGATOR_APIKEY not set - token finalization may fail`);
  }
  const aggregator = new AggregatorClient(DEFAULT_AGGREGATOR_URL, apiKey);
  const stateClient = new StateTransitionClient(aggregator);
  const trustBase = RootTrustBase.fromJSON(TESTNET_TRUST_BASE);

  // Setup signing service
  const privateKeyBytes = hexToBytes(identityConfig.privateKey);
  const signingService = new SigningService(privateKeyBytes);

  // Connect to relays
  const relays = config.relays ?? DEFAULT_RELAYS;
  console.log(`\nConnecting to relays: ${relays.join(", ")}`);

  const nostrClient = new NostrClient(relays);
  await nostrClient.connect();
  console.log(`✓ Connected to NOSTR relays`);

  // Build filter for token transfers to this pubkey
  // Look back 30 days
  const sinceTimestamp = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

  // First, try to find ANY token transfer events (without pubkey filter)
  const broadFilter = Filter.builder()
    .kinds(TOKEN_TRANSFER_KIND)
    .since(sinceTimestamp)
    .limit(50)
    .build();

  console.log(`\nFetching ALL token transfers since ${new Date(sinceTimestamp * 1000).toISOString()}...`);
  console.log(`Looking for events with kind ${TOKEN_TRANSFER_KIND}`);

  const events: Event[] = [];
  let resolveEvents: () => void;
  const eventsPromise = new Promise<void>((resolve) => {
    resolveEvents = resolve;
  });

  // Collect events for a few seconds
  const listener = new CallbackEventListener((event: Event) => {
    events.push(event);
    console.log(`  Found event: ${event.id.slice(0, 16)}... from ${event.pubkey.slice(0, 16)}...`);
  });

  nostrClient.subscribe(broadFilter, listener);

  // Wait for events to come in
  console.log(`Waiting 5 seconds for events...`);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log(`\nFound ${events.length} token transfer event(s)`);

  if (events.length === 0) {
    console.log(`\nNo token transfers found. Nothing to recover.`);
    process.exit(0);
  }

  // Process each event
  const tokensDir = join(homedir(), ".bounty-net", "tokens");
  if (!existsSync(tokensDir)) {
    mkdirSync(tokensDir, { recursive: true });
  }

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const event of events) {
    console.log(`\n--- Processing event ${event.id.slice(0, 16)}... ---`);

    try {
      if (!TokenTransferProtocol.isTokenTransfer(event)) {
        console.log(`  ⏭️  Not a token transfer, skipping`);
        skipped++;
        continue;
      }

      const payloadJson = await TokenTransferProtocol.parseTokenTransfer(event, keyManager);
      const payload = JSON.parse(payloadJson);

      if (!payload.tokenJson || !payload.transactionJson) {
        console.log(`  ⏭️  Missing token/transaction data, skipping`);
        skipped++;
        continue;
      }

      console.log(`  Amount: ${payload.amount ?? "unknown"}`);
      console.log(`  Coin: ${payload.coinId ?? "unknown"}`);
      console.log(`  Message: ${payload.message ?? "(none)"}`);

      // Check if we already have this token
      const tokenData = JSON.parse(payload.tokenJson);
      const tokenId = tokenData.genesis?.data?.id ?? "unknown";
      const shortId = tokenId.slice(0, 16);
      const existingFile = join(tokensDir, `${identityName}-${shortId}.json`);

      if (existsSync(existingFile)) {
        console.log(`  ⏭️  Token already exists: ${existingFile}`);
        skipped++;
        continue;
      }

      // Try to finalize the token
      console.log(`  Finalizing token...`);

      const token = await Token.fromJSON(JSON.parse(payload.tokenJson));
      const transaction = await TransferTransaction.fromJSON(JSON.parse(payload.transactionJson));

      // Create predicate to claim ownership
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const predicate = await UnmaskedPredicate.create(
        token.id,
        token.type,
        signingService,
        HashAlgorithm.SHA256,
        nonce,
      );

      // Finalize the transaction
      const finalizedToken = await stateClient.finalizeTransaction(
        trustBase,
        token,
        new TokenState(predicate, null),
        transaction,
      );

      // Verify the token
      const verifyResult = await finalizedToken.verify(trustBase);
      if (!verifyResult.isSuccessful) {
        console.log(`  ❌ Token verification failed`);
        failed++;
        continue;
      }

      // Save to disk
      const filename = `${identityName}-${shortId}.json`;
      const filepath = join(tokensDir, filename);
      writeFileSync(filepath, JSON.stringify(finalizedToken.toJSON(), null, 2));

      console.log(`  ✅ Token recovered and saved: ${filename}`);
      recovered++;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ❌ Failed: ${message}`);
      failed++;
    }
  }

  console.log(`\n========================`);
  console.log(`Recovery complete:`);
  console.log(`  ✅ Recovered: ${recovered}`);
  console.log(`  ⏭️  Skipped:   ${skipped}`);
  console.log(`  ❌ Failed:    ${failed}`);
  console.log(`========================\n`);

  process.exit(0);
}

// Main
const identityName = process.argv[2];
if (!identityName) {
  console.error("Usage: npx ts-node scripts/recover-tokens.ts <identity-name>");
  process.exit(1);
}

recoverTokens(identityName).catch((error) => {
  console.error(`Fatal error: ${error}`);
  process.exit(1);
});
