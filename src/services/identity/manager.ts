import { BountyNetNostrClient } from "../nostr/client.js";
import { AlphaliteWalletService } from "../wallet/alphalite-wallet.js";
import { createLogger } from "../../utils/logger.js";
import type { Config, Identity } from "../../types/config.js";

const logger = createLogger("identity");

export interface ManagedIdentity {
  name: string;
  privateKey: string;
  client: BountyNetNostrClient;
  wallet: AlphaliteWalletService;
  nametag?: string;
}

/**
 * IdentityManager manages multiple identities, each with its own
 * NOSTR client and Alphalite wallet.
 */
export class IdentityManager {
  private identities: Map<string, ManagedIdentity> = new Map();
  private relays: string[];

  constructor(private config: Config) {
    this.relays = config.relays;
  }

  async initialize(): Promise<void> {
    logger.info("Initializing identity manager");

    // Initialize all configured identities
    for (const [name, identity] of Object.entries(this.config.identities)) {
      await this.addIdentity(name, identity);
    }

    logger.info(`Loaded ${this.identities.size} identities`);
  }

  private async addIdentity(name: string, identity: Identity): Promise<void> {
    logger.info(`Adding identity: ${name}`);

    const client = new BountyNetNostrClient(identity.privateKey);
    await client.connect(this.relays);

    // Create Alphalite wallet for this identity
    // Note: We create wallet first so we can use wallet pubkey for nametag registration
    // Pass the private key so the wallet identity matches the NOSTR identity
    const wallet = new AlphaliteWalletService(
      client,
      name,
      this.config.aggregatorUrl,
      this.config.aggregatorApiKey,
      this.resolvePrivateKey(identity.privateKey),
    );

    // Initialize wallet (loads from disk or creates new)
    await wallet.initialize();

    // Register nametag if configured and not already registered
    // Must happen after wallet init so we have the wallet pubkey
    if (identity.nametag) {
      const existingNostrPubkey = await client.resolveNametag(identity.nametag);
      const myWalletPubkey = wallet.getWalletPubkey();

      if (!existingNostrPubkey) {
        // Nametag not registered at all - register it with wallet pubkey
        logger.info(`Registering nametag: ${identity.nametag} with wallet pubkey`);
        await client.registerNametag(identity.nametag, myWalletPubkey);
      } else if (existingNostrPubkey !== client.getPublicKey()) {
        // Nametag registered to a different NOSTR pubkey
        logger.warn(
          `Nametag ${identity.nametag} is registered to a different pubkey`,
        );
      }
    }

    this.identities.set(name, {
      name,
      privateKey: identity.privateKey,
      client,
      wallet,
      nametag: identity.nametag,
    });

    logger.info(
      `Identity ${name} initialized (pubkey: ${client.getPublicKey().slice(0, 16)}...)`,
    );
  }

  get(name: string): ManagedIdentity | undefined {
    return this.identities.get(name);
  }

  getFirst(): ManagedIdentity | undefined {
    const first = this.identities.values().next();
    return first.done ? undefined : first.value;
  }

  getDefaultIdentity(): ManagedIdentity | undefined {
    if (this.config.defaultIdentity) {
      return this.identities.get(this.config.defaultIdentity);
    }
    // Fall back to first identity
    return this.getFirst();
  }

  getAllIdentities(): ManagedIdentity[] {
    return Array.from(this.identities.values());
  }

  listIdentities(): string[] {
    return Array.from(this.identities.keys());
  }

  getPublicKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    for (const [name, identity] of this.identities) {
      keys.set(name, identity.client.getPublicKey());
    }
    return keys;
  }

  disconnect(): void {
    logger.info("Disconnecting all identities");
    for (const identity of this.identities.values()) {
      identity.client.disconnect();
    }
    this.identities.clear();
  }

  /**
   * Resolve private key from config value (may be env reference like "env:VAR_NAME")
   */
  private resolvePrivateKey(privateKey: string): string {
    if (privateKey.startsWith("env:")) {
      const envVar = privateKey.slice(4);
      const value = process.env[envVar];
      if (!value) {
        throw new Error(`Environment variable ${envVar} not set`);
      }
      return value;
    }
    return privateKey;
  }
}
