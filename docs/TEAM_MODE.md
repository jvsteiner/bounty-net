# Team Mode: Collaborator-Based Workflows

This document describes the **Team Mode** extension to Bounty-Net, enabling trusted collaborators to exchange messages without payment requirements.

## Overview

The default Bounty-Net model requires deposits for spam prevention - essential for public projects receiving reports from unknown parties. However, for trusted teams, this creates unnecessary friction.

**Team Mode** introduces **collaborators**: trusted identities that bypass deposit requirements, enabling Bounty-Net to function as a lightweight, encrypted, decentralized issue/task system for remote teams.

## Use Cases

### Small Teams
- Distributed development teams exchanging bug reports and tasks
- No payment infrastructure needed
- Encrypted, censorship-resistant communication

### Open Source with Core Contributors
- Core team members as collaborators (no deposits)
- External contributors still require deposits
- Bounties optional for both groups

### Hybrid Organizations
- Internal teams use collaborator mode
- External bug bounty program uses payment mode
- Same tool, same workflow, different trust levels

## Trust Spectrum

```
Full Trust (Team)          Partial Trust              Zero Trust (Public)
├─────────────────────────────┼─────────────────────────────┤
No deposits                 Reduced deposits           Full deposits
No bounties                 Optional bounties          Bounties expected
Collaborators only          Collaborators + verified   Anyone can submit
Fast, informal              Semi-formal                Formal process
```

## Configuration

### Basic Collaborator Setup

```json
{
  "maintainer": {
    "enabled": true,
    "identity": "jamie",
    "collaborators": [
      {
        "name": "alice",
        "nametag": "alice@unicity",
        "pubkey": "a1b2c3d4..."
      },
      {
        "name": "bob",
        "nametag": "bob@unicity",
        "pubkey": "e5f6g7h8..."
      }
    ],
    "deposit_policy": "strangers_only"
  }
}
```

### Deposit Policies

| Policy | Behavior |
|--------|----------|
| `always` | All reports require deposits (current default) |
| `strangers_only` | Collaborators exempt, others require deposit |
| `never` | No deposits required (fully open, use with caution) |

### Team-Based Configuration

For larger organizations with multiple trust levels:

```json
{
  "maintainer": {
    "enabled": true,
    "identity": "jamie",
    "teams": {
      "core": {
        "members": ["alice", "bob", "charlie"],
        "deposit_required": false,
        "can_assign_tasks": true
      },
      "contractors": {
        "members": ["dave", "eve"],
        "deposit_required": false,
        "can_assign_tasks": false
      },
      "community": {
        "members": [],
        "deposit_required": true,
        "reduced_deposit": "50%"
      }
    }
  }
}
```

## CLI Commands

### Managing Collaborators

```bash
# Add a collaborator by nametag (resolves pubkey automatically)
bounty-net collaborator add alice --nametag alice@unicity

# Add a collaborator by pubkey directly
bounty-net collaborator add alice --pubkey a1b2c3d4...

# List all collaborators
bounty-net collaborator list

# Show collaborator details
bounty-net collaborator show alice

# Remove a collaborator
bounty-net collaborator remove alice
```

### Invitation Flow

For easier onboarding, collaborators can exchange signed invites:

```bash
# Generate an invite token
bounty-net collaborator invite alice
# Output: bnc1_invite_<signed-token>

# Share the token with Alice, who imports it
bounty-net collaborator accept bnc1_invite_<signed-token>
# This adds Jamie as Alice's collaborator and confirms the link
```

The invitation contains:
- Inviter's pubkey and nametag
- Invitee's expected name
- Signature proving authenticity
- Optional expiration time

### Team Management

```bash
# Create a team
bounty-net team create core-devs

# Add members to a team
bounty-net team add-member core-devs alice
bounty-net team add-member core-devs bob

# List teams
bounty-net team list

# List team members
bounty-net team show core-devs

# Remove a team
bounty-net team remove core-devs
```

## Message Flow

### Current Flow (Payment Mode)

```
Report arrives
    │
    ├── Check for deposit
    │       │
    │       ├── No deposit → Reject
    │       │
    │       └── Has deposit → Process report
    │
    └── End
```

### Extended Flow (Team Mode)

```
Report arrives
    │
    ├── Check sender pubkey
    │       │
    │       ├── Is collaborator? 
    │       │       │
    │       │       └── Yes → Process report (no deposit needed)
    │       │
    │       └── No → Check deposit policy
    │               │
    │               ├── Policy: "never" → Process report
    │               │
    │               ├── Policy: "strangers_only" → Check deposit
    │               │       │
    │               │       ├── Has deposit → Process report
    │               │       └── No deposit → Reject
    │               │
    │               └── Policy: "always" → Check deposit
    │                       │
    │                       ├── Has deposit → Process report
    │                       └── No deposit → Reject
    │
    └── End
```

## Extended Message Types

Teams often need more than bug reports. Team Mode introduces additional message types:

### Message Types

| Type | Description | Use Case |
|------|-------------|----------|
| `bug` | Something is broken | Standard bug report |
| `task` | Work assignment | Delegate work to team member |
| `question` | Request for clarification | Ask about code, design, etc. |
| `review` | Review request | PR review, code review |
| `note` | Informational | FYI, status updates |

### Sending Different Message Types

```bash
# CLI usage
bounty-net send task alice --title "Implement auth flow" --description "..."
bounty-net send question bob --title "How does X work?" --description "..."
bounty-net send review charlie --title "Review PR #123" --pr "github.com/org/repo/pull/123"
```

