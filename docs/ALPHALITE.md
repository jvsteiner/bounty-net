# Alphalite Usage Guide

Alphalite is a lightweight TypeScript library for wallet and token management on the Unicity Protocol. It provides a simplified API for creating wallets, managing identities, minting tokens, and transferring tokens between parties.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Wallet Management](#wallet-management)
  - [Creating a Wallet](#creating-a-wallet)
  - [Exporting and Importing Wallets](#exporting-and-importing-wallets)
  - [Encrypted Wallets](#encrypted-wallets)
- [Identity Management](#identity-management)
  - [Creating Identities](#creating-identities)
  - [Managing Multiple Identities](#managing-multiple-identities)
  - [Getting Addresses](#getting-addresses)
- [Token Operations](#token-operations)
  - [Setting Up the Client](#setting-up-the-client)
  - [Minting Tokens](#minting-tokens)
  - [Sending Tokens](#sending-tokens)
  - [Receiving Tokens](#receiving-tokens)
  - [Checking Token Status](#checking-token-status)
- [SimpleToken API](#simpletoken-api)
- [Utility Functions](#utility-functions)
- [Type Reference](#type-reference)
- [Error Handling](#error-handling)
- [Advanced Usage](#advanced-usage)

---

## Installation

```bash
npm install @jvsteiner/alphalite
```

## Quick Start

```typescript
import { Wallet, AlphaClient, RootTrustBase } from '@jvsteiner/alphalite';

// Create a wallet
const wallet = await Wallet.create({ name: 'My Wallet' });

// Set up the client with trust base
const client = new AlphaClient({ gatewayUrl: 'https://gateway-test.unicity.network:443' });
const trustBase = RootTrustBase.fromJSON(trustBaseJson); // Load from config
client.setTrustBase(trustBase);

// Mint a token
const token = await client.mint(wallet, {
  coins: [['ALPHA', 1000n]],
  label: 'My First Token'
});

console.log(`Minted token: ${token.id}`);
console.log(`Balance: ${token.getCoinBalance('ALPHA')}`);
```

---

## Wallet Management

### Creating a Wallet

A wallet holds one or more identities (key pairs) and tokens. Create a new wallet with:

```typescript
import { Wallet } from '@jvsteiner/alphalite';

// Default wallet
const wallet = await Wallet.create();

// With custom options
const wallet = await Wallet.create({
  name: 'My Wallet',
  identityLabel: 'Primary Key',
  defaultTokenType: new Uint8Array(32).fill(0x01)
});
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `'My Wallet'` | Human-readable wallet name |
| `identityLabel` | `string` | `'Default'` | Label for the initial identity |
| `defaultTokenType` | `Uint8Array` | 32 bytes of `0x01` | Default token type for operations |

### Exporting and Importing Wallets

Save a wallet to JSON for backup or transfer:

```typescript
// Export (unencrypted - for development only!)
const json = wallet.toJSON();
const jsonString = JSON.stringify(json);

// Import
const imported = await Wallet.fromJSON(json);
```

**Export Options:**

```typescript
const json = wallet.toJSON({
  password: undefined,      // No encryption
  includeTokens: true       // Include token data (default: true)
});
```

### Encrypted Wallets

Always encrypt wallets in production:

```typescript
// Export with encryption
const json = wallet.toJSON({ password: 'my-secure-password' });

// The JSON contains:
// - encrypted: true
// - salt: hex-encoded scrypt salt
// - identities[].encryptedSecret (instead of secret)

// Import encrypted wallet
const imported = await Wallet.fromJSON(json, { password: 'my-secure-password' });
```

Encryption uses:
- **Key Derivation:** scrypt (N=131072, r=8, p=1)
- **Cipher:** XChaCha20-Poly1305

**Error handling:**

```typescript
try {
  await Wallet.fromJSON(encryptedJson, { password: 'wrong-password' });
} catch (error) {
  // Throws on wrong password or missing password
}
```

---

## Identity Management

An identity represents a key pair that can sign transactions and own tokens.

### Creating Identities

Every wallet starts with one identity. Create additional identities:

```typescript
// Create with default options
const identity = await wallet.createIdentity();

// Create with options
const identity = await wallet.createIdentity({
  label: 'Secondary Key',
  setAsDefault: true
});

// Import existing secret
const identity = await wallet.createIdentity({
  label: 'Imported',
  secret: existingSecretBytes  // 128 bytes
});
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `label` | `string` | Human-readable name |
| `secret` | `Uint8Array` | Import existing 128-byte secret |
| `setAsDefault` | `boolean` | Make this the default identity |

### Managing Multiple Identities

```typescript
// List all identities
const identities = wallet.listIdentities();
for (const id of identities) {
  console.log(`${id.label}: ${id.id}`);
}

// Get specific identity
const identity = wallet.getIdentity(identityId);

// Get/set default identity
const defaultId = wallet.getDefaultIdentity();
wallet.setDefaultIdentity(otherIdentityId);

// Remove identity (cannot remove last identity)
wallet.removeIdentity(identityId);
```

### Getting Addresses

An address is derived from an identity and token type:

```typescript
// Default identity + default token type
const address = await wallet.getDefaultAddress();

// Specific identity
const address = await wallet.getAddress(identityId);

// Specific identity + token type
const address = await wallet.getAddress(identityId, customTokenType);

// Using AlphaClient
const address = await client.getAddress(wallet);
const address = await client.getAddressForIdentity(wallet, identityId);
```

---

## Token Operations

### Setting Up the Client

The `AlphaClient` handles network operations:

```typescript
import { AlphaClient, RootTrustBase } from '@jvsteiner/alphalite';

// Create client
const client = new AlphaClient({
  gatewayUrl: 'https://gateway-test.unicity.network:443',  // Optional, this is default
  apiKey: 'your-api-key'  // Optional
});

// Load and set trust base (required for all operations)
const trustBaseJson = await fetch('/path/to/trustbase.json').then(r => r.json());
const trustBase = RootTrustBase.fromJSON(trustBaseJson);
client.setTrustBase(trustBase);
```

### Minting Tokens

Create new tokens on the network:

```typescript
// Basic mint
const token = await client.mint(wallet);

// Mint with coin balances
const token = await client.mint(wallet, {
  coins: [
    ['ALPHA', 1000n],
    ['BETA', 500n]
  ]
});

// Mint with data payload
const token = await client.mint(wallet, {
  data: new TextEncoder().encode('Hello, Unicity!'),
  label: 'My NFT'
});

// Mint with specific identity
const token = await client.mint(wallet, {
  identityId: specificIdentityId,
  tokenId: customTokenId,      // 32 bytes, auto-generated if omitted
  tokenType: customTokenType   // 32 bytes, uses wallet default if omitted
});
```

**Mint Options:**

| Option | Type | Description |
|--------|------|-------------|
| `tokenId` | `Uint8Array` | Custom 32-byte token ID |
| `tokenType` | `Uint8Array` | Custom 32-byte token type |
| `data` | `Uint8Array` | Arbitrary data payload |
| `coins` | `[string, bigint][]` | Coin balances as name/amount pairs |
| `identityId` | `string` | Identity to mint with |
| `label` | `string` | Label for wallet storage |

### Sending Tokens

Transfer a token to another address:

```typescript
// Get recipient's address (they provide this)
const recipientAddress = 'U1...'; // Unicity address string

// Send token
const result = await client.send(wallet, tokenId, recipientAddress);

// result contains:
// - tokenJson: string (send to recipient)
// - transactionJson: string (send to recipient)

// With options
const result = await client.send(wallet, tokenId, recipientAddress, {
  message: 'Payment for services',
  recipientData: new Uint8Array([...])  // Optional data for recipient
});
```

**Important:** After sending, the token is removed from your wallet. Send `tokenJson` and `transactionJson` to the recipient through a secure channel.

### Receiving Tokens

Accept a token sent by another party:

```typescript
// Receive the JSON strings from sender
const { tokenJson, transactionJson } = receivedFromSender;

// Receive the token
const token = await client.receive(wallet, tokenJson, transactionJson);

// With options
const token = await client.receive(wallet, tokenJson, transactionJson, {
  identityId: specificIdentityId,  // Receive to specific identity
  label: 'Payment received',
  transactionData: recipientData   // If sender included recipientData
});
```

### Checking Token Status

Verify if a token has been spent:

```typescript
const status = await client.getTokenStatus(wallet, tokenId);

console.log(`Spent: ${status.spent}`);
console.log(`Transactions: ${status.transactionCount}`);
```

---

## SimpleToken API

`SimpleToken` wraps the SDK's Token class with a simpler interface:

```typescript
// Access from wallet
const entry = wallet.getToken(tokenId);
const token = entry.token;

// Properties
token.id              // Hex string
token.idBytes         // Uint8Array
token.type            // Hex string
token.typeBytes       // Uint8Array
token.version         // String
token.data            // Uint8Array | null
token.dataString      // String | null (UTF-8 decoded)
token.transactionCount // Number
token.hasCoins        // Boolean
token.coins           // ICoinBalance[]
token.coinMap         // Map<string, bigint>
token.nametagCount    // Number

// Get specific coin balance
const balance = token.getCoinBalance('ALPHA');  // bigint

// Serialization
const json = token.toJSON();      // String
const cbor = token.toCBOR();      // Uint8Array
const str = token.toString();     // Human-readable summary

// Deserialize
const token = await SimpleToken.fromJSON(jsonString);
const token = await SimpleToken.fromCBOR(cborBytes);

// Access underlying SDK token
const rawToken = token.raw;
```

**ICoinBalance:**

```typescript
interface ICoinBalance {
  name: string;    // Coin name (e.g., 'ALPHA')
  amount: bigint;  // Balance
}
```

---

## Utility Functions

Alphalite exports several cryptographic utilities:

```typescript
import {
  bytesToHex,
  hexToBytes,
  generateRandom32,
  generateSecret
} from '@jvsteiner/alphalite';

// Hex conversion
const hex = bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
// => 'deadbeef'

const bytes = hexToBytes('deadbeef');
// => Uint8Array([0xde, 0xad, 0xbe, 0xef])

// Random generation
const tokenId = generateRandom32();   // 32 random bytes
const secret = generateSecret();       // 128 random bytes
```

---

## Type Reference

### Wallet Types

```typescript
interface IWalletCreateOptions {
  name?: string;
  defaultTokenType?: Uint8Array;
  identityLabel?: string;
}

interface IWalletExportOptions {
  password?: string;
  includeTokens?: boolean;
}

interface IWalletImportOptions {
  password?: string;
  merge?: boolean;
}

interface IWalletJson {
  version: string;
  id: string;
  name: string;
  encrypted: boolean;
  salt?: string;
  identities: IIdentityJson[];
  defaultIdentityId: string;
  tokens: ITokenEntryJson[];
  defaultTokenType: string;
  createdAt: string;
  modifiedAt: string;
}
```

### Identity Types

```typescript
interface ICreateIdentityOptions {
  label?: string;
  secret?: Uint8Array;
  setAsDefault?: boolean;
}

interface IIdentityJson {
  id: string;
  label: string;
  publicKey: string;
  encryptedSecret?: string;
  secret?: string;
  nonce: string;
  createdAt: string;
}
```

### Token Types

```typescript
interface IMintOptions {
  tokenId?: Uint8Array;
  tokenType?: Uint8Array;
  data?: Uint8Array;
  coins?: ReadonlyArray<readonly [string, bigint]>;
  identityId?: string;
  label?: string;
}

interface ITransferOptions {
  message?: string;
  recipientData?: Uint8Array;
}

interface IReceiveOptions {
  identityId?: string;
  label?: string;
  transactionData?: Uint8Array;
}

interface ISendResult {
  tokenJson: string;
  transactionJson: string;
}

interface ITokenStatus {
  spent: boolean;
  transactionCount: number;
}

interface ICoinBalance {
  name: string;
  amount: bigint;
}
```

### Client Types

```typescript
interface IAlphaClientConfig {
  gatewayUrl?: string;
  trustBase?: RootTrustBase;
  apiKey?: string;
}
```

---

## Error Handling

Alphalite throws descriptive errors:

```typescript
try {
  await client.mint(wallet);
} catch (error) {
  if (error.message.includes('Trust base not configured')) {
    // Need to call client.setTrustBase() first
  } else if (error.message.includes('Identity not found')) {
    // Invalid identityId provided
  } else if (error.message.includes('submission failed')) {
    // Network error or rejection
  } else if (error.message.includes('Inclusion proof not found')) {
    // Transaction not confirmed in time
  }
}
```

Common errors:

| Error | Cause | Solution |
|-------|-------|----------|
| `Trust base not configured` | No trust base set | Call `client.setTrustBase()` |
| `Identity not found` | Invalid identity ID | Use valid ID from `wallet.listIdentities()` |
| `Token not found in wallet` | Invalid token ID | Check `wallet.listTokens()` |
| `Password required` | Importing encrypted wallet | Provide password in options |
| `Cannot remove the last identity` | Trying to delete only identity | Create another identity first |
| `Inclusion proof not found` | Transaction not confirmed | Retry or check network status |

---

## Advanced Usage

### Merging Wallets

Combine identities and tokens from multiple wallets:

```typescript
const wallet1 = await Wallet.create({ name: 'Wallet 1' });
const wallet2 = await Wallet.create({ name: 'Wallet 2' });

// Merge wallet2 into wallet1
await wallet1.merge(wallet2);

// wallet1 now contains all identities and tokens from both
```

### Working with Raw SDK Objects

Access underlying SDK objects for advanced operations:

```typescript
// Get raw Token
const rawToken = simpleToken.raw;

// Get raw coin data
const coinData = simpleToken.rawCoins;

// Get signing service from identity
const signingService = await identity.getSigningService();
```

### Nametag Addresses

Create proxy addresses from human-readable names:

```typescript
const address = await client.createNametag('alice.unicity');
```

### Token Labels

Organize tokens with labels:

```typescript
// Add with label
wallet.addToken(token, identityId, 'Monthly Payment');

// List with labels
for (const entry of wallet.listTokens()) {
  console.log(`${entry.label}: ${entry.token.id}`);
}
```

### Rotating Identity Nonces

For privacy, rotate the nonce used in address derivation:

```typescript
const identity = wallet.getDefaultIdentity();
identity.rotateNonce();
// Future addresses will be different (but still controlled by same key)
```

---

## Re-exported SDK Types

For convenience, commonly used SDK types are re-exported:

```typescript
import {
  HashAlgorithm,
  RootTrustBase,
  Token,
  TokenId,
  TokenType
} from '@jvsteiner/alphalite';
```

These can be used for advanced SDK interop when needed.
