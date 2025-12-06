import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";
import { AlphaliteWalletService } from "../../services/wallet/alphalite-wallet.js";
import { COINS } from "../../constants/coins.js";

export async function walletBalance(identityName?: string): Promise<void> {
  try {
    const config = await loadConfig();

    // Default to default identity if not specified
    const name = identityName ?? config.defaultIdentity;
    if (!name) {
      console.error(
        "No identity specified and no default identity configured",
      );
      process.exit(1);
    }

    const identity = config.identities[name];
    if (!identity) {
      console.error(`Identity not found: ${name}`);
      process.exit(1);
    }

    console.log(`Checking balance for identity: ${name}`);

    const client = new BountyNetNostrClient(identity.privateKey);
    await client.connect(config.relays);

    const wallet = new AlphaliteWalletService(client, name);
    await wallet.initialize();

    const balance = await wallet.getBalance(COINS.ALPHA);

    console.log(`Balance: ${balance} ALPHA`);

    // Show token details
    const tokens = wallet.listTokens();
    if (tokens.length > 0) {
      console.log(`\nTokens (${tokens.length}):`);
      for (const token of tokens) {
        console.log(`  ${token.id.slice(0, 16)}... : ${token.balance} ALPHA`);
      }
    }

    client.disconnect();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export async function walletAddress(identityName?: string): Promise<void> {
  try {
    const config = await loadConfig();

    // Default to default identity if not specified
    const name = identityName ?? config.defaultIdentity;
    if (!name) {
      console.error(
        "No identity specified and no default identity configured",
      );
      process.exit(1);
    }

    const identity = config.identities[name];
    if (!identity) {
      console.error(`Identity not found: ${name}`);
      process.exit(1);
    }

    const client = new BountyNetNostrClient(identity.privateKey);
    const pubkey = client.getPublicKey();

    console.log(`Identity: ${name}`);
    console.log("");

    if (identity.nametag) {
      console.log(`Deposit address: ${identity.nametag}`);
      console.log("");
      console.log("Share this nametag with others to receive tokens.");
    } else {
      console.log("No nametag registered.");
      console.log("");
      console.log("Register one with:");
      console.log(
        `  bounty-net identity register ${name} --nametag yourname@unicity`,
      );
    }

    console.log("");
    console.log(`NOSTR pubkey: ${pubkey}`);
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export async function walletMint(
  identityName: string | undefined,
  amountStr: string | undefined,
): Promise<void> {
  try {
    const config = await loadConfig();

    // Default to default identity if not specified
    const name = identityName ?? config.defaultIdentity;
    if (!name) {
      console.error(
        "No identity specified and no default identity configured",
      );
      process.exit(1);
    }

    const identity = config.identities[name];
    if (!identity) {
      console.error(`Identity not found: ${name}`);
      process.exit(1);
    }

    const amount = amountStr ? BigInt(amountStr) : BigInt(100);

    console.log(`Minting ${amount} ALPHA tokens for identity: ${name}`);
    console.log("");
    console.log("Run the minting script:");
    console.log(
      `  npx tsx scripts/mint-tokens.ts --identity ${name} --amount ${amount}`,
    );
    console.log("");
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export const walletCommands = {
  balance: walletBalance,
  address: walletAddress,
  mint: walletMint,
};
