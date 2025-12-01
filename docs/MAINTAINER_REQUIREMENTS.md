# Maintainer Requirements Protocol

This document describes how maintainers publish their deposit requirements and how reporters discover them before submitting bug reports.

## Overview

Before submitting a bug report, reporters need to know:
- What deposit is required?
- What repositories does this maintainer accept reports for?
- What bounty range can they expect?

Maintainers publish this information as NOSTR metadata that reporters query before sending reports.

## NOSTR Event Structure

### Maintainer Requirements Event (Kind 30078)

Maintainers publish a replaceable parameterized event (kind 30078) containing their bounty-net requirements:

```json
{
  "kind": 30078,
  "pubkey": "<maintainer-pubkey>",
  "created_at": 1234567890,
  "tags": [
    ["d", "bounty-net-requirements"],
    ["r", "github.com/example/webapp"],
    ["r", "github.com/example/another-repo"]
  ],
  "content": "{\"min_deposit\":500,\"bounty_range\":{\"min\":1000,\"max\":10000},\"categories\":[\"security\",\"bug\",\"performance\"],\"auto_refund\":false}",
  "sig": "<signature>"
}
```

### Content Schema

```typescript
interface MaintainerRequirements {
  // Minimum deposit required (in smallest token unit)
  min_deposit: number;
  
  // Bounty range the maintainer typically pays
  bounty_range?: {
    min: number;
    max: number;
  };
  
  // Categories of reports accepted
  categories?: string[];
  
  // Whether deposits are auto-refunded for valid reports
  auto_refund?: boolean;
  
  // Optional message to reporters
  message?: string;
  
  // Preferred severity levels
  severities?: ('critical' | 'high' | 'medium' | 'low')[];
}
```

### Tags

| Tag | Description |
|-----|-------------|
| `d` | Fixed identifier: `bounty-net-requirements` |
| `r` | Repository URL (can have multiple) |

## Reporter Flow

### Step 1: Query Maintainer Requirements

Before submitting a report, the reporter queries the maintainer's requirements:

```bash
# CLI
bounty-net maintainer info webapp-team@unicity

# Output:
Maintainer: webapp-team@unicity
Pubkey: abc123...
Repositories:
  - github.com/example/webapp
  - github.com/example/another-repo
Required deposit: 500 ALPHA
Bounty range: 1000-10000 ALPHA
Categories: security, bug, performance
```

### Step 2: Decide Whether to Proceed

The reporter (or AI agent) can now make an informed decision:
- Do I have enough tokens for the deposit?
- Is the potential bounty worth it?
- Does this maintainer accept my category of report?

### Step 3: Submit with Correct Deposit

```typescript
// MCP tool call
{
  "tool": "report_bug",
  "args": {
    "maintainer": "webapp-team@unicity",
    "repo_url": "github.com/example/webapp",
    "description": "...",
    "deposit_amount": 500  // Matches maintainer's requirement
  }
}
```

## Maintainer Flow

### Publishing Requirements

```bash
# Set requirements for your repositories
bounty-net maintainer set-requirements \
  --min-deposit 500 \
  --bounty-min 1000 \
  --bounty-max 10000 \
  --repos "github.com/example/webapp,github.com/example/other"

# View current published requirements
bounty-net maintainer show-requirements
```

### Updating Requirements

Requirements are replaceable events. Publishing new requirements overwrites the old ones:

```bash
# Increase deposit requirement
bounty-net maintainer set-requirements --min-deposit 1000
```

## MCP Tools

### For Reporters

```typescript
// get_maintainer_requirements - Query before submitting
{
  "maintainer": "webapp-team@unicity"  // nametag or pubkey
}

// Returns:
{
  "pubkey": "abc123...",
  "nametag": "webapp-team@unicity",
  "min_deposit": 500,
  "bounty_range": { "min": 1000, "max": 10000 },
  "repositories": [
    "github.com/example/webapp",
    "github.com/example/another-repo"
  ],
  "categories": ["security", "bug", "performance"]
}
```

