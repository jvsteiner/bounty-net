/**
 * Wallet service using Alphalite library.
 *
 * Each identity gets its own wallet file stored in ~/.bounty-net/wallets/
 */

import { Wallet, AlphaClient, RootTrustBase } from "@jvsteiner/alphalite";
import {
  TokenTransferProtocol,
  Filter,
  CallbackEventListener,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { createLogger } from "../../utils/logger.js";
import { PATHS } from "../../constants/paths.js";
import { COINS, DEFAULT_AGGREGATOR_URL } from "../../constants/coins.js";
import type { BountyNetNostrClient } from "../nostr/client.js";
import TESTNET_TRUST_BASE from "../../trustbase.json" with { type: "json" };

const logger = createLogger("wallet");

// Hard cutoff: ignore ALL events before this timestamp (December 5, 2025 - schema v2)
// This ensures old token transfers with incompatible formats are never processed
const SCHEMA_V2_CUTOFF = 1733400000; // ~Dec 5, 2025 12:00 UTC

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export interface TransferResult {
  success: boolean;
  txHash?: string;
  recipientPayload?: string;
  error?: string;
}

/**
 * AlphaliteWalletService wraps the Alphalite library for bounty-net.
 *
 * Key differences from old WalletService:
 * - Stores entire wallet (with tokens) in a single JSON file per identity
 * - Uses Alphalite's sendAmount/receiveAmount for automatic splitting
 * - Adopts Alphalite's payload format for transfers
 */
export class AlphaliteWalletService {
  private wallet: Wallet | null = null;
  private client: AlphaClient;
  private identityName: string;
  private walletPath: string;
  private identitySecret: Uint8Array | undefined;

  constructor(
    private nostrClient: BountyNetNostrClient,
    identityName: string,
    aggregatorUrl: string = DEFAULT_AGGREGATOR_URL,
    aggregatorApiKey?: string,
    identityPrivateKey?: string,
  ) {
    this.identityName = identityName;
    this.walletPath = join(PATHS.WALLETS, `${identityName}.json`);

    // Store the identity private key as bytes for wallet creation
    // This ensures the wallet identity matches the NOSTR identity
    if (identityPrivateKey) {
      this.identitySecret = hexToBytes(identityPrivateKey);
    }

    // Create Alphalite client with state change callback for transaction safety
    // This ensures wallet is saved immediately after each blockchain transaction,
    // preventing out-of-sync state if subsequent operations fail
    this.client = new AlphaClient({
      gatewayUrl: aggregatorUrl,
      apiKey: aggregatorApiKey,
      onWalletStateChange: async () => {
        this.saveWallet();
        logger.debug(`Wallet saved after blockchain transaction`);
      },
    });

    // Set trust base
    const trustBase = RootTrustBase.fromJSON(TESTNET_TRUST_BASE);
    this.client.setTrustBase(trustBase);
  }

  /**
   * Initialize wallet - load from disk or create new
   */
  async initialize(): Promise<void> {
    // Ensure wallets directory exists
    if (!existsSync(PATHS.WALLETS)) {
      mkdirSync(PATHS.WALLETS, { recursive: true });
    }

    if (existsSync(this.walletPath)) {
      // Load existing wallet
      try {
        const json = JSON.parse(readFileSync(this.walletPath, "utf-8"));
        this.wallet = await Wallet.fromJSON(json);
        logger.info(
          `Loaded wallet for ${this.identityName} with ${this.wallet.listTokens().length} tokens`,
        );
      } catch (error) {
        logger.error(`Failed to load wallet: ${error}`);
        throw error;
      }
    } else {
      // Create new wallet using the NOSTR identity private key
      // This ensures the wallet identity matches the NOSTR identity
      this.wallet = await Wallet.create({
        name: this.identityName,
        identityLabel: "default",
        identitySecret: this.identitySecret,
      });
      this.saveWallet();
      logger.info(`Created new wallet for ${this.identityName}`);
    }
  }

  /**
   * Save wallet to disk
   */
  private saveWallet(): void {
    if (!this.wallet) return;

    const json = this.wallet.toJSON({ includeTokens: true });
    writeFileSync(this.walletPath, JSON.stringify(json, null, 2));
    logger.debug(`Saved wallet for ${this.identityName}`);
  }

  /**
   * Reload wallet from disk (useful when another process may have modified it)
   */
  async reload(): Promise<void> {
    if (existsSync(this.walletPath)) {
      const json = JSON.parse(readFileSync(this.walletPath, "utf-8"));
      this.wallet = await Wallet.fromJSON(json);
      logger.debug(
        `Reloaded wallet for ${this.identityName} with ${this.wallet.listTokens().length} tokens`,
      );
    }
  }

  /**
   * Get the wallet instance
   */
  getWallet(): Wallet {
    if (!this.wallet) {
      throw new Error("Wallet not initialized");
    }
    return this.wallet;
  }

  /**
   * Get NOSTR public key (from the NOSTR client, not the wallet)
   */
  getPublicKey(): string {
    return this.nostrClient.getPublicKey();
  }

  /**
   * Get wallet balance for a coin ID
   * @param coinId Hex-encoded coin ID (default: ALPHA)
   */
  async getBalance(coinId: string = COINS.ALPHA): Promise<bigint> {
    if (!this.wallet) {
      throw new Error("Wallet not initialized");
    }
    return this.wallet.getBalance(coinId);
  }

  /**
   * Mint new tokens (for testing)
   * @param coinId Hex-encoded coin ID (default: ALPHA)
   */
  async mint(
    amount: bigint,
    coinId: string = COINS.ALPHA,
  ): Promise<{ tokenId: string }> {
    if (!this.wallet) {
      throw new Error("Wallet not initialized");
    }

    const token = await this.client.mint(this.wallet, {
      coins: [[coinId, amount]],
      label: `Minted ${amount} (coinId: ${coinId})`,
    });

    this.saveWallet();
    logger.info(
      `Minted ${amount} (coinId: ${coinId}), token: ${token.id.slice(0, 16)}...`,
    );

    return { tokenId: token.id };
  }

  /**
   * Send deposit payment to maintainer
   * @param coinId Hex-encoded coin ID (default: ALPHA)
   */
  async sendDeposit(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA,
  ): Promise<TransferResult> {
    logger.info(
      `Sending deposit: ${amount} to ${recipientPubkey.slice(0, 16)}... for report ${reportId}`,
    );

    return this.sendAmount(recipientPubkey, amount, coinId, {
      type: "deposit",
      reportId,
    });
  }

  /**
   * Send refund back to reporter (maintainer accepting report)
   * @param coinId Hex-encoded coin ID (default: ALPHA)
   */
  async sendRefund(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA,
  ): Promise<TransferResult> {
    logger.info(
      `Sending refund: ${amount} to ${recipientPubkey.slice(0, 16)}... for report ${reportId}`,
    );

    return this.sendAmount(recipientPubkey, amount, coinId, {
      type: "refund",
      reportId,
    });
  }

  /**
   * Send bounty payment (maintainer paying reporter)
   * @param coinId Hex-encoded coin ID (default: ALPHA)
   */
  async sendBounty(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA,
  ): Promise<TransferResult> {
    logger.info(
      `Sending bounty: ${amount} to ${recipientPubkey.slice(0, 16)}... for report ${reportId}`,
    );

    return this.sendAmount(recipientPubkey, amount, coinId, {
      type: "bounty",
      reportId,
    });
  }

  /**
   * Send an amount using Alphalite's sendAmount (handles splitting automatically)
   */
  private async sendAmount(
    recipientPubkey: string,
    amount: bigint,
    coinId: string,
    metadata: { type: string; reportId: string },
  ): Promise<TransferResult> {
    if (!this.wallet) {
      return { success: false, error: "Wallet not initialized" };
    }

    try {
      // Use Alphalite's sendAmount which handles token selection and splitting
      logger.info(`Calling client.sendAmount with coinId=${coinId}, amount=${amount}`);
      const result = await this.client.sendAmount(
        this.wallet,
        coinId,
        amount,
        recipientPubkey,
      );
      logger.info(`sendAmount returned successfully, sent=${result.sent}`);

      // Note: Wallet is automatically saved by onWalletStateChange callback
      // after each blockchain transaction, ensuring atomic persistence

      logger.info(
        `Transfer complete: sent ${result.sent}, ` +
          `tokens used: ${result.tokensUsed}, split: ${result.splitPerformed}`,
      );

      // Verify we're connected before sending via NOSTR
      if (!this.nostrClient.isConnected()) {
        return {
          success: false,
          error: "Not connected to NOSTR relays - token transfer not sent",
        };
      }

      // Wrap the payload with our metadata for NOSTR transmission
      const nostrPayload = JSON.stringify({
        alphalitePayload: result.recipientPayload,
        metadata: {
          type: metadata.type,
          reportId: metadata.reportId,
          amount: amount.toString(),
          coinId,
        },
      });

      // Send via NOSTR
      const sdkClient = this.nostrClient.getSDKClient();
      const eventId = await sdkClient.sendTokenTransfer(
        recipientPubkey,
        nostrPayload,
      );

      if (!eventId) {
        return {
          success: false,
          error: "Failed to publish token transfer to NOSTR",
        };
      }

      logger.info(`Token transfer published to NOSTR: ${eventId}`);

      return {
        success: true,
        txHash: eventId,
        recipientPayload: result.recipientPayload,
      };
    } catch (error) {
      logger.error(`Caught error - type: ${typeof error}, constructor: ${error?.constructor?.name}`);
      let message: string;
      if (error instanceof Error) {
        message = error.message;
        logger.error(`Error message: ${message}`);
        // Check for verificationResult (Alphalite VerificationError)
        // VerificationResult has: status, message, and nested results[]
        const verificationResult = (error as { verificationResult?: { status?: unknown; message?: string; results?: unknown[]; toString?: () => string } }).verificationResult;
        if (verificationResult) {
          // Log the toString() output which is nicely formatted
          if (typeof verificationResult.toString === 'function') {
            logger.error(`Verification result:\n${verificationResult.toString()}`);
          }
          // Also log key fields individually for parsing
          logger.error(`Verification status: ${verificationResult.status}`);
          logger.error(`Verification message: ${verificationResult.message}`);
          if (verificationResult.results && verificationResult.results.length > 0) {
            for (let i = 0; i < verificationResult.results.length; i++) {
              const nested = verificationResult.results[i] as { status?: unknown; message?: string; toString?: () => string };
              if (typeof nested?.toString === 'function') {
                logger.error(`Nested result ${i}:\n${nested.toString()}`);
              }
            }
          }
        }
      } else if (typeof error === "object" && error !== null) {
        message = JSON.stringify(error);
        logger.error(`Error object: ${message}`);
      } else {
        message = String(error);
        logger.error(`Error: ${message}`);
      }
      logger.error(`Token transfer failed: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Receive tokens from a transfer payload
   */
  async receiveTokens(payloadJson: string): Promise<boolean> {
    if (!this.wallet) {
      logger.error("Wallet not initialized");
      return false;
    }

    try {
      // Parse the NOSTR wrapper to get the Alphalite payload
      const wrapper = JSON.parse(payloadJson);
      const alphalitePayload = wrapper.alphalitePayload ?? payloadJson;

      // Use Alphalite's receiveAmount which handles both single and multi-token
      const tokens = await this.client.receiveAmount(
        this.wallet,
        alphalitePayload,
      );

      // Save wallet with new tokens
      this.saveWallet();

      logger.info(`Received ${tokens.length} token(s)`);
      for (const token of tokens) {
        logger.info(
          `  Token ${token.id.slice(0, 16)}...: ${token.getCoinBalance(COINS.ALPHA)} ALPHA`,
        );
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to receive tokens: ${message}`);
      return false;
    }
  }

  /**
   * Get all tokens in the wallet
   */
  listTokens(): Array<{ id: string; balance: bigint; label?: string }> {
    if (!this.wallet) return [];

    return this.wallet.listTokens().map((entry) => ({
      id: entry.token.id,
      balance: entry.token.getCoinBalance(COINS.ALPHA),
      label: entry.label,
    }));
  }

  /**
   * Subscribe to incoming token transfers via NOSTR
   * @param onTransfer Callback when a transfer is received
   * @param since Unix timestamp to only receive transfers after this time
   */
  subscribeToTransfers(
    onTransfer: (from: string, amount: string, success: boolean) => void,
    since?: number,
  ): void {
    logger.info(
      `Subscribing to incoming transfers${since ? ` since ${new Date(since * 1000).toISOString()}` : ""}`,
    );

    const keyManager = this.nostrClient.getKeyManager();
    const myPubkey = this.getPublicKey();
    const sdkClient = this.nostrClient.getSDKClient();

    // Token transfer event kind (Unicity custom)
    const TOKEN_TRANSFER_KIND = 31113;

    const filterBuilder = Filter.builder()
      .kinds(TOKEN_TRANSFER_KIND)
      .pTags(myPubkey);

    if (since) {
      filterBuilder.since(since);
    }

    const filter = filterBuilder.build();

    const listener = new CallbackEventListener(async (event: Event) => {
      try {
        // Skip events before schema v2 cutoff - old events have incompatible formats
        if (event.created_at < SCHEMA_V2_CUTOFF) {
          logger.debug(`Skipping old token transfer before schema v2: ${event.id?.slice(0, 16)}...`);
          return;
        }

        if (TokenTransferProtocol.isTokenTransfer(event)) {
          // Check if this transfer is for us
          const recipient = TokenTransferProtocol.getRecipient(event);
          if (recipient !== myPubkey) {
            return;
          }

          const payloadJson = await TokenTransferProtocol.parseTokenTransfer(
            event,
            keyManager,
          );
          const sender = TokenTransferProtocol.getSender(event);

          logger.info(`Received token transfer from ${sender.slice(0, 16)}...`);

          // Try to receive the tokens using our receiveTokens method
          const success = await this.receiveTokens(payloadJson);

          // Extract amount from payload for callback
          let amount = "0";
          try {
            const wrapper = JSON.parse(payloadJson);
            amount = wrapper.metadata?.amount ?? "0";
          } catch {
            // Ignore parse errors for amount extraction
          }

          onTransfer(sender, amount, success);
        }
      } catch (error) {
        logger.error(`Failed to process token transfer: ${error}`);
      }
    });

    sdkClient.subscribe(filter, listener);
  }
}
