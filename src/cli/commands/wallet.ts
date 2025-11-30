import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";
import { WalletService } from "../../services/wallet/service.js";
import { COINS } from "../../constants/coins.js";

export async function walletBalance(identityName?: string): Promise<void> {
  try {
    const config = await loadConfig();

    // Default to reporter identity if not specified
    const name = identityName ?? config.reporter?.identity;
    if (!name) {
      console.error("No identity specified and no reporter identity configured");
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

    const wallet = new WalletService(identity.privateKey, client);
    const balance = await wallet.getBalance(COINS.ALPHA);

    console.log(`Balance: ${balance} ALPHA`);

    client.disconnect();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}

export async function walletAddress(identityName?: string): Promise<void> {
  try {
    const config = await loadConfig();

    // Default to reporter identity if not specified
    const name = identityName ?? config.reporter?.identity;
    if (!name) {
      console.error("No identity specified and no reporter identity configured");
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
    console.log(`Nametag: ${identity.nametag ?? "(none)"}`);
    console.log(`Public key (hex): ${pubkey}`);
    console.log(`Deposit address: ${pubkey}`);

    // If there's a nametag, show it too
    if (identity.nametag) {
      console.log(`Nametag address: ${identity.nametag}`);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}

export const walletCommands = {
  balance: walletBalance,
  address: walletAddress,
};