### MCP Tool Extensions

```json
// send_task - Assign work to a collaborator
{
  "recipient": "alice@unicity",
  "title": "Implement user authentication",
  "description": "Add OAuth2 login flow using...",
  "priority": "high",
  "due_date": "2025-02-15"
}

// send_question - Ask a collaborator
{
  "recipient": "bob@unicity", 
  "title": "How does the caching layer work?",
  "context": "I'm trying to understand..."
}

// request_review - Ask for code review
{
  "recipient": "charlie@unicity",
  "title": "Review authentication PR",
  "pr_url": "github.com/org/repo/pull/123",
  "description": "Added OAuth2 flow, please check security"
}
```

## Data Model Changes

### Collaborator Record

```typescript
interface Collaborator {
  name: string;           // Local friendly name
  nametag?: string;       // e.g., "alice@unicity"
  pubkey: string;         // Hex-encoded public key
  addedAt: Date;          // When added
  lastSeen?: Date;        // Last message received
  notes?: string;         // Optional notes about this person
  teams?: string[];       // Team memberships
}
```

### Extended Message Record

```typescript
interface Message {
  id: string;
  type: 'bug' | 'task' | 'question' | 'review' | 'note';
  from: string;           // Sender pubkey
  fromName?: string;      // Resolved collaborator name
  to: string;             // Recipient pubkey
  title: string;
  content: string;        // Encrypted content
  
  // Type-specific fields
  severity?: string;      // For bugs
  priority?: string;      // For tasks
  dueDate?: Date;         // For tasks
  prUrl?: string;         // For reviews
  
  // Metadata
  deposit?: string;       // Deposit amount (null for collaborators)
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
```

### Team Record

```typescript
interface Team {
  name: string;
  members: string[];      // Collaborator names
  depositRequired: boolean;
  permissions: {
    canAssignTasks: boolean;
    canApproveReports: boolean;
  };
}
```

## Security Considerations

### Trust Model

Collaborators are **fully trusted** to send messages without deposits. This means:

1. **Verify before adding**: Only add people you actually trust
2. **Pubkey verification**: Confirm the pubkey belongs to who you think it does
3. **Invitation signing**: Use the invite flow to cryptographically confirm identity

### Revoking Trust

If a collaborator's key is compromised or trust is lost:

```bash
bounty-net collaborator remove alice
```

Their future messages will require deposits like any stranger.

### No Retroactive Changes

Removing a collaborator doesn't affect past messages. If they sent spam while trusted, that spam remains in your database.

## Migration Path

### Existing Users

Team Mode is backwards compatible:

1. Default `deposit_policy` remains `always`
2. No collaborators configured by default
3. Existing workflows unchanged

### Enabling Team Mode

```bash
# Add your first collaborator
bounty-net collaborator add alice --nametag alice@unicity

# Update deposit policy
bounty-net config set maintainer.deposit_policy strangers_only
```

## Future Considerations

### Group/Channel Messaging

For team discussions, we could add:
- Shared channels (multiple recipients)
- Broadcast messages (one-to-many)
- Threaded conversations

### Presence/Status

- Show which collaborators are online
- Status messages ("focusing", "away", etc.)
- Read receipts

### Task Tracking

- Task states (todo, in_progress, done)
- Assignment and reassignment
- Due dates and reminders
- Integration with external issue trackers

### Federation

- Team directories shared across organizations
- Cross-team collaboration with partial trust
- Organization-level policies

## Implementation Notes

### Preparing for Team Mode During Initial Development

When implementing the core payment-based flow, structure the deposit validation logic to be easily extensible:

```typescript
// src/services/validation/deposit.ts

/**
 * Determines if a deposit is required for a given sender.
 * 
 * Currently always returns true (payment mode).
 * Team Mode will extend this to check collaborator status.
 */
function requiresDeposit(senderPubkey: string, config: Config): boolean {
  // TODO: Team Mode will add collaborator check here
  // if (isCollaborator(senderPubkey, config)) {
  //   return false;
  // }
  return true; // For now, always require deposit
}

/**
 * Validates that a report has sufficient deposit.
 * Call requiresDeposit() first to determine if this check is needed.
 */
function validateDeposit(report: Report, minDeposit: bigint): ValidationResult {
  // Deposit validation logic
}
```

**Key principle:** Keep the deposit check in its own function rather than inlining it throughout the codebase. When Team Mode is added, you change one function instead of hunting through multiple files.

### Implementation Order

1. **Phase 1: Payment Flow (Current)**
   - Get end-to-end payment flow working
   - Use `requiresDeposit()` function even though it always returns `true`
   - Validate deposits, process reports, handle refunds/bounties

2. **Phase 2: Team Mode (Future)**
   - Add collaborator storage to config
   - Implement `isCollaborator()` check
   - Update `requiresDeposit()` to check collaborators
   - Add CLI commands for collaborator management
   - Add extended message types

This approach ensures the trust layer sits cleanly on top of the payment layer without requiring architectural changes.

---

## Summary

Team Mode transforms Bounty-Net from a payment-focused bug bounty platform into a flexible collaboration tool:

| Feature | Public Mode | Team Mode |
|---------|-------------|-----------|
| Deposits | Required | Optional (per policy) |
| Bounties | Expected | Optional |
| Trust | Zero (verify via payment) | Pre-established (collaborators) |
| Message types | Bug reports | Bugs, tasks, questions, reviews |
| Use case | Open source projects | Teams, organizations |

Both modes coexist - use payments for external contributors, skip them for trusted teammates.
