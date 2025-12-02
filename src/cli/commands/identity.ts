import crypto from "crypto";
import fs from "fs";
import { PATHS } from "../../constants/paths.js";
import { loadConfig } from "../../config/loader.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";

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

  // Set as reporter identity if reporter is enabled or this is the first identity
  if (config.reporter && typeof config.reporter === "object") {
    (config.reporter as Record<string, unknown>).identity = name;
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

    const identity = config.identities[identityNames[0]];
    const client = new BountyNetNostrClient(identity.privateKey);
    await client.connect(config.relays);

    console.log(`Resolving nametag: ${nametag}`);
    const pubkey = await client.resolveNametag(nametag);

    if (pubkey) {
      console.log(`  Pubkey: ${pubkey}`);
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
