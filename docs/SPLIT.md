# Token Splitting Guide for Unicity State Transition SDK

This guide explains how to implement token splitting (partial transfers) using the `@unicitylabs/state-transition-sdk`. Token splitting allows you to send a portion of a fungible token's balance while retaining the remainder as "change."

## Table of Contents

- [Overview](#overview)
- [When You Need Token Splitting](#when-you-need-token-splitting)
- [Conceptual Model](#conceptual-model)
- [Prerequisites](#prerequisites)
- [Implementation](#implementation)
  - [Required Imports](#required-imports)
  - [Step 1: Prepare the Split](#step-1-prepare-the-split)
  - [Step 2: Build the Split](#step-2-build-the-split)
  - [Step 3: Submit Burn Commitment](#step-3-submit-burn-commitment)
  - [Step 4: Submit Mint Commitments](#step-4-submit-mint-commitments)
  - [Step 5: Create Your Change Token](#step-5-create-your-change-token)
  - [Step 6: Send Recipient Token Data](#step-6-send-recipient-token-data)
- [Receiving Split Tokens](#receiving-split-tokens)
- [Critical Gotchas](#critical-gotchas)
- [Complete Example](#complete-example)
- [Error Handling](#error-handling)
- [Testing Tips](#testing-tips)

---

## Overview

In the Unicity protocol, tokens are indivisible units that carry coin balances. To send a partial amount from a token, you must:

1. **Burn** the original token
2. **Mint** two new tokens from the burn:
   - One for the recipient (with the transfer amount)
   - One for yourself (with the change/remainder)

This is an atomic operation enforced by the aggregator - either both new tokens are created, or neither is.

## When You Need Token Splitting

Use token splitting when:

- You have a token with balance `X` but need to send amount `Y` where `Y < X`
- You want to preserve remaining balance rather than transferring the entire token
- You're building a payment system with arbitrary amounts

**Don't use splitting when:**

- The token balance exactly equals the transfer amount (use simple transfer instead)
- You're transferring non-fungible tokens or tokens without coin balances

## Conceptual Model

```
BEFORE:
┌─────────────────────────┐
│ Original Token          │
│ ID: abc123...           │
│ Balance: 1000 ALPHA     │
│ Owner: You              │
└─────────────────────────┘

SPLIT (sending 300 to recipient):

┌─────────────────────────┐
│ Original Token          │
│ Status: BURNED          │
└─────────────────────────┘
            │
            ▼
    ┌───────┴───────┐
    │               │
    ▼               ▼
┌──────────┐  ┌──────────┐
│ Token A  │  │ Token B  │
│ 300 ALPHA│  │ 700 ALPHA│
│ Recipient│  │ You      │
└──────────┘  └──────────┘
```

## Prerequisites

Before implementing splits, ensure you have:

```typescript
import { StateTransitionClient } from "@unicitylabs/state-transition-sdk/lib/StateTransitionClient.js";
import { AggregatorClient } from "@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js";
import { SigningService } from "@unicitylabs/state-transition-sdk/lib/sign/SigningService.js";
import { RootTrustBase } from "@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js";

// Initialize these before splitting
const aggregator = new AggregatorClient(aggregatorUrl, apiKey);
const stateClient = new StateTransitionClient(aggregator);
const signingService = new SigningService(privateKeyBytes);
const trustBase = RootTrustBase.fromJSON(trustBaseJson);
```

## Implementation

### Required Imports

```typescript
import { Token } from "@unicitylabs/state-transition-sdk/lib/token/Token.js";
import { TokenId } from "@unicitylabs/state-transition-sdk/lib/token/TokenId.js";
import { TokenState } from "@unicitylabs/state-transition-sdk/lib/token/TokenState.js";
import { CoinId } from "@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId.js";
import { TokenCoinData } from "@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData.js";
import { TokenSplitBuilder } from "@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder.js";
import { UnmaskedPredicate } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js";
import { UnmaskedPredicateReference } from "@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js";
import { HashAlgorithm } from "@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js";
import { SubmitCommitmentStatus } from "@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js";
import { waitInclusionProof } from "@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js";
```

### Step 1: Prepare the Split

First, calculate amounts and create addresses for both output tokens:

```typescript
async function prepareSplit(
  token: Token<unknown>,
  recipientPubkeyBytes: Uint8Array,
  amount: bigint,
  coinId: string,
  signingService: SigningService,
) {
  const coinIdObj = CoinId.fromJSON(coinId);
  const tokenBalance = token.coins?.get(coinIdObj) ?? 0n;
  const changeAmount = tokenBalance - amount;

  if (changeAmount < 0n) {
    throw new Error(`Insufficient balance: have ${tokenBalance}, need ${amount}`);
  }

  // Create recipient address from their public key
  const recipientPredicateRef = await UnmaskedPredicateReference.create(
    token.type,
    "secp256k1",
    recipientPubkeyBytes,
    HashAlgorithm.SHA256,
  );
  const recipientAddress = await recipientPredicateRef.toAddress();

  // Create our address for the change token
  const myPredicateRef = await UnmaskedPredicateReference.create(
    token.type,
    "secp256k1",
    signingService.publicKey,
    HashAlgorithm.SHA256,
  );
  const myAddress = await myPredicateRef.toAddress();

  // Generate new token IDs (random 32 bytes each)
  const recipientTokenId = new TokenId(crypto.getRandomValues(new Uint8Array(32)));
  const changeTokenId = new TokenId(crypto.getRandomValues(new Uint8Array(32)));

  // Generate salts for predicate derivation
  // IMPORTANT: Save these - you'll need them later!
  const recipientSalt = crypto.getRandomValues(new Uint8Array(32));
  const changeSalt = crypto.getRandomValues(new Uint8Array(32));

  // Create coin data for each new token
  const recipientCoinData = TokenCoinData.create([[coinIdObj, amount]]);
  const changeCoinData = TokenCoinData.create([[coinIdObj, changeAmount]]);

  return {
    recipientAddress,
    myAddress,
    recipientTokenId,
    changeTokenId,
    recipientSalt,
    changeSalt,
    recipientCoinData,
    changeCoinData,
    changeAmount,
  };
}
```

### Step 2: Build the Split

Use `TokenSplitBuilder` to define the split structure:

```typescript
async function buildSplit(
  token: Token<unknown>,
  recipientTokenId: TokenId,
  changeTokenId: TokenId,
  recipientAddress: Address,
  myAddress: Address,
  recipientCoinData: TokenCoinData,
  changeCoinData: TokenCoinData,
  recipientSalt: Uint8Array,
  changeSalt: Uint8Array,
) {
  const builder = new TokenSplitBuilder();

  // Add recipient token (will be index 0 in mint commitments)
  builder.createToken(
    recipientTokenId,
    token.type,
    null,              // tokenData (optional, for NFTs)
    recipientCoinData,
    recipientAddress,
    recipientSalt,
    null,              // recipientDataHash (optional)
  );

  // Add change token (will be index 1 in mint commitments)
  builder.createToken(
    changeTokenId,
    token.type,
    null,
    changeCoinData,
    myAddress,
    changeSalt,
    null,
  );

  // Build returns the split object
  return builder.build(token);
}
```

**Important:** The order you call `createToken` determines the index in the resulting mint commitments array. Keep track of which index is the recipient vs. change token.

### Step 3: Submit Burn Commitment

The burn commitment destroys the original token:

```typescript
async function submitBurnCommitment(
  split: TokenSplit,
  signingService: SigningService,
  stateClient: StateTransitionClient,
  trustBase: RootTrustBase,
) {
  // Generate salt for burn commitment
  const burnSalt = crypto.getRandomValues(new Uint8Array(32));

  // Create the burn commitment
  const burnCommitment = await split.createBurnCommitment(burnSalt, signingService);

  // Submit to aggregator
  const response = await stateClient.submitTransferCommitment(burnCommitment);
  if (response.status !== SubmitCommitmentStatus.SUCCESS) {
    throw new Error(`Burn commitment failed: ${response.status}`);
  }

  // Wait for inclusion proof (with timeout)
  const inclusionProof = await waitInclusionProof(
    trustBase,
    stateClient,
    burnCommitment,
    AbortSignal.timeout(30000),
  );

  // Create the burn transaction from commitment + proof
  const burnTransaction = burnCommitment.toTransaction(inclusionProof);

  return burnTransaction;
}
```

### Step 4: Submit Mint Commitments

After the burn is confirmed, mint the new tokens:

```typescript
async function submitMintCommitments(
  split: TokenSplit,
  burnTransaction: TransferTransaction,
  trustBase: RootTrustBase,
  stateClient: StateTransitionClient,
) {
  // Create mint commitments from the split + burn transaction
  const mintCommitments = await split.createSplitMintCommitments(
    trustBase,
    burnTransaction,
  );

  const mintTransactions = [];

  // Submit each mint commitment sequentially
  for (let i = 0; i < mintCommitments.length; i++) {
    const mintCommitment = mintCommitments[i];

    const response = await stateClient.submitMintCommitment(mintCommitment);
    if (response.status !== SubmitCommitmentStatus.SUCCESS) {
      throw new Error(`Mint commitment ${i} failed: ${response.status}`);
    }

    // Wait for inclusion proof
    const inclusionProof = await waitInclusionProof(
      trustBase,
      stateClient,
      mintCommitment,
      AbortSignal.timeout(30000),
    );

    // Create mint transaction from commitment + proof
    const mintTransaction = mintCommitment.toTransaction(inclusionProof);
    mintTransactions.push(mintTransaction);
  }

  return mintTransactions;
  // Index 0 = recipient token mint transaction
  // Index 1 = change token mint transaction (ours)
}
```

### Step 5: Create Your Change Token

Now construct the change token that you own:

```typescript
async function createChangeToken(
  changeTokenId: TokenId,
  tokenType: TokenType,
  changeMintTransaction: MintTransaction,
  signingService: SigningService,
  changeSalt: Uint8Array,  // MUST be the same salt from Step 1!
) {
  // Create predicate with the SAME salt used when building the split
  // This is critical - mismatched salts will cause verification failure
  const changePredicate = await UnmaskedPredicate.create(
    changeTokenId,
    tokenType,
    signingService,
    HashAlgorithm.SHA256,
    changeSalt,  // <-- Same salt from prepareSplit()
  );

  const changeTokenState = new TokenState(changePredicate, null);

  // Construct token JSON and use fromJSON to avoid verification issues
  const changeTokenJson = {
    version: "2.0",
    state: changeTokenState.toJSON(),
    genesis: changeMintTransaction.toJSON(),
    transactions: [],
    nametags: [],
  };

  const changeToken = await Token.fromJSON(changeTokenJson);

  // Store the salt/nonce for future transfers of this token
  // You'll need this to sign future transactions
  storeNonce(changeTokenId.toJSON(), changeSalt);

  return changeToken;
}
```

### Step 6: Send Recipient Token Data

Finally, send the recipient the data they need to claim their token:

```typescript
function prepareRecipientPayload(
  recipientMintTransaction: MintTransaction,
  burnTransaction: TransferTransaction,
  recipientSalt: Uint8Array,
  amount: bigint,
  coinId: string,
) {
  // The recipient needs:
  // 1. The mint transaction (proves their token was minted)
  // 2. Indicator that this is a split (not a simple transfer)
  // 3. The salt used for their address (needed to create predicate)
  // 4. Amount and coin info for verification

  return {
    tokenJson: JSON.stringify(recipientMintTransaction.toJSON()),
    transactionJson: JSON.stringify({
      type: "split_mint",
      burnTransaction: burnTransaction.toJSON(),
    }),
    salt: Array.from(recipientSalt),  // Convert Uint8Array for JSON
    amount: amount.toString(),
    coinId,
  };
}
```

---

## Receiving Split Tokens

When receiving a token from a split, the process differs from a standard transfer:

```typescript
async function receiveSplitMintToken(
  mintTransactionJson: string,
  salt: Uint8Array,
  signingService: SigningService,
) {
  // Import MintTransaction dynamically (or add to imports)
  const { MintTransaction } = await import(
    "@unicitylabs/state-transition-sdk/lib/transaction/MintTransaction.js"
  );

  // Parse the mint transaction
  const mintTransaction = await MintTransaction.fromJSON(
    JSON.parse(mintTransactionJson)
  );

  // Extract token info from the mint transaction
  const tokenId = mintTransaction.data.tokenId;
  const tokenType = mintTransaction.data.tokenType;

  // Create predicate using the salt from the transfer payload
  // CRITICAL: Must use the salt the sender used for your address!
  const predicate = await UnmaskedPredicate.create(
    tokenId,
    tokenType,
    signingService,
    HashAlgorithm.SHA256,
    salt,  // <-- Salt from sender's payload
  );

  const tokenState = new TokenState(predicate, null);

  // Construct the token
  const tokenJson = {
    version: "2.0",
    state: tokenState.toJSON(),
    genesis: mintTransaction.toJSON(),
    transactions: [],
    nametags: [],
  };

  const token = await Token.fromJSON(tokenJson);

  // Store the salt for future transfers
  storeNonce(tokenId.toJSON(), salt);

  return token;
}
```

### Detecting Split vs. Standard Transfers

Check the transaction type before processing:

```typescript
async function receiveToken(
  tokenJson: string,
  transactionJson: string,
  salt: Uint8Array,
) {
  const parsedTransaction = JSON.parse(transactionJson);

  if (parsedTransaction.type === "split_mint") {
    // This is from a split operation
    return receiveSplitMintToken(tokenJson, salt, signingService);
  } else {
    // Standard full token transfer
    return receiveFullTokenTransfer(tokenJson, transactionJson, salt);
  }
}
```

---

## Critical Gotchas

### 1. Salt Must Match

The most common cause of verification failures:

```typescript
// WRONG - using different salts
const recipientSalt = crypto.getRandomValues(new Uint8Array(32));
builder.createToken(..., recipientSalt, ...);
// Later, recipient uses a different salt
const predicate = await UnmaskedPredicate.create(..., differentSalt);
// ❌ Token verification will FAIL

// CORRECT - sender sends the salt to recipient
const recipientSalt = crypto.getRandomValues(new Uint8Array(32));
builder.createToken(..., recipientSalt, ...);
// Send recipientSalt to recipient in payload
// Recipient uses the SAME salt
const predicate = await UnmaskedPredicate.create(..., recipientSalt);
// ✓ Token verification succeeds
```

### 2. Order of Mint Commitments

`createSplitMintCommitments()` returns commitments in the same order you called `createToken()`:

```typescript
// You added recipient first, change second
builder.createToken(recipientTokenId, ...);  // index 0
builder.createToken(changeTokenId, ...);     // index 1

const mintCommitments = await split.createSplitMintCommitments(...);
// mintCommitments[0] = recipient token
// mintCommitments[1] = change token (yours)
```

### 3. Use `Token.fromJSON` to Avoid Verification Issues

When constructing tokens locally, use `fromJSON` instead of `Token.mint`:

```typescript
// May fail verification due to timing/state issues
const token = await Token.mint(trustBase, tokenState, mintTransaction);

// Safer - skips verification, useful when you know the token is valid
const token = await Token.fromJSON({
  version: "2.0",
  state: tokenState.toJSON(),
  genesis: mintTransaction.toJSON(),
  transactions: [],
  nametags: [],
});
```

### 4. Handle REQUEST_ID_EXISTS

If a token has a pending commitment, the aggregator will reject new commitments:

```typescript
const response = await stateClient.submitTransferCommitment(commitment);
if (response.status === "REQUEST_ID_EXISTS") {
  // This token has a pending operation
  // Either wait and retry, or use a different token
}
```

### 5. Store Nonces for Future Transfers

Every token needs its nonce/salt stored for signing future transfers:

```typescript
// When creating/receiving tokens
const nonces = new Map<string, Uint8Array>();
nonces.set(tokenId.toJSON(), salt);

// When transferring later, you'll need the nonce to sign
const nonce = nonces.get(tokenId);
```

---

## Complete Example

Here's a complete split transfer function:

```typescript
async function splitTransfer(
  token: Token<unknown>,
  recipientPubkeyHex: string,
  amount: bigint,
  coinId: string,
  signingService: SigningService,
  stateClient: StateTransitionClient,
  trustBase: RootTrustBase,
): Promise<{
  changeToken: Token<unknown>;
  recipientPayload: object;
}> {
  const recipientPubkeyBytes = hexToBytes(recipientPubkeyHex);
  const coinIdObj = CoinId.fromJSON(coinId);
  const tokenBalance = token.coins?.get(coinIdObj) ?? 0n;
  const changeAmount = tokenBalance - amount;

  // 1. Create addresses
  const recipientPredicateRef = await UnmaskedPredicateReference.create(
    token.type, "secp256k1", recipientPubkeyBytes, HashAlgorithm.SHA256,
  );
  const recipientAddress = await recipientPredicateRef.toAddress();

  const myPredicateRef = await UnmaskedPredicateReference.create(
    token.type, "secp256k1", signingService.publicKey, HashAlgorithm.SHA256,
  );
  const myAddress = await myPredicateRef.toAddress();

  // 2. Generate IDs and salts
  const recipientTokenId = new TokenId(crypto.getRandomValues(new Uint8Array(32)));
  const changeTokenId = new TokenId(crypto.getRandomValues(new Uint8Array(32)));
  const recipientSalt = crypto.getRandomValues(new Uint8Array(32));
  const changeSalt = crypto.getRandomValues(new Uint8Array(32));

  // 3. Build split
  const builder = new TokenSplitBuilder();
  builder.createToken(
    recipientTokenId, token.type, null,
    TokenCoinData.create([[coinIdObj, amount]]),
    recipientAddress, recipientSalt, null,
  );
  builder.createToken(
    changeTokenId, token.type, null,
    TokenCoinData.create([[coinIdObj, changeAmount]]),
    myAddress, changeSalt, null,
  );
  const split = await builder.build(token);

  // 4. Submit burn
  const burnSalt = crypto.getRandomValues(new Uint8Array(32));
  const burnCommitment = await split.createBurnCommitment(burnSalt, signingService);
  
  const burnResponse = await stateClient.submitTransferCommitment(burnCommitment);
  if (burnResponse.status !== SubmitCommitmentStatus.SUCCESS) {
    throw new Error(`Burn failed: ${burnResponse.status}`);
  }
  
  const burnProof = await waitInclusionProof(
    trustBase, stateClient, burnCommitment, AbortSignal.timeout(30000),
  );
  const burnTransaction = burnCommitment.toTransaction(burnProof);

  // 5. Submit mints
  const mintCommitments = await split.createSplitMintCommitments(trustBase, burnTransaction);
  const mintTransactions = [];

  for (const mintCommitment of mintCommitments) {
    const mintResponse = await stateClient.submitMintCommitment(mintCommitment);
    if (mintResponse.status !== SubmitCommitmentStatus.SUCCESS) {
      throw new Error(`Mint failed: ${mintResponse.status}`);
    }
    
    const mintProof = await waitInclusionProof(
      trustBase, stateClient, mintCommitment, AbortSignal.timeout(30000),
    );
    mintTransactions.push(mintCommitment.toTransaction(mintProof));
  }

  // 6. Create change token (index 1)
  const changePredicate = await UnmaskedPredicate.create(
    changeTokenId, token.type, signingService, HashAlgorithm.SHA256, changeSalt,
  );
  const changeToken = await Token.fromJSON({
    version: "2.0",
    state: new TokenState(changePredicate, null).toJSON(),
    genesis: mintTransactions[1].toJSON(),
    transactions: [],
    nametags: [],
  });

  // 7. Prepare recipient payload (index 0)
  const recipientPayload = {
    tokenJson: JSON.stringify(mintTransactions[0].toJSON()),
    transactionJson: JSON.stringify({ type: "split_mint" }),
    salt: Array.from(recipientSalt),
    amount: amount.toString(),
    coinId,
  };

  return { changeToken, recipientPayload };
}
```

---

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `REQUEST_ID_EXISTS` | Token has pending commitment | Wait or use different token |
| `INSUFFICIENT_BALANCE` | Token balance < amount | Check balance before splitting |
| Verification failed | Salt mismatch | Ensure same salt is used for address derivation and predicate creation |
| Inclusion proof timeout | Network issues | Increase timeout, implement retry logic |
| `Invalid token state` | Wrong nonce stored | Use the salt from the original mint/transfer |

---

## Testing Tips

1. **Start with small amounts** - Test with minimal balances first
2. **Log all salts** - Debug salt mismatches by logging at each step
3. **Verify immediately** - Call `token.verify(trustBase)` after creating tokens
4. **Use testnet** - Never test splitting logic on mainnet first
5. **Test both sides** - Verify both sender keeps change AND recipient receives token

---

## See Also

- [Unicity State Transition SDK](https://github.com/unicitylabs/state-transition-sdk)
- [Alphalite Wallet Library](./ALPHALITE.md) - Simplified wallet API (splitting not yet implemented)

---

*This guide is based on production implementation in [bounty-net](https://github.com/unicitylabs/bounty-net). Contributions and corrections welcome.*
