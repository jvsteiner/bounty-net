import { readFileSync } from "fs";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";
import TESTNET_TRUST_BASE from "../src/trustbase.json" with { type: "json" };

async function main() {
  const tokenPath = process.argv[2];
  if (!tokenPath) {
    console.error("Usage: npx tsx scripts/verify-token.ts <token-path>");
    process.exit(1);
  }
  
  const tokenJson = JSON.parse(readFileSync(tokenPath, "utf-8"));
  const token = await Token.fromJSON(tokenJson);
  
  console.log("Token ID:", token.id.toJSON().slice(0, 20) + "...");
  console.log("Transactions:", tokenJson.transactions?.length ?? 0);
  
  const trustBase = RootTrustBase.fromJSON(TESTNET_TRUST_BASE);
  
  try {
    const result = await token.verify(trustBase);
    console.log("Verification result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Verification error:", error.message);
  }
}

main().catch(console.error);
