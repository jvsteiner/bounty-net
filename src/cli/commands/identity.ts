import crypto from "crypto";
import fs from "fs";
import { PATHS } from "../../constants/paths.js";
import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";
import { AlphaliteWalletService } from "../../services/wallet/alphalite-wallet.js";

export async function createIdentity(name: string): Promise<void> {
  // Generate a new private key
  const privateKey = crypto.randomBytes(32).toString("hex");

  // Load existing config or create new one
  let config: Record<string, unknown> = {};
  if (fs.existsSync(PATHS.CONFIG)) {
    const raw = fs.readFileSync(PATHS.CONFIG, "utf-8");
    config = JSON.parse(raw);
  }

  // Add the new identity
  if (!config.identities) {
    config.identities = {};
  }
  (config.identities as Record<string, unknown>)[name] = {
    privateKey,
    nametag: `${name}@unicity`,
  };

  // Set as default identity if this is the first identity
  const identityCount = Object.keys(config.identities as Record<string, unknown>).length;
  if (identityCount === 1 || !config.defaultIdentity) {
    config.defaultIdentity = name;
  }

  // Save the config
  fs.mkdirSync(PATHS.BASE_DIR, { recursive: true });
  fs.writeFileSync(PATHS.CONFIG, JSON.stringify(config, null, 2));

  // Derive public key for display
  const client = new BountyNetNostrClient(privateKey);
  const pubkey = client.getPublicKey();

  console.log(`Created identity: ${name}`);
  console.log("");
  console.log(`  Public key: ${pubkey}`);
  console.log(`  Nametag:    ${name}@unicity`);
  console.log(`  Config:     ${PATHS.CONFIG}`);
  console.log("");
  console.log("Private key (back this up!):");
  console.log(`  ${privateKey}`);
}

export async function listIdentities(): Promise<void> {
  try {
    const config = await loadConfig();

    console.log("Configured identities:");
    console.log("");

    for (const [name, identity] of Object.entries(config.identities)) {
      // Try to derive public key (won't work if env var not set)
      let pubkey = "<env var not set>";
      try {
        if (!identity.privateKey.startsWith("env:")) {
          const client = new BountyNetNostrClient(identity.privateKey);
          pubkey = client.getPublicKey();
        }
      } catch {
        // Ignore - env var not set
      }

      console.log(`  ${name}:`);
      console.log(`    nametag: ${identity.nametag ?? "(none)"}`);
      console.log(`    pubkey: ${pubkey}`);
      console.log("");
    }

    // Show default identity
    if (config.defaultIdentity) {
      console.log(`Default identity: ${config.defaultIdentity}`);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export async function registerNametag(
  name: string,
  options: { nametag?: string },
): Promise<void> {
  try {
    const config = await loadConfig();

    const identity = config.identities[name];
    if (!identity) {
      console.error(`Identity not found: ${name}`);
      process.exit(1);
    }

    const nametag = options.nametag ?? identity.nametag;
    if (!nametag) {
      console.error("No nametag specified. Use --nametag or set in config.");
      process.exit(1);
    }

    console.log(`Registering nametag '${nametag}' for identity '${name}'...`);

    // Resolve private key (may be env reference)
    let privateKey = identity.privateKey;
    if (privateKey.startsWith("env:")) {
      const envVar = privateKey.slice(4);
      const value = process.env[envVar];
      if (!value) {
        console.error(`Environment variable ${envVar} not set`);
        process.exit(1);
      }
      privateKey = value;
    }

    const client = new BountyNetNostrClient(privateKey);
    await client.connect(config.relays);

    // Initialize wallet to get the wallet pubkey for nametag binding
    const wallet = new AlphaliteWalletService(
      client,
      name,
      config.aggregatorUrl,
      config.aggregatorApiKey,
      privateKey,
    );
    await wallet.initialize();

    // Get the wallet's 33-byte compressed secp256k1 pubkey for token transfers
    const walletPubkey = wallet.getWalletPubkey();

    console.log(`  NOSTR pubkey:  ${client.getPublicKey()}`);
    console.log(`  Wallet pubkey: ${walletPubkey}`);

    const success = await client.registerNametag(nametag, walletPubkey);

    if (success) {
      console.log(`\nNametag '${nametag}' registered successfully!`);
      console.log(`\nOthers can now:`);
      console.log(`  - Send you NOSTR messages using: ${nametag}`);
      console.log(`  - Send you tokens using the wallet address bound to your nametag`);
    } else {
      console.error("Failed to register nametag");
    }

    client.disconnect();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export async function resolveNametag(nametag: string): Promise<void> {
  try {
    const config = await loadConfig();

    // Get any identity to use for the query (we just need a client connection)
    const identityNames = Object.keys(config.identities);
    if (identityNames.length === 0) {
      console.error("No identities configured. Run 'bounty-net init' first.");
      process.exit(1);
    }

    // Resolve private key (may be env reference)
    let privateKey = config.identities[identityNames[0]].privateKey;
    if (privateKey.startsWith("env:")) {
      const envVar = privateKey.slice(4);
      const value = process.env[envVar];
      if (!value) {
        console.error(`Environment variable ${envVar} not set`);
        process.exit(1);
      }
      privateKey = value;
    }

    const client = new BountyNetNostrClient(privateKey);
    await client.connect(config.relays);

    console.log(`Resolving nametag: ${nametag}`);
    const nostrPubkey = await client.resolveNametag(nametag);

    if (nostrPubkey) {
      console.log(`  NOSTR pubkey: ${nostrPubkey}`);
    } else {
      console.log(`  Not found`);
    }

    client.disconnect();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export const identityCommands = {
  create: createIdentity,
  list: listIdentities,
  register: registerNametag,
  resolve: resolveNametag,
};
