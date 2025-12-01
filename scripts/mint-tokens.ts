#!/usr/bin/env npx tsx
/**
 * Mint ALPHA tokens for testing bounty-net
 *
 * This script mints test tokens on the Unicity testnet.
 *
 * Usage:
 *   npx tsx scripts/mint-tokens.ts --identity <name> --amount <amount>
 *
 * Environment:
 *   UNICITY_AGGREGATOR_APIKEY - API key for the aggregator (required)
 *   UNICITY_AGGREGATOR_URL - Override aggregator URL (optional)
 *
 * Example:
 *   npx tsx scripts/mint-tokens.ts --identity jamie-bounty --amount 1000
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

// Direct imports from state-transition-sdk
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { MintSigningService } from "@unicitylabs/state-transition-sdk/lib/sign/MintSigningService.js";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TokenId } from "@unicitylabs/state-transition-sdk/lib/token/TokenId.js";
import { TokenType } from "@unicitylabs/state-transition-sdk/lib/token/TokenType.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import { TokenCoinData } from "@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData.js";
import { CoinId } from "@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js";
import { MintCommitment } from "@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js";
import { MintTransaction } from "@unicitylabs/state-transition-sdk/lib/transaction/MintTransaction.js";
import { MintTransactionData } from "@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";

// Constants
const BOUNTY_NET_DIR = join(homedir(), ".bounty-net");
const CONFIG_PATH = join(BOUNTY_NET_DIR, "config.json");
const TOKENS_DIR = join(BOUNTY_NET_DIR, "tokens");

const DEFAULT_AGGREGATOR_URL = "https://goggregator-test.unicity.network";
const ALPHA_COIN_ID = "414c504841"; // "ALPHA" in hex

// Fungible token type for ALPHA coins
const FUNGIBLE_TOKEN_TYPE = new TokenType(
  new Uint8Array([0x00, 0x00, 0x00, 0x01]),
);

interface Config {
  identities: Record<
    string,
    {
      privateKey: string;
      nametag: string;
    }
  >;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
      "  --api-key <key>       API key (or set UNICITY_AGGREGATOR_APIKEY in .env)",
    );
    process.exit(1);
  }

  if (!apiKey) {
    console.error("Error: API key required.");
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

/**
 * Create a token without verification by constructing the JSON manually
 * and using Token.fromJSON which doesn't verify.
 */
async function createTokenWithoutVerification(
  tokenState: TokenState,
  mintTransaction: MintTransaction<unknown>,
): Promise<Token<unknown>> {
  // Construct token JSON structure manually
  const tokenJson = {
    version: "2.0",
    state: tokenState.toJSON(),
    genesis: mintTransaction.toJSON(),
    transactions: [],
    nametags: [],
  };

  // Token.fromJSON creates a token without running verification
  return Token.fromJSON(tokenJson);
}

