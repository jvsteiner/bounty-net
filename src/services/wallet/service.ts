import {
  TokenTransferProtocol,
  Filter,
  CallbackEventListener,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";

// Direct imports from state-transition-sdk (npm package missing index.js)
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { CoinId } from "@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js";
import type { IMintTransactionReason } from "@unicitylabs/state-transition-sdk/lib/transaction/IMintTransactionReason.js";

import { createLogger } from "../../utils/logger.js";
import { COINS, DEFAULT_AGGREGATOR_URL } from "../../constants/coins.js";
import type { BountyNetNostrClient } from "../nostr/client.js";

const logger = createLogger("wallet");

// Token transfer event kind (Unicity custom)
const TOKEN_TRANSFER_KIND = 31113;

export interface TransferResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface TokenInfo {
  tokenJson: string;
  coinId: string;
  amount: bigint;
}

/**
 * WalletService handles Unicity token operations.
 * Uses @unicitylabs/nostr-js-sdk for NOSTR token messaging and
 * @unicitylabs/state-transition-sdk for token state management.
 */
export class WalletService {
  private signingService: SigningService;
  private stateClient: StateTransitionClient;
  private tokens: Map<string, Token<IMintTransactionReason>> = new Map();

  constructor(
    private privateKeyHex: string,
    private client: BountyNetNostrClient,
    aggregatorUrl: string = DEFAULT_AGGREGATOR_URL,
  ) {
    // Create signing service from private key
    const privateKeyBytes = hexToBytes(privateKeyHex);
    this.signingService = new SigningService(privateKeyBytes);

    // Create state transition client for aggregator communication
    const aggregator = new AggregatorClient(aggregatorUrl);
    this.stateClient = new StateTransitionClient(aggregator);
  }

  getPublicKey(): string {
    return this.client.getPublicKey();
  }

  getPublicKeyBytes(): Uint8Array {
    return this.signingService.publicKey;
  }

  getSigningService(): SigningService {
    return this.signingService;
  }

  getStateClient(): StateTransitionClient {
    return this.stateClient;
  }

  /**
   * Load tokens from storage (JSON format)
   */
  async loadTokens(tokenJsons: string[]): Promise<void> {
    for (const json of tokenJsons) {
      try {
        const token = await Token.fromJSON(JSON.parse(json));
        const tokenId = token.id.toJSON();
        this.tokens.set(tokenId, token);
        logger.debug(`Loaded token: ${tokenId}`);
      } catch (error) {
        logger.error(`Failed to load token: ${error}`);
      }
    }
    logger.info(`Loaded ${this.tokens.size} tokens`);
  }

  /**
   * Get all tokens owned by this wallet
   */
  getOwnedTokens(): Token<IMintTransactionReason>[] {
    return Array.from(this.tokens.values());
  }

  /**
   * Find tokens with sufficient balance for a coin type
   */
  findTokensForAmount(
    coinId: string,
    amount: bigint,
  ): Token<IMintTransactionReason>[] {
    const coinIdObj = CoinId.fromJSON(coinId);
    const matchingTokens: Token<IMintTransactionReason>[] = [];
    let totalBalance = BigInt(0);

    for (const token of this.tokens.values()) {
      const coins = token.coins;
      if (coins) {
        const balance = coins.get(coinIdObj);
        if (balance && balance > 0) {
          matchingTokens.push(token);
          totalBalance += balance;
          if (totalBalance >= amount) {
            break;
          }
        }
      }
    }

    return matchingTokens;
  }

  /**
   * Send deposit payment to maintainer
   */
  async sendDeposit(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA,
  ): Promise<TransferResult> {
    logger.info(
      `Sending deposit: ${amount} ${coinId} to ${recipientPubkey.slice(0, 16)}... for report ${reportId}`,
    );

    return this.sendTokenTransfer(recipientPubkey, amount, coinId, {
      type: "deposit",
      reportId,
    });
  }

  /**
   * Send refund back to reporter (maintainer accepting report)
   */
  async sendRefund(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA,
  ): Promise<TransferResult> {
    logger.info(
      `Sending refund: ${amount} ${coinId} to ${recipientPubkey.slice(0, 16)}... for report ${reportId}`,
    );

    return this.sendTokenTransfer(recipientPubkey, amount, coinId, {
      type: "refund",
      reportId,
    });
  }

  /**
   * Send bounty payment (maintainer paying reporter)
   */
  async sendBounty(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA,
  ): Promise<TransferResult> {
    logger.info(
      `Sending bounty: ${amount} ${coinId} to ${recipientPubkey.slice(0, 16)}... for report ${reportId}`,
    );

    return this.sendTokenTransfer(recipientPubkey, amount, coinId, {
      type: "bounty",
      reportId,
    });
  }

  /**
   * Internal method to send token transfer
   */
  private async sendTokenTransfer(
    recipientPubkey: string,
    amount: bigint,
    coinId: string,
    metadata: { type: string; reportId: string },
  ): Promise<TransferResult> {
    try {
      // Find tokens with sufficient balance
      const tokens = this.findTokensForAmount(coinId, amount);
      if (tokens.length === 0) {
        return {
          success: false,
          error: `Insufficient balance for ${coinId}`,
        };
      }

      // Use the first token with sufficient balance
      const token = tokens[0];
      const tokenId = token.id.toJSON();

      // Serialize token to JSON for transfer
      const tokenJson = JSON.stringify(token.toJSON());

      // Create the token transfer payload
      const transferPayload = JSON.stringify({
        tokenJson,
        amount: amount.toString(),
        coinId,
        requestId: `${metadata.type}_${metadata.reportId}_${Date.now()}`,
        message: `${metadata.type} for report ${metadata.reportId}`,
      });

      // Send via NOSTR using the SDK client's sendTokenTransfer
      const sdkClient = this.client.getSDKClient();
      const eventId = await sdkClient.sendTokenTransfer(
        recipientPubkey,
        transferPayload,
      );

      // Remove the spent token from local storage
      // (In a full implementation, we'd handle partial spends)
      this.tokens.delete(tokenId);

      logger.info(`Token transfer sent: ${eventId}`);
      return {
        success: true,
        txHash: eventId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Token transfer failed: ${message}`);
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * Get wallet balance for a specific coin
   */
  async getBalance(coinId: string = COINS.ALPHA): Promise<bigint> {
    logger.debug(`Getting balance for ${coinId}`);

    const coinIdObj = CoinId.fromJSON(coinId);
    let totalBalance = BigInt(0);

    for (const token of this.tokens.values()) {
      const coins = token.coins;
      if (coins) {
        const balance = coins.get(coinIdObj);
        if (balance) {
          totalBalance += balance;
        }
      }
    }

    return totalBalance;
  }

  /**
   * Subscribe to incoming token transfers
   */
  subscribeToTransfers(
    onTransfer: (from: string, amount: string, tokenJson: string) => void,
  ): void {
    logger.info("Subscribing to incoming transfers");

    const keyManager = this.client.getKeyManager();
    const myPubkey = this.getPublicKey();
    const sdkClient = this.client.getSDKClient();

    const filter = Filter.builder()
      .kinds(TOKEN_TRANSFER_KIND)
      .pTags(myPubkey)
      .build();

    const listener = new CallbackEventListener(async (event: Event) => {
      try {
        // Check if this is a token transfer
        if (TokenTransferProtocol.isTokenTransfer(event)) {
          const tokenJson = await TokenTransferProtocol.parseTokenTransfer(
            event,
            keyManager,
          );
          const amount = TokenTransferProtocol.getAmount(event);
          const sender = TokenTransferProtocol.getSender(event);

          logger.info(`Received token transfer from ${sender.slice(0, 16)}...`);

          // Try to parse and store the received token
          try {
            const payload = JSON.parse(tokenJson);
            if (payload.tokenJson) {
              const token = await Token.fromJSON(JSON.parse(payload.tokenJson));
              const tokenId = token.id.toJSON();
              this.tokens.set(tokenId, token);
              logger.info(`Stored received token: ${tokenId}`);
            }
          } catch {
            // Token might be in a different format
            logger.debug("Could not parse token payload as Token object");
          }

          onTransfer(sender, amount?.toString() ?? "0", tokenJson);
        }
      } catch (error) {
        logger.error(`Failed to process token transfer: ${error}`);
      }
    });

    sdkClient.subscribe(filter, listener);
  }

  /**
   * Add a token to the wallet
   */
  addToken(token: Token<IMintTransactionReason>): void {
    const tokenId = token.id.toJSON();
    this.tokens.set(tokenId, token);
    logger.info(`Added token: ${tokenId}`);
  }

  /**
   * Export token to JSON for storage
   */
  exportToken(tokenId: string): string | null {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return null;
    }
    return JSON.stringify(token.toJSON());
  }

  /**
   * Export all tokens to JSON for storage
   */
  exportAllTokens(): string[] {
    return Array.from(this.tokens.values()).map((token) =>
      JSON.stringify(token.toJSON()),
    );
  }
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
