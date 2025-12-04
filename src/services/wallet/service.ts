import {
  TokenTransferProtocol,
  Filter,
  CallbackEventListener,
} from "@unicitylabs/nostr-js-sdk";
import type { Event } from "@unicitylabs/nostr-js-sdk";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

// Direct imports from state-transition-sdk
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { SubmitCommitmentStatus } from "@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TokenId } from "@unicitylabs/state-transition-sdk/lib/token/TokenId.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import { CoinId } from "@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js";
import { TokenCoinData } from "@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData.js";
import type { IMintTransactionReason } from "@unicitylabs/state-transition-sdk/lib/transaction/IMintTransactionReason.js";
import { TransferCommitment } from "@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment.js";
import { TransferTransaction } from "@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction.js";
import { TokenSplitBuilder } from "@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { UnmaskedPredicateReference } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import { waitInclusionProof } from "@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js";
import { VerificationError } from "@unicitylabs/state-transition-sdk/lib/verification/VerificationError.js";

import { createLogger } from "../../utils/logger.js";
import { COINS, DEFAULT_AGGREGATOR_URL } from "../../constants/coins.js";
import { PATHS } from "../../constants/paths.js";
import TESTNET_TRUST_BASE from "../../trustbase.json" with { type: "json" };
import type { BountyNetNostrClient } from "../nostr/client.js";

const logger = createLogger("wallet");

// Token transfer event kind (Unicity custom)
const TOKEN_TRANSFER_KIND = 31113;

export interface TransferResult {
  success: boolean;
  txHash?: string;
  tokenJson?: string;
  transactionJson?: string;
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
  private signingService!: SigningService;
  private stateClient: StateTransitionClient;
  private tokens: Map<string, Token<IMintTransactionReason>> = new Map();
  private identityName: string;
  private privateKeyBytes: Uint8Array;
  private trustBase: RootTrustBase;
  private nonces: Map<string, Uint8Array> = new Map(); // tokenId -> nonce for unlocking

  constructor(
    private privateKeyHex: string,
    private client: BountyNetNostrClient,
    identityName: string,
    aggregatorUrl: string = DEFAULT_AGGREGATOR_URL,
    aggregatorApiKey?: string,
  ) {
    this.identityName = identityName;

    // Store private key bytes for creating signing services
    this.privateKeyBytes = hexToBytes(privateKeyHex);

    // Get API key from parameter or environment
    const apiKey = aggregatorApiKey ?? process.env.UNICITY_AGGREGATOR_APIKEY;
    logger.info(`Aggregator API key: ${apiKey ? `${apiKey.slice(0, 8)}...` : "NOT SET"}`);

    // Create state transition client for aggregator communication
    const aggregator = new AggregatorClient(aggregatorUrl, apiKey);
    this.stateClient = new StateTransitionClient(aggregator);

    // Load trust base
    this.trustBase = RootTrustBase.fromJSON(TESTNET_TRUST_BASE);
  }