async function fetchTrustBase(
  aggregatorUrl: string,
): Promise<RootTrustBase | null> {
  try {
    const response = await fetch(`${aggregatorUrl}/api/v1/trust-base`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      console.warn(
        `Could not fetch trust base: ${response.status} ${response.statusText}`,
      );
      return null;
    }
    const data = await response.json();
    return RootTrustBase.fromJSON(data);
  } catch (error) {
    console.warn(`Could not fetch trust base: ${error}`);
    return null;
  }
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

  const privateKeyHex = identityConfig.privateKey;
  const privateKeyBytes = hexToBytes(privateKeyHex);
  const signingService = new SigningService(privateKeyBytes);

  console.log("Public key:", bytesToHex(signingService.publicKey));
  console.log("Nametag:", identityConfig.nametag);

  // Create aggregator client with API key
  const aggregator = new AggregatorClient(aggregatorUrl, apiKey);
  const stateClient = new StateTransitionClient(aggregator);

  // Generate unique token ID using nametag
  const tokenName = `${identity}-${Date.now()}`;
  const tokenId = await TokenId.fromNameTag(tokenName);
  console.log("\nToken ID:", tokenId.toJSON());

  // Create salt for predicate derivation
  const salt = randomBytes(32);

  // Create the predicate that will control this token
  const predicate = await UnmaskedPredicate.create(
    tokenId,
    FUNGIBLE_TOKEN_TYPE,
    signingService,
    HashAlgorithm.SHA256,
    salt,
  );

  // Get predicate reference and create address
  const predicateRef = await predicate.getReference();
  const recipientAddress = await predicateRef.toAddress();

  console.log("Recipient address:", recipientAddress.address);

  // Create coin data with ALPHA balance
  const coinId = CoinId.fromJSON(ALPHA_COIN_ID);
  const coinData = TokenCoinData.create([[coinId, amount]]);

  // Create mint transaction data
  const mintData = await MintTransactionData.create(
    tokenId,
    FUNGIBLE_TOKEN_TYPE,
    null, // tokenData - not needed for fungible
    coinData,
    recipientAddress,
    salt,
    null, // recipientDataHash
    null, // reason
  );

  console.log("\nSubmitting mint commitment to aggregator...");

  // Create mint commitment
  const commitment = await MintCommitment.create(mintData);

  // Submit to aggregator
  const submitResponse = await stateClient.submitMintCommitment(commitment);
  console.log("Submit response:", JSON.stringify(submitResponse, null, 2));

  if (!submitResponse || submitResponse.status !== "SUCCESS") {
    throw new Error(`Submission failed: ${JSON.stringify(submitResponse)}`);
  }

  // The requestId comes from the commitment, not the response
  const requestId = commitment.requestId;
  console.log("Commitment submitted, request ID:", requestId.toJSON());

  // Wait for inclusion proof
  console.log("\nWaiting for inclusion proof...");
  let inclusionProof = null;
  let attempts = 0;
  const maxAttempts = 30;

  while (!inclusionProof && attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attempts++;

    try {
      const proofResponse = await stateClient.getInclusionProof(requestId);
      if (proofResponse.inclusionProof) {
        inclusionProof = proofResponse.inclusionProof;
        console.log("Inclusion proof received!");
      } else {
        process.stdout.write(".");
      }
    } catch {
      process.stdout.write(".");
    }
  }

  if (!inclusionProof) {
    console.error(
      "\n\nFailed to get inclusion proof after",
      maxAttempts,
      "attempts",
    );
    process.exit(1);
  }

  // Create the mint transaction from commitment
  const mintTransaction = commitment.toTransaction(inclusionProof);

  // Create initial token state
  const tokenState = new TokenState(predicate, null);

  // Fetch trust base for verification (optional)
  const trustBase = await fetchTrustBase(aggregatorUrl);

  // Create the final token
  let token: Token<unknown>;
  if (trustBase) {
    try {
      token = await Token.mint(trustBase, tokenState, mintTransaction);
      console.log("\nToken minted and verified!");
    } catch (verifyError) {
      console.warn(
        "\nVerification failed, creating token without verification...",
      );
      // Fall through to manual creation
      token = await createTokenWithoutVerification(tokenState, mintTransaction);
    }
  } else {
    // Create token without verification (for testing)
    console.warn("\nWarning: Could not verify against trust base");
    token = await createTokenWithoutVerification(tokenState, mintTransaction);
  }

  // Save token to file
  if (!existsSync(TOKENS_DIR)) {
    mkdirSync(TOKENS_DIR, { recursive: true });
  }

  const tokenPath = join(
    TOKENS_DIR,
    `${identity}-${tokenId.toJSON().slice(0, 16)}.json`,
  );
  const tokenJson = JSON.stringify(token.toJSON(), null, 2);
  writeFileSync(tokenPath, tokenJson);

  console.log("\n=== Minting Complete ===");
  console.log("Token ID:", tokenId.toJSON());
  console.log("Amount:", amount.toString(), "ALPHA");
  console.log("Saved to:", tokenPath);
  console.log("");
  console.log("To use this token with bounty-net, it will be automatically");
  console.log("loaded from the tokens directory on startup.");
}

// Main
const { identity, amount, aggregatorUrl, apiKey } = parseArgs();
mintTokens(identity, amount, aggregatorUrl, apiKey).catch((error) => {
  console.error("\nMinting failed:", error);
  process.exit(1);
});
