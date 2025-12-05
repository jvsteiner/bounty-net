#!/usr/bin/env npx tsx
/**
 * Debug wallet identity vs token address mismatch
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { Wallet, AlphaClient, RootTrustBase } from "@jvsteiner/alphalite";
import { TokenType } from "@unicitylabs/state-transition-sdk/lib/token/TokenType.js";

const TRUSTBASE_PATH = "./src/trustbase.json";

async function main() {
  const walletJson = JSON.parse(
    readFileSync("/Users/jamie/.bounty-net/wallets/jamie-bounty.json", "utf-8")
  );
  const wallet = await Wallet.fromJSON(walletJson);

  // Get default identity
  const identity = wallet.getDefaultIdentity();
  console.log("=== Wallet Identity ===");
  console.log("ID:", identity.id);
  console.log("Label:", identity.label);
  console.log("PublicKey (hex):", Buffer.from(identity.publicKey).toString("hex"));

  // Get the signing service
  const signingService = await identity.getSigningService();
  console.log("\n=== Signing Service ===");
  console.log("PublicKey (hex):", Buffer.from(signingService.publicKey).toString("hex"));

  // Get address for default token type
  const tokenType = new TokenType(new Uint8Array(32).fill(0x01));
  const derivedAddress = await identity.getAddress(tokenType);
  console.log("\n=== Derived Address ===");
  console.log("Address:", derivedAddress);

  // Check token
  const tokens = wallet.listTokens();
  if (tokens.length > 0) {
    const tokenEntry = tokens[0];
    const token = tokenEntry.token;
    const rawToken = token.raw;

    console.log("\n=== Token Info ===");
    console.log("Token ID:", token.id);
    console.log("Token identityId:", tokenEntry.identityId);
    console.log("Token salt:", tokenEntry.salt);

    // Get recipient from genesis
    const genesisRecipient = rawToken.genesis?.data?.recipient;
    console.log("\n=== Genesis Recipient ===");
    console.log("Recipient:", genesisRecipient?.toString());

    // Compare
    console.log("\n=== Comparison ===");
    const match = derivedAddress === genesisRecipient?.toString();
    console.log("Addresses match:", match ? "YES ✓" : "NO ✗");

    if (!match) {
      console.log("\nMISMATCH DETECTED!");
      console.log("Derived:  ", derivedAddress);
      console.log("Genesis:  ", genesisRecipient?.toString());
    }

    // Now try to actually sign and see what happens
    console.log("\n=== Attempting Token Operations ===");

    const apiKey = process.env.UNICITY_AGGREGATOR_APIKEY;
    if (!apiKey) {
      console.log("No API key - skipping operation test");
      return;
    }

    const client = new AlphaClient({
      gatewayUrl: "https://goggregator-test.unicity.network",
      apiKey,
    });

    const trustBaseJson = JSON.parse(readFileSync(TRUSTBASE_PATH, "utf-8"));
    const trustBase = RootTrustBase.fromJSON(trustBaseJson);
    client.setTrustBase(trustBase);

    // Try a tiny send
    try {
      console.log("Attempting to send 1 ALPHA...");
      const result = await client.sendAmount(
        wallet,
        "414c504841", // ALPHA
        1n,
        "ca3feb7fac39853237dfb2f0a9f3b1b29fac27d9a17abf8bc12f2aa5ae1f9e4a" // test recipient
      );
      console.log("SUCCESS! Sent:", result.sent.toString());
    } catch (error: any) {
      console.log("\nERROR:", error.message);
      if (error.verificationResult) {
        console.log("Verification status:", error.verificationResult.status);
        console.log("Verification message:", error.verificationResult.message);
      }
    }
  }
}

main().catch(console.error);
