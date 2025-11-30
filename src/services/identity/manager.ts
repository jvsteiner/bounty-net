import { BountyNetNostrClient } from "../nostr/client.js";
import { WalletService } from "../wallet/service.js";
import { createLogger } from "../../utils/logger.js";
import type { Config, Identity } from "../../types/config.js";

const logger = createLogger("identity");

export interface ManagedIdentity {
  name: string;
  privateKey: string;
  client: BountyNetNostrClient;
  wallet: WalletService;
  nametag?: string;
}

/**
 * IdentityManager manages multiple identities, each with its own
 * NOSTR client and wallet.
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

    // Register nametag if configured and not already registered
    if (identity.nametag) {
      const existing = await client.resolveNametag(identity.nametag);
      if (!existing) {
        logger.info(`Registering nametag: ${identity.nametag}`);
        await client.registerNametag(identity.nametag);
      } else if (existing !== client.getPublicKey()) {
        logger.warn(
          `Nametag ${identity.nametag} is registered to a different pubkey`
        );
      }
    }

    const wallet = new WalletService(identity.privateKey, client);

    this.identities.set(name, {
      name,
      privateKey: identity.privateKey,
      client,
      wallet,
      nametag: identity.nametag,
    });

    logger.info(
      `Identity ${name} initialized (pubkey: ${client.getPublicKey().slice(0, 16)}...)`
    );
  }

  get(name: string): ManagedIdentity | undefined {
    return this.identities.get(name);
  }

  getReporterIdentity(): ManagedIdentity | undefined {
    if (!this.config.reporter?.identity) return undefined;
    return this.identities.get(this.config.reporter.identity);
  }

  getInboxIdentity(inboxName: string): ManagedIdentity | undefined {
    const inbox = this.config.maintainer.inboxes.find(
      (i) => i.identity === inboxName
    );
    if (!inbox) return undefined;
    return this.identities.get(inbox.identity);
  }

  getAllInboxIdentities(): ManagedIdentity[] {
    return this.config.maintainer.inboxes
      .map((inbox) => this.identities.get(inbox.identity))
      .filter((id): id is ManagedIdentity => id !== undefined);
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
}
