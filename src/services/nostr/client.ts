import {
  NostrKeyManager,
  NostrClient,
  Event,
  Filter,
  CallbackEventListener,
  hashNametag,
} from "@unicitylabs/nostr-js-sdk";
import { createLogger } from "../../utils/logger.js";
import { EVENT_KINDS } from "../../constants/event-kinds.js";
import type {
  BugReportContent,
  BugResponseContent,
  Bounty,
} from "../../types/events.js";

const logger = createLogger("nostr-client");

/**
 * BountyNetNostrClient wraps NOSTR operations for bug reporting.
 * Uses @unicitylabs/nostr-js-sdk for all protocol operations.
 */
export class BountyNetNostrClient {
  private keyManager: NostrKeyManager;
  private client: NostrClient;
  private relays: string[] = [];
  private subscriptionIds: Map<string, string> = new Map();

  constructor(privateKeyHex: string) {
    this.keyManager = NostrKeyManager.fromPrivateKeyHex(privateKeyHex);
    this.client = new NostrClient(this.keyManager);
  }

  async connect(relays: string[]): Promise<void> {
    this.relays = relays;
    logger.info(`Connecting to relays: ${relays.join(", ")}`);

    await this.client.connect(...relays);

    logger.info("Connected to relays");
  }

  disconnect(): void {
    // Unsubscribe from all active subscriptions
    for (const [name, subId] of this.subscriptionIds.entries()) {
      logger.debug(`Unsubscribing: ${name} (${subId})`);
      this.client.unsubscribe(subId);
    }
    this.subscriptionIds.clear();

    this.client.disconnect();
    logger.info("Disconnected from relays");
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  getPublicKey(): string {
    return this.keyManager.getPublicKeyHex();
  }

  getRelays(): string[] {
    return [...this.relays];
  }

  // Nametag operations
  async registerNametag(nametag: string): Promise<boolean> {
    logger.info(`Registering nametag: ${nametag}`);
    // The SDK's publishNametagBinding expects a Unicity address
    // For now, we use the public key as a simple binding
    const success = await this.client.publishNametagBinding(
      nametag,
      this.getPublicKey(),
    );
    return success;
  }

  async resolveNametag(nametag: string): Promise<string | null> {
    logger.debug(`Resolving nametag: ${nametag}`);
    const pubkey = await this.client.queryPubkeyByNametag(nametag);
    return pubkey;
  }

  // Bug report publishing (reporter role)
  async publishBugReport(
    content: BugReportContent,
    recipientPubkey: string,
  ): Promise<string> {
    logger.info(
      `Publishing bug report ${content.bug_id} to ${recipientPubkey.slice(0, 16)}...`,
    );

    // Encrypt the content for the recipient
    const encrypted = await this.keyManager.encryptHex(
      JSON.stringify(content),
      recipientPubkey,
    );

    // Build tags
    const tags: string[][] = [
      ["d", content.bug_id],
      ["repo", content.repo],
      ["severity", content.severity],
      ["p", recipientPubkey],
    ];

    if (content.file) {
      tags.push(["file", content.file, content.line_start?.toString() ?? ""]);
    }
    if (content.category) {
      tags.push(["category", content.category]);
    }
    if (content.agent_model) {
      tags.push(["agent", content.agent_model, content.agent_version ?? ""]);
    }
    if (content.deposit_tx) {
      tags.push(["deposit", content.deposit_tx]);
      tags.push(["deposit_amount", content.deposit_amount ?? "0"]);
    }

    // Create and publish the event
    const eventId = await this.client.createAndPublishEvent({
      kind: EVENT_KINDS.BUG_REPORT,
      tags,
      content: encrypted,
    });

    logger.info(`Bug report published: ${eventId}`);
    return eventId;
  }

  // Bug response publishing (maintainer role)
  async publishBugResponse(
    content: BugResponseContent,
    recipientPubkey: string,
    originalEventId: string,
  ): Promise<string> {
    logger.info(`Publishing response for report ${content.report_id}`);

    // Encrypt the content for the recipient
    const encrypted = await this.keyManager.encryptHex(
      JSON.stringify(content),
      recipientPubkey,
    );

    const tags: string[][] = [
      ["d", crypto.randomUUID()],
      ["e", originalEventId],
      ["report_id", content.report_id],
      ["response_type", content.response_type],
      ["p", recipientPubkey],
    ];

    if (content.commit_hash) {
      tags.push(["commit", content.commit_hash]);
    }
    if (content.bounty_paid) {
      tags.push(["bounty_paid", content.bounty_paid]);
    }

    const eventId = await this.client.createAndPublishEvent({
      kind: EVENT_KINDS.BUG_RESPONSE,
      tags,
      content: encrypted,
    });

    logger.info(`Response published: ${eventId}`);
    return eventId;
  }

  // Subscribe to incoming bug reports (maintainer role)
  subscribeToReports(
    since: number,
    onReport: (event: Event, content: BugReportContent) => void,
  ): string {
    const myPubkey = this.getPublicKey();

    const filter = Filter.builder()
      .kinds(EVENT_KINDS.BUG_REPORT)
      .pTags(myPubkey)
      .since(since)
      .build();

    logger.debug(`Subscribe filter: ${JSON.stringify(filter)}`);

    const listener = new CallbackEventListener(
      async (event: Event) => {
        logger.debug(
          `Received event: ${event.id.slice(0, 16)}... from ${event.pubkey.slice(0, 16)}...`,
        );
        try {
          // Decrypt the content
          const decrypted = await this.keyManager.decryptHex(
            event.content,
            event.pubkey,
          );
          const content = JSON.parse(decrypted) as BugReportContent;
          onReport(event, content);
        } catch (error) {
          logger.error(`Failed to decrypt bug report ${event.id}:`, error);
        }
      },
      (subId) => {
        logger.debug(`End of stored events for reports subscription: ${subId}`);
      },
      (subId, error) => {
        logger.error(`Subscription error (${subId}): ${error}`);
      },
    );

    const subId = this.client.subscribe(filter, listener);
    this.subscriptionIds.set("reports", subId);

    logger.info(
      `Subscribed to bug reports since ${new Date(since * 1000).toISOString()}`,
    );
    return subId;
  }

  // Subscribe to responses for sent reports (reporter role)
  subscribeToResponses(
    since: number,
    onResponse: (event: Event, content: BugResponseContent) => void,
  ): string {
    const myPubkey = this.getPublicKey();

    const filter = Filter.builder()
      .kinds(EVENT_KINDS.BUG_RESPONSE)
      .pTags(myPubkey)
      .since(since)
      .build();

    const listener = new CallbackEventListener(
      async (event: Event) => {
        try {
          const decrypted = await this.keyManager.decryptHex(
            event.content,
            event.pubkey,
          );
          const content = JSON.parse(decrypted) as BugResponseContent;
          onResponse(event, content);
        } catch (error) {
          logger.error(`Failed to decrypt response ${event.id}:`, error);
        }
      },
      (subId) => {
        logger.debug(
          `End of stored events for responses subscription: ${subId}`,
        );
      },
      (subId, error) => {
        logger.error(`Subscription error (${subId}): ${error}`);
      },
    );

    const subId = this.client.subscribe(filter, listener);
    this.subscriptionIds.set("responses", subId);

    logger.info(
      `Subscribed to responses since ${new Date(since * 1000).toISOString()}`,
    );
    return subId;
  }

  // Subscribe to bounty announcements
  subscribeToBounties(
    repos: string[],
    since: number,
    onBounty: (event: Event, content: Bounty) => void,
  ): string {
    const filter = Filter.builder()
      .kinds(EVENT_KINDS.BOUNTY)
      .since(since)
      .build();

    const listener = new CallbackEventListener(
      (event: Event) => {
        try {
          // Bounty events are public (not encrypted)
          const content = JSON.parse(event.content) as Bounty;

          // Filter by repos if specified
          if (repos.length > 0) {
            const repoTag = event.getTagValue("repo");
            if (!repoTag || !repos.includes(repoTag)) {
              return;
            }
          }

          onBounty(event, content);
        } catch (error) {
          logger.error(`Failed to parse bounty ${event.id}:`, error);
        }
      },
      (subId) => {
        logger.debug(
          `End of stored events for bounties subscription: ${subId}`,
        );
      },
    );

    const subId = this.client.subscribe(filter, listener);
    this.subscriptionIds.set("bounties", subId);

    logger.info(`Subscribed to bounties for ${repos.length} repos`);
    return subId;
  }

  // Query for responses (one-time fetch for backfill)
  async queryResponses(
    since: number,
  ): Promise<Array<{ event: Event; content: BugResponseContent }>> {
    logger.info(
      `Querying responses since ${new Date(since * 1000).toISOString()}`,
    );

    const myPubkey = this.getPublicKey();
    const results: Array<{ event: Event; content: BugResponseContent }> = [];
    const pendingPromises: Promise<void>[] = [];

    return new Promise((resolve) => {
      const filter = Filter.builder()
        .kinds(EVENT_KINDS.BUG_RESPONSE)
        .pTags(myPubkey)
        .since(since)
        .build();

      logger.debug(
        `Query filter - kind: ${EVENT_KINDS.BUG_RESPONSE}, p: ${myPubkey}, since: ${since}`,
      );

      const listener = new CallbackEventListener(
        (event: Event) => {
          logger.debug(
            `queryResponses received event: ${event.id.slice(0, 16)}...`,
          );
          // Track the async processing so we can wait for it on EOSE
          const processPromise = (async () => {
            try {
              const decrypted = await this.keyManager.decryptHex(
                event.content,
                event.pubkey,
              );
              const content = JSON.parse(decrypted) as BugResponseContent;
              logger.debug(
                `Decrypted response for report: ${content.report_id}`,
              );
              results.push({ event, content });
            } catch (error) {
              logger.error(`Failed to decrypt response ${event.id}:`, error);
            }
          })();
          pendingPromises.push(processPromise);
        },
        async (_subId) => {
          // Wait for all pending event processing to complete
          await Promise.all(pendingPromises);
          logger.debug(
            `queryResponses EOSE - found ${results.length} responses`,
          );
          resolve(results);
        },
      );

      const subId = this.client.subscribe(filter, listener);

      // Set a timeout in case EOSE never comes
      setTimeout(async () => {
        await Promise.all(pendingPromises);
        this.client.unsubscribe(subId);
        resolve(results);
      }, 10000);
    });
  }

  // Unsubscribe from a specific subscription
  unsubscribe(name: string): void {
    const subId = this.subscriptionIds.get(name);
    if (subId) {
      this.client.unsubscribe(subId);
      this.subscriptionIds.delete(name);
      logger.debug(`Unsubscribed from ${name}`);
    }
  }

  // Get the underlying SDK client for advanced operations
  getSDKClient(): NostrClient {
    return this.client;
  }

  // Get the key manager for encryption/decryption
  getKeyManager(): NostrKeyManager {
    return this.keyManager;
  }
}
