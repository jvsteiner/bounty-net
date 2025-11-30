# NOSTR JS SDK & State Transition SDK User Guide

A comprehensive guide for using the Unicity NOSTR and State Transition SDKs to build payment-enabled applications.

## Table of Contents

1. [Overview](#overview)
2. [Installation](#installation)
3. [Quick Start](#quick-start)
4. [NOSTR JS SDK](#nostr-js-sdk)
   - [Key Management](#key-management)
   - [Connecting to Relays](#connecting-to-relays)
   - [Nametags (Human-Readable Addresses)](#nametags)
   - [Sending Payment Requests](#sending-payment-requests)
   - [Receiving Token Transfers](#receiving-token-transfers)
   - [Sending Token Transfers](#sending-token-transfers)
   - [Direct Messages](#direct-messages)
   - [Subscriptions and Filters](#subscriptions-and-filters)
   - [Encryption](#encryption)
5. [State Transition SDK](#state-transition-sdk)
   - [Token Operations](#token-operations)
   - [Aggregator Client](#aggregator-client)
   - [Trust Base](#trust-base)
6. [Complete Examples](#complete-examples)
7. [API Reference](#api-reference)
8. [Environment Configuration](#environment-configuration)
9. [Troubleshooting](#troubleshooting)

---

## Overview

The Unicity SDKs enable peer-to-peer payments over the NOSTR protocol:

- **NOSTR JS SDK** (`@unicitylabs/nostr-js-sdk`): Handles messaging, encryption, nametag resolution, payment requests, and token transfers over NOSTR relays.
- **State Transition SDK** (`@unicitylabs/state-transition-sdk`): Handles token minting, transfers, and verification against the Unicity aggregator.

### Architecture

```
┌─────────────┐     NOSTR Protocol      ┌─────────────┐
│   Sender    │ ◄─────────────────────► │  Receiver   │
│  (Wallet)   │   Payment Requests      │  (Merchant) │
│             │   Token Transfers       │             │
└──────┬──────┘                         └──────┬──────┘
       │                                       │
       │  State Transitions                    │
       ▼                                       ▼
┌─────────────────────────────────────────────────────┐
│              Unicity Aggregator                     │
│         (Token Verification & Consensus)            │
└─────────────────────────────────────────────────────┘
```

---

## Installation

```bash
# Using pnpm
pnpm add @unicitylabs/nostr-js-sdk @unicitylabs/state-transition-sdk

# Using npm
npm install @unicitylabs/nostr-js-sdk @unicitylabs/state-transition-sdk
```

### Requirements

- Node.js 18+ or modern browser
- TypeScript 5+ (recommended)

---

## Quick Start

Here's a minimal example showing the payment flow:

```typescript
import { NostrKeyManager, NostrClient, Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";

// 1. Create key manager (merchant)
const merchantKeys = NostrKeyManager.fromPrivateKeyHex(process.env.PRIVATE_KEY);
const client = new NostrClient(merchantKeys);

// 2. Connect to relays
await client.connect("wss://nostr-relay.testnet.unicity.network");

// 3. Register your nametag (one-time setup)
await client.publishNametagBinding("my-merchant", merchantKeys.getPublicKeyHex());

// 4. Send a payment request to a customer
const customerPubkey = await client.queryPubkeyByNametag("customer-name");
await client.sendPaymentRequest(customerPubkey, {
  amount: 1000n,                    // Amount in smallest units
  coinId: "414c504841",             // ALPHA token ID (hex)
  recipientNametag: "my-merchant",  // Where to send payment
  message: "Order #12345",
  requestId: "order_12345",         // Your unique ID for tracking
});

// 5. Listen for incoming payments
const filter = Filter.builder()
  .kinds(EventKinds.TOKEN_TRANSFER)
  .pTags(merchantKeys.getPublicKeyHex())
  .since(Math.floor(Date.now() / 1000))
  .build();

client.subscribe(filter, {
  onEvent: async (event) => {
    const decrypted = await merchantKeys.decryptHex(event.content, event.pubkey);
    console.log("Payment received:", decrypted);
  },
});
```

---

## NOSTR JS SDK

### Key Management

The `NostrKeyManager` handles all cryptographic operations.

#### Creating Keys

```typescript
import { NostrKeyManager } from "@unicitylabs/nostr-js-sdk";

// Generate a new random keypair
const keys = NostrKeyManager.generate();

// From a 64-character hex private key
const keys = NostrKeyManager.fromPrivateKeyHex("abcd1234..."); // 64 chars

// From raw bytes (32 bytes)
const keys = NostrKeyManager.fromPrivateKey(privateKeyBytes);

// From bech32-encoded nsec
const keys = NostrKeyManager.fromNsec("nsec1...");
```

#### Retrieving Keys

```typescript
// Get public key (for sharing)
const pubkeyHex = keys.getPublicKeyHex();   // 64-char hex
const pubkeyBytes = keys.getPublicKey();    // Uint8Array (32 bytes)
const npub = keys.getNpub();                // bech32 "npub1..."

// Get private key (keep secret!)
const privkeyHex = keys.getPrivateKeyHex(); // 64-char hex
const privkeyBytes = keys.getPrivateKey();  // Uint8Array (32 bytes)
const nsec = keys.getNsec();                // bech32 "nsec1..."

// Check if a pubkey belongs to this key manager
const isMe = keys.isMyPublicKey(somePubkeyHex); // boolean
```

#### Generating a New Private Key

```typescript
import { randomBytes } from "node:crypto";

// Generate a secure random 32-byte private key
const privateKey = randomBytes(32).toString("hex");
console.log("Save this securely:", privateKey);

// Use it
const keys = NostrKeyManager.fromPrivateKeyHex(privateKey);
```

#### Signing and Verification

```typescript
// Sign a message hash
const signature = keys.sign(messageHash);        // Uint8Array (64 bytes)
const signatureHex = keys.signHex(messageHash);  // hex string

// Verify (static method)
const isValid = NostrKeyManager.verify(signature, messageHash, publicKey);
const isValid = NostrKeyManager.verifyHex(signatureHex, messageHash, publicKeyHex);
```

#### Memory Safety

```typescript
// When done, clear the private key from memory
keys.clear(); // Overwrites with zeros - key manager becomes unusable
```

---

### Connecting to Relays

```typescript
import { NostrClient } from "@unicitylabs/nostr-js-sdk";

const client = new NostrClient(keyManager);

// Connect to one or more relays
await client.connect(
  "wss://nostr-relay.testnet.unicity.network",
  "wss://backup-relay.example.com"
);

// Check connection status
if (client.isConnected()) {
  console.log("Connected to:", client.getConnectedRelays());
}

// Disconnect when done
client.disconnect();
```

### Nametags

Nametags are human-readable identifiers (like usernames) that map to public keys.

#### Registering a Nametag

```typescript
// Bind a nametag to your public key (one-time setup)
const success = await client.publishNametagBinding(
  "my-username",                    // The nametag you want
  keyManager.getPublicKeyHex()      // Your public key
);

if (success) {
  console.log("Nametag registered!");
}
```

#### Resolving a Nametag

```typescript
// Look up someone's public key by their nametag
const pubkey = await client.queryPubkeyByNametag("their-username");

if (pubkey) {
  console.log("Found pubkey:", pubkey);
} else {
  console.log("Nametag not found");
}
```

---

### Sending Payment Requests

Payment requests ask a user to send tokens. The user's wallet receives this and can display a payment prompt.

```typescript
// First, resolve the recipient's nametag to their pubkey
const customerPubkey = await client.queryPubkeyByNametag("customer-name");

// Send the payment request
const eventId = await client.sendPaymentRequest(customerPubkey, {
  amount: 5000n,                      // Amount in smallest units (bigint)
  coinId: "414c504841",               // Token ID (hex string)
  recipientNametag: "my-merchant",    // YOUR nametag (where to send payment)
  message: "Payment for Order #123",  // Human-readable description
  requestId: "order_123",             // Your tracking ID (optional, auto-generated if omitted)
});

console.log("Payment request sent:", eventId);
```

#### Payment Request Structure

```typescript
interface PaymentRequest {
  amount: bigint | number;     // Amount in smallest token units
  coinId: string;              // Token ID (hex)
  recipientNametag: string;    // Where the payment should be sent
  message?: string;            // Description shown to user
  requestId?: string;          // Your unique tracking ID
}
```

---

### Receiving Token Transfers

To receive payments, subscribe to token transfer events addressed to your public key.

```typescript
import { Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";

// Build a filter for token transfers to you
const filter = Filter.builder()
  .kinds(EventKinds.TOKEN_TRANSFER)           // Kind 31113
  .pTags(keyManager.getPublicKeyHex())        // Addressed to you
  .since(Math.floor(Date.now() / 1000) - 1800) // Last 30 minutes
  .build();

// Subscribe
client.subscribe(filter, {
  onEvent: async (event) => {
    console.log("Token transfer received:", event.id);
    
    // Decrypt the content (NIP-04 encrypted)
    const decrypted = await keyManager.decryptHex(event.content, event.pubkey);
    
    // Content format: "token_transfer:{json}"
    const jsonStr = decrypted.replace(/^token_transfer:/, "");
    const tokenData = JSON.parse(jsonStr);
    
    console.log("Amount:", tokenData.amount);
    console.log("Request ID:", tokenData.requestId);
    console.log("From pubkey:", event.pubkey);
  },
  
  onEndOfStoredEvents: () => {
    console.log("Caught up with historical events");
  },
  
  onError: (subId, error) => {
    console.error("Subscription error:", error);
  },
});
```

#### Token Transfer Content Structure

After decryption and stripping the `token_transfer:` prefix:

```typescript
interface TokenTransferContent {
  amount: string;       // Amount as string (for precision)
  coinId: string;       // Token ID (hex)
  requestId?: string;   // References the payment request
  message?: string;     // Optional message
}
```

---

### Sending Token Transfers

To send a payment (fulfill a payment request):

```typescript
// Resolve recipient's nametag
const recipientPubkey = await client.queryPubkeyByNametag("merchant-name");

// Create token transfer data
const tokenData = JSON.stringify({
  amount: "5000",                     // Amount as string
  coinId: "414c504841",               // ALPHA token ID
  requestId: "order_123",             // Reference to payment request
  message: "Payment for order #123",
});

// Send the transfer
const eventId = await client.sendTokenTransfer(recipientPubkey, tokenData);
console.log("Payment sent:", eventId);
```

---

### Direct Messages

For non-payment communication, use encrypted direct messages.

#### NIP-04 Style (Legacy)

```typescript
// Send encrypted message
const eventId = await client.publishEncryptedMessage(
  recipientPubkeyHex,
  "Hello, this is encrypted!"
);
```

#### NIP-17 Style (Modern, Gift-Wrapped)

```typescript
// More private - uses ephemeral keys and randomized timestamps
const eventId = await client.sendPrivateMessage(
  recipientPubkeyHex,
  "Secret message"
);

// Or send to a nametag directly
const eventId = await client.sendPrivateMessageToNametag(
  "recipient-nametag",
  "Hello!"
);

// With reply reference
const eventId = await client.sendPrivateMessage(
  recipientPubkeyHex,
  "This is a reply",
  { replyToEventId: "original_event_id" }
);

// Send read receipt
await client.sendReadReceipt(senderPubkeyHex, messageEventId);
```

---

### Subscriptions and Filters

#### Building Filters

```typescript
import { Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";

// Fluent builder API
const filter = Filter.builder()
  .kinds(EventKinds.TOKEN_TRANSFER, EventKinds.PAYMENT_REQUEST)
  .authors("pubkey1", "pubkey2")
  .pTags("recipient_pubkey")      // Events tagged with "p" = pubkey
  .since(timestamp)               // Unix seconds
  .until(timestamp)               // Unix seconds
  .limit(100)                     // Max events
  .build();

// Or construct directly
const filter = new Filter({
  kinds: [31113, 31115],
  "#p": ["recipient_pubkey"],
  since: Math.floor(Date.now() / 1000) - 3600,
  limit: 50,
});
```

#### Event Kinds Reference

```typescript
import { EventKinds } from "@unicitylabs/nostr-js-sdk";

// Standard NOSTR kinds
EventKinds.PROFILE           // 0  - User profile metadata
EventKinds.TEXT_NOTE         // 1  - Public text note
EventKinds.ENCRYPTED_DM      // 4  - NIP-04 encrypted DM
EventKinds.SEAL              // 13 - NIP-17 seal (inner layer)
EventKinds.CHAT_MESSAGE      // 14 - NIP-17 chat message
EventKinds.READ_RECEIPT      // 15 - NIP-17 read receipt
EventKinds.GIFT_WRAP         // 1059 - NIP-17 gift wrap (outer layer)
EventKinds.APP_DATA          // 30078 - Application-specific data

// Unicity custom kinds
EventKinds.TOKEN_TRANSFER    // 31113 - Token transfer
EventKinds.PAYMENT_REQUEST   // 31115 - Payment request
EventKinds.AGENT_PROFILE     // 31111 - Agent profile
EventKinds.AGENT_LOCATION    // 31112 - Agent location
EventKinds.FILE_METADATA     // 31114 - File metadata
```

#### Managing Subscriptions

```typescript
// Subscribe returns a subscription ID
const subId = client.subscribe(filter, {
  onEvent: (event) => { /* handle event */ },
  onEndOfStoredEvents: () => { /* caught up */ },
  onError: (subId, error) => { /* handle error */ },
});

// Custom subscription ID
const subId = client.subscribe("my-custom-id", filter, listener);

// Unsubscribe when done
client.unsubscribe(subId);
```

---

### Encryption

The SDK supports two encryption standards.

#### NIP-04 (Legacy AES-256-CBC)

Used for payment requests and token transfers.

```typescript
// Encrypt a message
const encrypted = await keyManager.encryptHex(
  "secret message",
  recipientPubkeyHex
);

// Decrypt a message
const decrypted = await keyManager.decryptHex(
  encryptedContent,
  senderPubkeyHex
);
```

#### NIP-44 (Modern XChaCha20-Poly1305)

More secure, used for NIP-17 private messages.

```typescript
// Encrypt
const encrypted = keyManager.encryptNip44Hex(message, recipientPubkeyHex);

// Decrypt
const decrypted = keyManager.decryptNip44Hex(encryptedContent, senderPubkeyHex);
```

---

## State Transition SDK

The State Transition SDK handles token verification and state management.

### Aggregator Client

Connect to the Unicity aggregator for token operations:

```typescript
import { AggregatorClient } from "@unicitylabs/state-transition-sdk";

const aggregator = new AggregatorClient(
  "https://gateway-test.unicity.network",
  "your-api-key" // Optional for testnet
);

// Get current block height
const height = await aggregator.getBlockHeight();

// Submit a commitment
const response = await aggregator.submitCommitment(
  requestId,
  transactionHash,
  authenticator
);

// Get inclusion proof
const proof = await aggregator.getInclusionProof(requestId);
```

### Token Operations

```typescript
import { 
  Token, 
  TokenState, 
  SigningService,
  StateTransitionClient 
} from "@unicitylabs/state-transition-sdk";

// Create signing service
const signingService = new SigningService(privateKeyBytes);

// Create state transition client
const stClient = new StateTransitionClient(aggregator);

// Check if a token is minted
const isMinted = await stClient.isMinted(trustBase, tokenId);

// Check if state is spent
const isSpent = await stClient.isStateSpent(trustBase, requestId);
```

### Trust Base

The trust base contains the validator set and network state:

```typescript
import { RootTrustBase } from "@unicitylabs/state-transition-sdk";
import fs from "fs";

// Load trust base from file
const trustBaseJson = JSON.parse(fs.readFileSync("./trust-base.json", "utf-8"));
const trustBase = RootTrustBase.fromJSON(trustBaseJson);

// Trust base properties
console.log("Network ID:", trustBase.networkId);
console.log("Epoch:", trustBase.epoch);
console.log("Validators:", trustBase.rootNodes.length);
```

---

## Complete Examples

### Example 1: Merchant Payment Service

A complete merchant that can request and receive payments:

```typescript
import { NostrKeyManager, NostrClient, Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";

class PaymentService {
  private keyManager: NostrKeyManager;
  private client: NostrClient;
  private pendingPayments = new Map<string, (result: any) => void>();
  
  constructor(privateKeyHex: string) {
    this.keyManager = NostrKeyManager.fromPrivateKeyHex(privateKeyHex);
    this.client = new NostrClient(this.keyManager);
  }
  
  async connect(relays: string[]): Promise<void> {
    await this.client.connect(...relays);
    this.subscribeToPayments();
  }
  
  private subscribeToPayments(): void {
    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER)
      .pTags(this.keyManager.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000) - 1800)
      .build();
    
    this.client.subscribe(filter, {
      onEvent: async (event) => {
        await this.handlePayment(event);
      },
    });
  }
  
  private async handlePayment(event: any): Promise<void> {
    const decrypted = await this.keyManager.decryptHex(event.content, event.pubkey);
    const jsonStr = decrypted.replace(/^token_transfer:/, "");
    const data = JSON.parse(jsonStr);
    
    const resolver = this.pendingPayments.get(data.requestId);
    if (resolver) {
      resolver({ success: true, amount: data.amount, from: event.pubkey });
      this.pendingPayments.delete(data.requestId);
    }
  }
  
  async requestPayment(
    customerNametag: string,
    amount: bigint,
    orderId: string
  ): Promise<{ success: boolean; amount?: string; from?: string }> {
    const customerPubkey = await this.client.queryPubkeyByNametag(customerNametag);
    if (!customerPubkey) {
      throw new Error(`Customer nametag not found: ${customerNametag}`);
    }
    
    const requestId = `order_${orderId}`;
    
    await this.client.sendPaymentRequest(customerPubkey, {
      amount,
      coinId: "414c504841", // ALPHA
      recipientNametag: "my-merchant",
      message: `Payment for order #${orderId}`,
      requestId,
    });
    
    // Wait for payment with timeout
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPayments.delete(requestId);
        resolve({ success: false });
      }, 120000); // 2 minute timeout
      
      this.pendingPayments.set(requestId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }
  
  disconnect(): void {
    this.client.disconnect();
  }
}

// Usage
const merchant = new PaymentService(process.env.MERCHANT_PRIVATE_KEY!);
await merchant.connect(["wss://nostr-relay.testnet.unicity.network"]);

const result = await merchant.requestPayment("customer-alice", 5000n, "12345");
if (result.success) {
  console.log(`Received ${result.amount} from ${result.from}`);
} else {
  console.log("Payment timed out");
}
```

### Example 2: Wallet/Payer Client

A client that listens for payment requests and sends payments:

```typescript
import { NostrKeyManager, NostrClient, Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";

class WalletClient {
  private keyManager: NostrKeyManager;
  private client: NostrClient;
  
  constructor(privateKeyHex: string) {
    this.keyManager = NostrKeyManager.fromPrivateKeyHex(privateKeyHex);
    this.client = new NostrClient(this.keyManager);
  }
  
  async connect(relays: string[]): Promise<void> {
    await this.client.connect(...relays);
  }
  
  async registerNametag(nametag: string): Promise<boolean> {
    return this.client.publishNametagBinding(
      nametag,
      this.keyManager.getPublicKeyHex()
    );
  }
  
  listenForPaymentRequests(callback: (request: any) => void): void {
    const filter = Filter.builder()
      .kinds(EventKinds.PAYMENT_REQUEST)
      .pTags(this.keyManager.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000))
      .build();
    
    this.client.subscribe(filter, {
      onEvent: async (event) => {
        const decrypted = await this.keyManager.decryptHex(event.content, event.pubkey);
        const jsonStr = decrypted.replace(/^payment_request:/, "");
        const request = JSON.parse(jsonStr);
        request.fromPubkey = event.pubkey;
        request.eventId = event.id;
        callback(request);
      },
    });
  }
  
  async sendPayment(
    recipientNametag: string,
    amount: string,
    requestId: string
  ): Promise<string> {
    const recipientPubkey = await this.client.queryPubkeyByNametag(recipientNametag);
    if (!recipientPubkey) {
      throw new Error(`Recipient not found: ${recipientNametag}`);
    }
    
    const tokenData = JSON.stringify({
      amount,
      coinId: "414c504841",
      requestId,
      message: `Payment for ${requestId}`,
    });
    
    return this.client.sendTokenTransfer(recipientPubkey, tokenData);
  }
  
  disconnect(): void {
    this.client.disconnect();
  }
}

// Usage
const wallet = new WalletClient(process.env.WALLET_PRIVATE_KEY!);
await wallet.connect(["wss://nostr-relay.testnet.unicity.network"]);
await wallet.registerNametag("my-wallet");

// Listen for incoming payment requests
wallet.listenForPaymentRequests(async (request) => {
  console.log("Payment request received:");
  console.log(`  Amount: ${request.amount}`);
  console.log(`  From: ${request.recipientNametag}`);
  console.log(`  Message: ${request.message}`);
  
  // Auto-pay (in real app, you'd prompt the user)
  const eventId = await wallet.sendPayment(
    request.recipientNametag,
    request.amount.toString(),
    request.requestId
  );
  console.log("Payment sent:", eventId);
});
```

### Example 3: Simple Test Script

For testing payment flows:

```typescript
#!/usr/bin/env npx tsx

import { NostrKeyManager, NostrClient } from "@unicitylabs/nostr-js-sdk";
import { randomBytes } from "crypto";

const RELAY = "wss://nostr-relay.testnet.unicity.network";

async function main() {
  // Generate or load keys
  const privateKey = process.env.PRIVATE_KEY || randomBytes(32).toString("hex");
  const keys = NostrKeyManager.fromPrivateKeyHex(privateKey);
  const client = new NostrClient(keys);
  
  console.log("Public key:", keys.getPublicKeyHex());
  console.log("Connecting to:", RELAY);
  
  await client.connect(RELAY);
  console.log("Connected!");
  
  const command = process.argv[2];
  
  switch (command) {
    case "register":
      const nametag = process.argv[3];
      const success = await client.publishNametagBinding(nametag, keys.getPublicKeyHex());
      console.log(success ? `Registered: ${nametag}` : "Failed to register");
      break;
      
    case "lookup":
      const name = process.argv[3];
      const pubkey = await client.queryPubkeyByNametag(name);
      console.log(pubkey ? `Found: ${pubkey}` : "Not found");
      break;
      
    case "pay":
      const [recipient, amount, requestId] = process.argv.slice(3);
      const recipientPubkey = await client.queryPubkeyByNametag(recipient);
      if (!recipientPubkey) {
        console.error("Recipient not found");
        break;
      }
      const eventId = await client.sendTokenTransfer(recipientPubkey, JSON.stringify({
        amount, coinId: "414c504841", requestId, message: `Payment ${requestId}`
      }));
      console.log("Sent:", eventId);
      break;
      
    default:
      console.log(`
Usage:
  register <nametag>              - Register a nametag
  lookup <nametag>                - Look up a nametag
  pay <nametag> <amount> <reqId>  - Send a payment
      `);
  }
  
  client.disconnect();
}

main().catch(console.error);
```

---

## API Reference

### NostrKeyManager

| Method | Returns | Description |
|--------|---------|-------------|
| `generate()` | `NostrKeyManager` | Create new random keypair |
| `fromPrivateKeyHex(hex)` | `NostrKeyManager` | Create from 64-char hex key |
| `fromPrivateKey(bytes)` | `NostrKeyManager` | Create from 32-byte Uint8Array |
| `fromNsec(nsec)` | `NostrKeyManager` | Create from bech32 nsec |
| `getPublicKeyHex()` | `string` | Get 64-char hex public key |
| `getPrivateKeyHex()` | `string` | Get 64-char hex private key |
| `getNpub()` | `string` | Get bech32 npub |
| `getNsec()` | `string` | Get bech32 nsec |
| `encryptHex(msg, recipientPubkey)` | `Promise<string>` | NIP-04 encrypt |
| `decryptHex(content, senderPubkey)` | `Promise<string>` | NIP-04 decrypt |
| `encryptNip44Hex(msg, recipientPubkey)` | `string` | NIP-44 encrypt |
| `decryptNip44Hex(content, senderPubkey)` | `string` | NIP-44 decrypt |
| `sign(hash)` | `Uint8Array` | Sign message hash |
| `clear()` | `void` | Zero out private key |

### NostrClient

| Method | Returns | Description |
|--------|---------|-------------|
| `connect(...relays)` | `Promise<void>` | Connect to relays |
| `disconnect()` | `void` | Disconnect from all relays |
| `isConnected()` | `boolean` | Check if connected |
| `getConnectedRelays()` | `Set<string>` | Get connected relay URLs |
| `publishNametagBinding(tag, pubkey)` | `Promise<boolean>` | Register nametag |
| `queryPubkeyByNametag(tag)` | `Promise<string\|null>` | Resolve nametag |
| `sendPaymentRequest(pubkey, request)` | `Promise<string>` | Send payment request |
| `sendTokenTransfer(pubkey, tokenJson)` | `Promise<string>` | Send token transfer |
| `sendPrivateMessage(pubkey, msg)` | `Promise<string>` | Send NIP-17 DM |
| `subscribe(filter, listener)` | `string` | Subscribe to events |
| `unsubscribe(subId)` | `void` | Unsubscribe |

### Filter.builder()

| Method | Description |
|--------|-------------|
| `.kinds(...kinds)` | Filter by event kinds |
| `.authors(...pubkeys)` | Filter by author pubkeys |
| `.pTags(...pubkeys)` | Filter by "p" tag (recipient) |
| `.since(timestamp)` | Events after timestamp (Unix seconds) |
| `.until(timestamp)` | Events before timestamp |
| `.limit(n)` | Max events to return |
| `.build()` | Build the filter |

---

## Environment Configuration

Create a `.env` file:

```bash
# NOSTR Configuration
NOSTR_PRIVATE_KEY=your_64_char_hex_private_key
NOSTR_RELAYS=wss://nostr-relay.testnet.unicity.network

# Your registered nametag
MARKET_NAMETAG=my-service

# Unicity Aggregator (for State Transition SDK)
UNICITY_AGGREGATOR_URL=https://gateway-test.unicity.network
UNICITY_AGGREGATOR_APIKEY=your_api_key

# Token ID for payments
ALPHA_COIN_ID=414c504841

# Trust base file path
TRUST_BASE_PATH=./trust-base.json
```

### Generating a Private Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Troubleshooting

### Common Issues

#### "Nametag not found"

- The nametag hasn't been registered yet
- Use `client.publishNametagBinding(nametag, pubkey)` to register
- Wait a few seconds after registration for relay propagation

#### "Failed to decrypt"

- Wrong sender pubkey passed to `decryptHex`
- Use `event.pubkey` (the sender's pubkey) when decrypting
- Content might not be NIP-04 encrypted (check if it contains `?iv=`)

#### "Connection failed"

- Check relay URL (must be `wss://` or `ws://`)
- Relay might be down - try a backup relay
- Check firewall/network settings

#### Token transfer not received

- Verify subscription filter includes `EventKinds.TOKEN_TRANSFER` (31113)
- Check that `pTags` uses your correct public key
- Ensure `since` timestamp isn't in the future

#### Payment request not received

- Verify subscription filter includes `EventKinds.PAYMENT_REQUEST` (31115)
- Sender must use your correct public key (resolved from nametag)

### Debug Logging

```typescript
// Log all events for debugging
client.subscribe(Filter.builder().pTags(myPubkey).build(), {
  onEvent: (event) => {
    console.log("Event:", {
      id: event.id,
      kind: event.kind,
      from: event.pubkey.slice(0, 16),
      content: event.content.slice(0, 50),
      tags: event.tags,
    });
  },
});
```

### Testing Connectivity

```typescript
const client = new NostrClient(keyManager);
await client.connect("wss://nostr-relay.testnet.unicity.network");

console.log("Connected:", client.isConnected());
console.log("Relays:", [...client.getConnectedRelays()]);
console.log("My pubkey:", keyManager.getPublicKeyHex());

// Try to resolve a known nametag
const pubkey = await client.queryPubkeyByNametag("test");
console.log("Nametag lookup:", pubkey ? "working" : "failed");
```

---

## Resources

- **Testnet Relay**: `wss://nostr-relay.testnet.unicity.network`
- **Aggregator Gateway**: `https://gateway-test.unicity.network`
- **ALPHA Token ID**: `414c504841` (hex for "ALPHA")

---

## Summary

1. **Create keys** with `NostrKeyManager.fromPrivateKeyHex()`
2. **Connect** with `new NostrClient(keys)` and `client.connect(relay)`
3. **Register nametag** with `client.publishNametagBinding()`
4. **Send payment requests** with `client.sendPaymentRequest()`
5. **Receive payments** by subscribing to `EventKinds.TOKEN_TRANSFER`
6. **Send payments** with `client.sendTokenTransfer()`
7. **Decrypt content** with `keyManager.decryptHex(content, senderPubkey)`

The payment flow is:
1. Merchant sends `PAYMENT_REQUEST` to customer
2. Customer's wallet displays the request
3. Customer sends `TOKEN_TRANSFER` back to merchant
4. Merchant decrypts and verifies payment, matches by `requestId`