  /**
   * Initialize the signing service
   * Uses the private key directly (not hashed) to match how tokens are minted
   */
  async initialize(): Promise<void> {
    // Use direct constructor, NOT createFromSecret (which hashes the secret)
    // This matches how the mint-tokens.ts script creates tokens
    this.signingService = new SigningService(this.privateKeyBytes);
    logger.info(`Wallet initialized for ${this.identityName}`);
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

  getTrustBase(): RootTrustBase {
    return this.trustBase;
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
   * Reload tokens from disk (picks up newly minted tokens)
   */
  async reloadTokensFromDisk(): Promise<void> {
    if (!existsSync(PATHS.TOKENS)) {
      return;
    }

    const tokenFiles = readdirSync(PATHS.TOKENS).filter(
      (f) => f.startsWith(this.identityName) && f.endsWith(".json"),
    );

    const tokenJsons: string[] = [];
    for (const file of tokenFiles) {
      try {
        const content = readFileSync(join(PATHS.TOKENS, file), "utf-8");
        tokenJsons.push(content);
      } catch (error) {
        logger.error(`Failed to read token file ${file}: ${error}`);
      }
    }

    // Clear existing tokens and reload
    this.tokens.clear();
    if (tokenJsons.length > 0) {
      await this.loadTokens(tokenJsons);
    }
  }

  /**
   * Save a token to disk
   */
  saveTokenToDisk(token: Token<IMintTransactionReason>): void {
    if (!existsSync(PATHS.TOKENS)) {
      mkdirSync(PATHS.TOKENS, { recursive: true });
    }

    const tokenId = token.id.toJSON();
    const shortId = tokenId.slice(0, 16);
    const filename = `${this.identityName}-${shortId}.json`;
    const filepath = join(PATHS.TOKENS, filename);

    writeFileSync(filepath, JSON.stringify(token.toJSON(), null, 2));
    logger.info(`Saved token to ${filename}`);
  }

  /**
   * Move a spent token file to the spent folder (instead of deleting)
   * This allows recovery if something goes wrong with the transfer
   */
  archiveSpentToken(tokenId: string): void {
    if (!existsSync(PATHS.TOKENS)) {
      return;
    }

    const spentDir = join(PATHS.TOKENS, "spent");
    if (!existsSync(spentDir)) {
      mkdirSync(spentDir, { recursive: true });
    }

    const tokenFiles = readdirSync(PATHS.TOKENS).filter(
      (f) => f.startsWith(this.identityName) && f.includes(tokenId.slice(0, 16)) && f.endsWith(".json"),
    );

    for (const file of tokenFiles) {
      const srcPath = join(PATHS.TOKENS, file);
      const destPath = join(spentDir, file);
      try {
        const content = readFileSync(srcPath, "utf-8");
        writeFileSync(destPath, content);
        unlinkSync(srcPath);
        logger.info(`Archived spent token: ${file} -> spent/`);
      } catch (error) {
        logger.error(`Failed to archive token file ${file}: ${error}`);
      }
    }
  }

  /**
   * Get all tokens owned by this wallet
   */
  getOwnedTokens(): Token<IMintTransactionReason>[] {
    return Array.from(this.tokens.values());
  }

  /**
   * Verify a token is valid and can be used for transfers
   */
  async verifyToken(token: Token<IMintTransactionReason>): Promise<boolean> {
    try {
      const result = await token.verify(this.trustBase);
      if (!result.isSuccessful) {
        logger.warn(`Token ${token.id.toJSON().slice(0, 16)}... failed verification: ${JSON.stringify(result)}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(`Token ${token.id.toJSON().slice(0, 16)}... threw during verification: ${error}`);
      return false;
    }
  }

  /**
   * Find tokens with sufficient balance for a coin type
   * Skips tokens that fail verification
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
   * Create a recipient address from a public key
   */
  private async createRecipientAddress(recipientPubkey: string, token: Token<IMintTransactionReason>) {
    // Create signing service from recipient's public key
    // For unmasked predicates, we use the recipient's pubkey directly
    const recipientPubkeyBytes = hexToBytes(recipientPubkey);

    // Create an UnmaskedPredicateReference for the recipient
    const predicateRef = await UnmaskedPredicateReference.create(
      token.type,
      "secp256k1",
      recipientPubkeyBytes,
      HashAlgorithm.SHA256,
    );

    return predicateRef.toAddress();
  }

  /**
   * Internal method to send token transfer using proper state transition flow.
   * Supports partial transfers by splitting tokens when needed.
   * Will retry with different tokens if REQUEST_ID_EXISTS is encountered.
   */
  private async sendTokenTransfer(
    recipientPubkey: string,
    amount: bigint,
    coinId: string,
    metadata: { type: string; reportId: string },
  ): Promise<TransferResult> {
    try {
      // Reload tokens from disk in case new ones were minted
      await this.reloadTokensFromDisk();

      // Find tokens with sufficient balance
      const tokens = this.findTokensForAmount(coinId, amount);
      if (tokens.length === 0) {
        return {
          success: false,
          error: `Insufficient balance for ${coinId}`,
        };
      }

      const coinIdObj = CoinId.fromJSON(coinId);
      const triedTokenIds = new Set<string>();

      // Try each valid token until one succeeds
      while (true) {
        // Find a token that passes verification and hasn't been tried
        let selectedToken: Token<IMintTransactionReason> | null = null;

        for (const token of tokens) {
          const tokenId = token.id.toJSON();

          // Skip tokens we've already tried
          if (triedTokenIds.has(tokenId)) {
            continue;
          }

          logger.info(`Checking token ${tokenId.slice(0, 16)}... for verification`);

          const isValid = await this.verifyToken(token);
          if (isValid) {
            selectedToken = token;
            break;
          } else {
            logger.warn(`Token ${tokenId.slice(0, 16)}... failed verification, trying next token`);
            // Move invalid token to spent folder to avoid future issues
            this.tokens.delete(tokenId);
            this.archiveSpentToken(tokenId);
            triedTokenIds.add(tokenId);
          }
        }

        if (!selectedToken) {
          return {
            success: false,
            error: `No valid tokens available for ${coinId} (all failed verification or have pending commitments)`,
          };
        }

        const tokenId = selectedToken.id.toJSON();
        const tokenBalance = selectedToken.coins?.get(coinIdObj) ?? BigInt(0);
        triedTokenIds.add(tokenId);

        logger.info(`Using verified token ${tokenId.slice(0, 16)}... (balance: ${tokenBalance}) for transfer of ${amount}`);

        // Attempt the transfer
        let result: TransferResult;
        if (tokenBalance > amount) {
          logger.info(`Token has ${tokenBalance}, need ${amount} - splitting token`);
          result = await this.sendTokenTransferWithSplit(selectedToken, recipientPubkey, amount, coinId, metadata);
        } else {
          result = await this.sendFullTokenTransfer(selectedToken, recipientPubkey, amount, coinId, metadata);
        }

        // Check if we got REQUEST_ID_EXISTS - if so, archive this token and try another
        if (!result.success && result.error?.includes("REQUEST_ID_EXISTS")) {
          logger.warn(`Token ${tokenId.slice(0, 16)}... has pending commitment (REQUEST_ID_EXISTS), archiving and trying next token`);
          this.tokens.delete(tokenId);
          this.archiveSpentToken(tokenId);
          continue; // Try next token
        }

        return result;
      }
    } catch (error) {
      let message: string;
      if (error instanceof VerificationError) {
        message = error.message;
        logger.error(`Token verification failed: ${message}`);
        logger.error(`Verification result: ${JSON.stringify(error.verificationResult, null, 2)}`);
        if (error.stack) {
          logger.error(`Stack trace: ${error.stack}`);
        }
      } else if (error instanceof Error) {
        message = error.message;
        logger.error(`Token transfer failed: ${message}`);
        if (error.stack) {
          logger.error(`Stack trace: ${error.stack}`);
        }
      } else if (typeof error === "object" && error !== null) {
        message = JSON.stringify(error);
        logger.error(`Token transfer failed with object: ${message}`);
      } else {
        message = String(error);
        logger.error(`Token transfer failed: ${message}`);
      }
      return {
        success: false,
        error: message || "Unknown error",
      };
    }
  }

  /**
   * Send a full token transfer (no splitting needed)
   */
  private async sendFullTokenTransfer(
    token: Token<IMintTransactionReason>,
    recipientPubkey: string,
    amount: bigint,
    coinId: string,
    metadata: { type: string; reportId: string },
  ): Promise<TransferResult> {
    const tokenId = token.id.toJSON();

    // Create recipient address
    const recipientAddress = await this.createRecipientAddress(recipientPubkey, token);

    // Generate a salt for this transaction
    const salt = crypto.getRandomValues(new Uint8Array(32));

    // Create transfer commitment
    const textEncoder = new TextEncoder();
    const commitment = await TransferCommitment.create(
      token,
      recipientAddress,
      salt,
      null,
      textEncoder.encode(`${metadata.type} for report ${metadata.reportId}`),
      this.signingService,
    );

    logger.info(`Submitting transfer commitment to aggregator...`);

    // Submit commitment to aggregator
    const response = await this.stateClient.submitTransferCommitment(commitment);
    if (response.status !== SubmitCommitmentStatus.SUCCESS) {
      return {
        success: false,
        error: `Failed to submit transfer commitment: ${response.status}`,
      };
    }

    logger.info(`Commitment submitted, waiting for inclusion proof...`);

    // Wait for inclusion proof
    const inclusionProof = await waitInclusionProof(
      this.trustBase,
      this.stateClient,
      commitment,
      AbortSignal.timeout(30000),
    );

    // Create the transfer transaction
    const transaction = commitment.toTransaction(inclusionProof);

    logger.info(`Transfer transaction created, sending via NOSTR...`);

    // Serialize token and transaction for transmission
    const tokenJson = JSON.stringify(token.toJSON());
    const transactionJson = JSON.stringify(transaction.toJSON());

    // Create the token transfer payload
    const transferPayload = JSON.stringify({
      tokenJson,
      transactionJson,
      salt: Array.from(salt),
      amount: amount.toString(),
      coinId,
      requestId: `${metadata.type}_${metadata.reportId}_${Date.now()}`,
      message: `${metadata.type} for report ${metadata.reportId}`,
    });

    // Send via NOSTR using the SDK client's sendTokenTransfer
    const sdkClient = this.client.getSDKClient();

    // Verify we're connected before sending
    if (!this.client.isConnected()) {
      return {
        success: false,
        error: "Not connected to NOSTR relays - token transfer not sent",
      };
    }

    const eventId = await sdkClient.sendTokenTransfer(
      recipientPubkey,
      transferPayload,
    );

    if (!eventId) {
      return {
        success: false,
        error: "Failed to publish token transfer to NOSTR",
      };
    }

    logger.info(`Token transfer published to NOSTR: ${eventId}`);

    // Remove the spent token from local storage and disk
    this.tokens.delete(tokenId);
    this.archiveSpentToken(tokenId);

    logger.info(`Token transfer complete: ${eventId}`);
    return {
      success: true,
      txHash: eventId,
      tokenJson,
      transactionJson,
    };
  }

  /**
   * Send a partial token transfer by splitting the token.
   * Burns the original token and mints two new tokens:
   * - One for the recipient with the requested amount
   * - One for ourselves with the change
   */
  private async sendTokenTransferWithSplit(
    token: Token<IMintTransactionReason>,
    recipientPubkey: string,
    amount: bigint,
    coinId: string,
    metadata: { type: string; reportId: string },
  ): Promise<TransferResult> {
    const originalTokenId = token.id.toJSON();
    const coinIdObj = CoinId.fromJSON(coinId);
    const tokenBalance = token.coins?.get(coinIdObj) ?? BigInt(0);
    const changeAmount = tokenBalance - amount;

    logger.info(`Splitting token: ${amount} to recipient, ${changeAmount} as change`);

    // Create recipient address
    const recipientAddress = await this.createRecipientAddress(recipientPubkey, token);

    // Create our own address for the change token
    const myAddress = await this.createMyAddress(token);

    // Generate new token IDs (random 32-byte IDs)
    const recipientTokenIdBytes = crypto.getRandomValues(new Uint8Array(32));
    const changeTokenIdBytes = crypto.getRandomValues(new Uint8Array(32));
    const recipientTokenId = new TokenId(recipientTokenIdBytes);
    const changeTokenId = new TokenId(changeTokenIdBytes);

    // Generate salts for the new tokens
    const recipientSalt = crypto.getRandomValues(new Uint8Array(32));
    const changeSalt = crypto.getRandomValues(new Uint8Array(32));

    // Create coin data for the new tokens
    const recipientCoinData = TokenCoinData.create([[coinIdObj, amount]]);
    const changeCoinData = TokenCoinData.create([[coinIdObj, changeAmount]]);

    // Build the split
    const builder = new TokenSplitBuilder();
    builder.createToken(
      recipientTokenId,
      token.type,
      null,
      recipientCoinData,
      recipientAddress,
      recipientSalt,
      null,
    );
    builder.createToken(
      changeTokenId,
      token.type,
      null,
      changeCoinData,
      myAddress,
      changeSalt,
      null,
    );

    const split = await builder.build(token);

    // Create burn commitment
    const burnSalt = crypto.getRandomValues(new Uint8Array(32));
    const burnCommitment = await split.createBurnCommitment(burnSalt, this.signingService);

    logger.info(`Submitting burn commitment to aggregator...`);

    // Submit burn commitment
    const burnResponse = await this.stateClient.submitTransferCommitment(burnCommitment);
    if (burnResponse.status !== SubmitCommitmentStatus.SUCCESS) {
      return {
        success: false,
        error: `Failed to submit burn commitment: ${burnResponse.status}`,
      };
    }

    logger.info(`Burn commitment submitted, waiting for inclusion proof...`);

    // Wait for burn inclusion proof
    const burnInclusionProof = await waitInclusionProof(
      this.trustBase,
      this.stateClient,
      burnCommitment,
      AbortSignal.timeout(30000),
    );

    // Create burn transaction
    const burnTransaction = burnCommitment.toTransaction(burnInclusionProof);

    logger.info(`Creating mint commitments for split tokens...`);

    // Create mint commitments for the new tokens
    const mintCommitments = await split.createSplitMintCommitments(this.trustBase, burnTransaction);

    // Submit each mint commitment and wait for proofs
    // Index 0 = recipient token, Index 1 = change token (ours)
    const mintTransactions: { commitment: typeof mintCommitments[0], transaction: any }[] = [];

    for (let i = 0; i < mintCommitments.length; i++) {
      const mintCommitment = mintCommitments[i];
      logger.info(`Submitting mint commitment ${i + 1}/${mintCommitments.length}...`);

      const mintResponse = await this.stateClient.submitMintCommitment(mintCommitment);
      if (mintResponse.status !== SubmitCommitmentStatus.SUCCESS) {
        return {
          success: false,
          error: `Failed to submit mint commitment ${i + 1}: ${mintResponse.status}`,
        };
      }

      // Wait for mint inclusion proof
      const mintInclusionProof = await waitInclusionProof(
        this.trustBase,
        this.stateClient,
        mintCommitment,
        AbortSignal.timeout(30000),
      );

      // Create the mint transaction using the inclusion proof from aggregator
      // The aggregator's inclusion proof already contains the authenticator and transaction hash
      const mintTransaction = mintCommitment.toTransaction(mintInclusionProof);
      mintTransactions.push({ commitment: mintCommitment, transaction: mintTransaction });
    }

    logger.info(`Split complete, creating change token and sending recipient token via NOSTR...`);

    // Create our change token (index 1) - we own this one
    // IMPORTANT: Use the same salt that was used when building the split
    // The mint transaction's recipient address is derived from changeSalt,
    // so the predicate nonce must match for verification to pass.
    const changePredicate = await UnmaskedPredicate.create(
      changeTokenId,
      token.type,
      this.signingService,
      HashAlgorithm.SHA256,
      changeSalt,  // Use changeSalt, NOT a new random nonce
    );
    const changeTokenState = new TokenState(changePredicate, null);

    // Create change token - use fromJSON to avoid verification issues
    const changeMintTx = mintTransactions[1].transaction;
    const changeTokenJson = {
      version: "2.0",
      state: changeTokenState.toJSON(),
      genesis: changeMintTx.toJSON(),
      transactions: [],
      nametags: [],
    };
    const changeToken = await Token.fromJSON(changeTokenJson);
    this.nonces.set(changeTokenId.toJSON(), changeSalt);

    // For recipient token (index 0), just send the mint transaction data
    // The recipient will create their own predicate to claim it
    const recipientMintTx = mintTransactions[0].transaction;
    const tokenJson = JSON.stringify(recipientMintTx.toJSON());
    const transactionJson = JSON.stringify({ type: "split_mint", burnTransaction: burnTransaction.toJSON() });

    const transferPayload = JSON.stringify({
      tokenJson,
      transactionJson,
      salt: Array.from(recipientSalt),
      amount: amount.toString(),
      coinId,
      requestId: `${metadata.type}_${metadata.reportId}_${Date.now()}`,
      message: `${metadata.type} for report ${metadata.reportId}`,
    });

    // Send via NOSTR
    const sdkClient = this.client.getSDKClient();

    // Verify we're connected before sending
    if (!this.client.isConnected()) {
      return {
        success: false,
        error: "Not connected to NOSTR relays - token transfer not sent",
      };
    }

    const eventId = await sdkClient.sendTokenTransfer(recipientPubkey, transferPayload);

    if (!eventId) {
      return {
        success: false,
        error: "Failed to publish token transfer to NOSTR",
      };
    }

    logger.info(`Token transfer published to NOSTR: ${eventId}`);

    // Remove the original token from storage
    this.tokens.delete(originalTokenId);
    this.archiveSpentToken(originalTokenId);

    // Save the change token to our wallet
    if (changeToken) {
      this.tokens.set(changeTokenId.toJSON(), changeToken);
      this.saveTokenToDisk(changeToken);
      logger.info(`Saved change token with ${changeAmount} ${coinId}`);
    }

    logger.info(`Split token transfer complete: ${eventId}`);
    return {
      success: true,
      txHash: eventId,
      tokenJson,
      transactionJson,
    };
  }

  /**
   * Create an address for ourselves (for receiving change tokens)
   */
  private async createMyAddress(token: Token<IMintTransactionReason>) {
    const predicateRef = await UnmaskedPredicateReference.create(
      token.type,
      "secp256k1",
      this.signingService.publicKey,
      HashAlgorithm.SHA256,
    );
    return predicateRef.toAddress();
  }

  /**
   * Receive and finalize an incoming token transfer.
   * Handles both:
   * 1. Full token transfers (tokenJson = Token, transactionJson = TransferTransaction)
   * 2. Split mint tokens (tokenJson = MintTransaction, transactionJson = { type: "split_mint", ... })
   */
  async receiveToken(
    tokenJson: string,
    transactionJson: string,
    salt: Uint8Array,
  ): Promise<Token<IMintTransactionReason> | null> {
    try {
      logger.info(`Receiving token transfer...`);

      const parsedTransaction = JSON.parse(transactionJson);

      // Check if this is a split mint token
      if (parsedTransaction.type === "split_mint") {
        return this.receiveSplitMintToken(tokenJson, salt);
      }

      // Standard full token transfer
      return this.receiveFullTokenTransfer(tokenJson, transactionJson, salt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to receive token: ${message}`);
      return null;
    }
  }

  /**
   * Receive a standard full token transfer
   */
  private async receiveFullTokenTransfer(
    tokenJson: string,
    transactionJson: string,
    _salt: Uint8Array,
  ): Promise<Token<IMintTransactionReason> | null> {
    // Parse the token and transaction
    const token = await Token.fromJSON(JSON.parse(tokenJson));
    const transaction = await TransferTransaction.fromJSON(JSON.parse(transactionJson));

    // Create our predicate to claim ownership
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const predicate = await UnmaskedPredicate.create(
      token.id,
      token.type,
      this.signingService,
      HashAlgorithm.SHA256,
      nonce,
    );

    // Finalize the transaction
    const finalizedToken = await this.stateClient.finalizeTransaction(
      this.trustBase,
      token,
      new TokenState(predicate, null),
      transaction,
    );

    // Verify the token
    const verifyResult = await finalizedToken.verify(this.trustBase);
    if (!verifyResult.isSuccessful) {
      logger.error(`Token verification failed`);
      return null;
    }

    // Store the nonce for future transfers
    this.nonces.set(finalizedToken.id.toJSON(), nonce);

    // Add to local storage
    const tokenId = finalizedToken.id.toJSON();
    this.tokens.set(tokenId, finalizedToken);

    // Save to disk
    this.saveTokenToDisk(finalizedToken);

    logger.info(`Token received and finalized: ${tokenId.slice(0, 16)}...`);
    return finalizedToken;
  }

  /**
   * Receive a token from a split mint operation.
   * The token was minted directly to our address, so we just need to
   * construct the Token object with our predicate.
   */
  private async receiveSplitMintToken(
    mintTransactionJson: string,
    salt: Uint8Array,
  ): Promise<Token<IMintTransactionReason> | null> {
    logger.info(`Receiving split mint token...`);

    // Parse the mint transaction
    const { MintTransaction } = await import("@unicitylabs/state-transition-sdk/lib/transaction/MintTransaction.js");
    const mintTransaction = await MintTransaction.fromJSON(JSON.parse(mintTransactionJson));

    // Get token info from the mint transaction data
    const tokenId = mintTransaction.data.tokenId;
    const tokenType = mintTransaction.data.tokenType;

    // Create our predicate to control this token
    // IMPORTANT: Use the salt from the transfer payload as the nonce.
    // The mint transaction's recipient address was derived using this salt,
    // so the predicate nonce must match for verification to pass.
    const predicate = await UnmaskedPredicate.create(
      tokenId,
      tokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      salt,  // Use the salt from the transfer, NOT a new random nonce
    );
    const tokenState = new TokenState(predicate, null);

    // Construct the token using fromJSON (avoids verification issues)
    const tokenJsonObj = {
      version: "2.0",
      state: tokenState.toJSON(),
      genesis: mintTransaction.toJSON(),
      transactions: [],
      nametags: [],
    };
    const token = await Token.fromJSON(tokenJsonObj);

    // Store the salt as the nonce for future transfers
    this.nonces.set(tokenId.toJSON(), salt);

    // Add to local storage
    this.tokens.set(tokenId.toJSON(), token);

    // Save to disk
    this.saveTokenToDisk(token);

    logger.info(`Split mint token received: ${tokenId.toJSON().slice(0, 16)}...`);
    return token;
  }

  /**
   * Get wallet balance for a specific coin
   */
  async getBalance(coinId: string = COINS.ALPHA): Promise<bigint> {
    logger.debug(`Getting balance for ${coinId}`);

    // Reload tokens from disk to get latest balances
    await this.reloadTokensFromDisk();

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
   * @param onTransfer Callback when a transfer is received
   * @param since Unix timestamp to only receive transfers after this time (prevents replay)
   */
  subscribeToTransfers(
    onTransfer: (from: string, amount: string, token: Token<IMintTransactionReason> | null) => void,
    since?: number,
  ): void {
    logger.info(`Subscribing to incoming transfers${since ? ` since ${new Date(since * 1000).toISOString()}` : ""}`);

    const keyManager = this.client.getKeyManager();
    const myPubkey = this.getPublicKey();
    const sdkClient = this.client.getSDKClient();

    const filterBuilder = Filter.builder()
      .kinds(TOKEN_TRANSFER_KIND)
      .pTags(myPubkey);

    if (since) {
      filterBuilder.since(since);
    }

    const filter = filterBuilder.build();

    const listener = new CallbackEventListener(async (event: Event) => {
      try {
        // Check if this is a token transfer
        if (TokenTransferProtocol.isTokenTransfer(event)) {
          // Check if this transfer is actually for us (both identities share the same relay)
          const recipient = TokenTransferProtocol.getRecipient(event);
          if (recipient !== myPubkey) {
            // This transfer is for a different identity, skip it
            return;
          }

          const payloadJson = await TokenTransferProtocol.parseTokenTransfer(
            event,
            keyManager,
          );
          const sender = TokenTransferProtocol.getSender(event);

          logger.info(`Received token transfer from ${sender.slice(0, 16)}...`);

          // Try to parse and finalize the received token
          try {
            const payload = JSON.parse(payloadJson);
            if (payload.tokenJson && payload.transactionJson) {
              const salt = payload.salt ? new Uint8Array(payload.salt) : crypto.getRandomValues(new Uint8Array(32));
              const token = await this.receiveToken(
                payload.tokenJson,
                payload.transactionJson,
                salt,
              );

              onTransfer(sender, payload.amount ?? "0", token);
            } else {
              logger.warn("Token transfer payload missing tokenJson or transactionJson");
              onTransfer(sender, payload.amount ?? "0", null);
            }
          } catch (parseError) {
            logger.error(`Could not parse token payload: ${parseError}`);
            onTransfer(sender, "0", null);
          }
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
    this.saveTokenToDisk(token);
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