### For Maintainers

```typescript
// set_requirements - Publish requirements
{
  "min_deposit": 500,
  "bounty_min": 1000,
  "bounty_max": 10000,
  "repositories": ["github.com/example/webapp"],
  "categories": ["security", "bug"]
}
```

## Validation

### Reporter Side

Before sending a report, validate:

```typescript
// src/services/validation/deposit.ts

async function validateDepositForMaintainer(
  maintainerPubkey: string,
  depositAmount: number,
  client: NostrClient
): Promise<ValidationResult> {
  // Fetch maintainer requirements
  const requirements = await fetchMaintainerRequirements(maintainerPubkey, client);
  
  if (!requirements) {
    // No requirements published - use default
    return { valid: true, warning: "Maintainer has no published requirements" };
  }
  
  if (depositAmount < requirements.min_deposit) {
    return { 
      valid: false, 
      error: `Deposit ${depositAmount} is below minimum ${requirements.min_deposit}` 
    };
  }
  
  return { valid: true };
}
```

### Maintainer Side

When receiving a report, validate the deposit:

```typescript
// src/daemon/sync.ts

async function validateIncomingReport(
  report: IncomingReport,
  requirements: MaintainerRequirements
): Promise<boolean> {
  // Check deposit meets minimum
  if (report.deposit_amount < requirements.min_deposit) {
    logger.warn(`Report ${report.id} rejected: deposit ${report.deposit_amount} < ${requirements.min_deposit}`);
    // Could auto-reject or flag for review
    return false;
  }
  
  return true;
}
```

## Discovery

### Finding Maintainers by Repository

Reporters can search for maintainers by repository URL:

```bash
bounty-net maintainer find --repo github.com/example/webapp
```

This queries NOSTR for events with matching `r` tags.

### Maintainer Directory (Future)

A curated list of known maintainers could be published:
- Well-known relays host maintainer directories
- Projects can link to their bounty-net nametag in README
- Reputation system ranks maintainers

## Implementation Notes

### Preparing for Team Mode

The `requiresDeposit()` function should check requirements:

```typescript
async function requiresDeposit(
  senderPubkey: string, 
  config: Config,
  requirements?: MaintainerRequirements
): Promise<{ required: boolean; amount: number }> {
  // TODO: Team Mode will add collaborator check here
  // if (isCollaborator(senderPubkey, config)) {
  //   return { required: false, amount: 0 };
  // }
  
  // Use maintainer's published requirements
  const minDeposit = requirements?.min_deposit ?? config.defaultDeposit;
  
  return { required: true, amount: minDeposit };
}
```

### Caching

Requirements don't change frequently. Cache them locally:
- Cache duration: 1 hour
- Invalidate on explicit refresh
- Store in SQLite alongside other data

### Fallback Behavior

If maintainer has no published requirements:
1. Reporter uses their configured `defaultDeposit`
2. Maintainer accepts any deposit amount
3. Warning shown to reporter: "No requirements published"

## Event Kinds

| Kind | Description | NIP |
|------|-------------|-----|
| 30078 | Parameterized replaceable event | NIP-33 |

Using kind 30078 because:
- Replaceable: new requirements overwrite old
- Parameterized: `d` tag identifies the specific data type
- Standard: follows NIP-33 conventions

## Security Considerations

1. **Signature verification**: Always verify event signatures
2. **Pubkey matching**: Ensure requirements come from the expected maintainer
3. **Relay trust**: Query multiple relays to avoid censorship
4. **Staleness**: Check `created_at` to detect outdated requirements

## Summary

The requirements protocol enables:

1. **Transparency**: Reporters know costs upfront
2. **Flexibility**: Maintainers set their own terms
3. **Automation**: AI agents can make informed decisions
4. **Decentralization**: No central registry needed

Flow:
```
Maintainer publishes requirements → NOSTR relays
Reporter queries requirements → Gets min_deposit, bounty range
Reporter decides → Submits with correct deposit or skips
Maintainer validates → Accepts or rejects based on published rules
```
