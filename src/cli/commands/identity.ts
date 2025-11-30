import crypto from "crypto";
import fs from "fs";
import { PATHS } from "../../constants/paths.js";
import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";

export async function createIdentity(name: string): Promise<void> {
  // Generate a new private key
  const privateKey = crypto.randomBytes(32).toString("hex");

  console.log(`Generated new identity: ${name}`);
  console.log("");
  console.log("Private key (keep this secret!):");
  console.log(privateKey);
  console.log("");
  console.log("Set it as an environment variable:");
  console.log(`export BOUNTY_NET_${name.toUpperCase()}_KEY="${privateKey}"`);
  console.log("");
  console.log("Then add to your config.json:");
  console.log(`"identities": {`);
  console.log(`  "${name}": {`);
  console.log(`    "privateKey": "env:BOUNTY_NET_${name.toUpperCase()}_KEY",`);
  console.log(`    "nametag": "your-nametag"`);
  console.log(`  }`);
  console.log(`}`);
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

    // Show which identity is used for what
    if (config.reporter?.enabled) {
      console.log(`Reporter identity: ${config.reporter.identity}`);
    }

    if (config.maintainer?.enabled && config.maintainer.inboxes.length > 0) {
      console.log("Maintainer inboxes:");
      for (const inbox of config.maintainer.inboxes) {
        console.log(`  - ${inbox.identity}: ${inbox.repositories.join(", ")}`);
      }
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}

export async function registerNametag(
  name: string,
  options: { nametag?: string }
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

    const client = new BountyNetNostrClient(identity.privateKey);
    await client.connect(config.relays);

    const success = await client.registerNametag(nametag);

    if (success) {
      console.log(`Nametag '${nametag}' registered successfully!`);
      console.log(`Pubkey: ${client.getPublicKey()}`);
    } else {
      console.error("Failed to register nametag");
    }

    client.disconnect();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exit(1);
  }
}

export const identityCommands = {
  create: createIdentity,
  list: listIdentities,
  register: registerNametag,
};
