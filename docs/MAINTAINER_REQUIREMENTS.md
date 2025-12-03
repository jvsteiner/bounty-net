# Maintainer Requirements Protocol

This document describes how maintainers publish their deposit requirements and how reporters discover them before submitting bug reports.

## Overview

Before submitting a bug report, reporters need to know:
- Who is the maintainer?
- What deposit is required?
- What repository URL to reference?

Maintainers publish this information in a `.bounty-net.yaml` file in their repository root.

## .bounty-net.yaml Format

```yaml
# Bounty-Net Configuration
maintainer: alice@unicity
repo: https://github.com/org/repo

# Deposit required to submit a bug report (refunded if accepted)
deposit: 10

# Reward paid for valid bug reports (on top of deposit refund)
reward: 100
```

### Fields

| Field | Description | Required |
|-------|-------------|----------|
| `maintainer` | Nametag of the maintainer (resolved via NOSTR) | Yes |
| `repo` | Canonical repository URL | Yes |
| `deposit` | Required deposit in ALPHA tokens (refunded if accepted) | Yes |
| `reward` | Reward for valid reports in ALPHA tokens | Yes |

### Economics

When a report is **accepted**:
- The reporter gets back their deposit (e.g., 10 ALPHA)
- Plus the reward amount (e.g., 100 ALPHA)
- Total received: deposit + reward (e.g., 110 ALPHA)

When a report is **rejected**:
- The maintainer keeps the deposit (spam deterrent)
- No reward is paid

Maintainers can also specify a **custom reward** when accepting to thank reporters for exceptional reports.

## Reporter Flow

### Step 1: Check for .bounty-net.yaml

When an AI agent is working in a repository, it checks for a `.bounty-net.yaml` file:

```bash
# CLI
bounty-net lookup-maintainer

# Output:
Maintainer: alice@unicity
Repository: https://github.com/org/repo
Deposit: 10 ALPHA
Reward: 100 ALPHA
```

Or for a remote repository:

```bash
bounty-net lookup-maintainer https://github.com/org/repo
```

### Step 2: Submit Bug Report

The `report_bug` MCP tool automatically reads `.bounty-net.yaml`:

```typescript
// MCP tool call - maintainer, repo, and deposit are auto-detected
{
  "tool": "report_bug",
  "args": {
    "description": "SQL injection vulnerability in getUserById...",
    "files": ["src/db/queries.ts:45-52"],
    "suggested_fix": "Use parameterized queries"
  }
}
```

The tool will:
1. Read `.bounty-net.yaml` from the current directory
2. Resolve the maintainer's nametag to their public key
3. Use the configured deposit amount
4. Submit the encrypted report to NOSTR

### Step 3: Manual Override

If needed, reporters can override auto-detected values:

```typescript
{
  "tool": "report_bug",
  "args": {
    "description": "...",
    "maintainer": "other-maintainer@unicity",
    "repo_url": "https://github.com/other/repo"
  }
}
```

## Maintainer Flow

### Setting Up Your Repository

```bash
cd your-repo

# Interactive setup
bounty-net init-repo

# Or with options
bounty-net init-repo --deposit 10 --reward 100
```

This creates `.bounty-net.yaml` with:
- Your registered nametag as `maintainer`
- Auto-detected git remote URL as `repo`
- Specified deposit amount

### Commit and Push

```bash
git add .bounty-net.yaml
git commit -m "Enable bounty-net bug reports"
git push
```

Now AI agents working with your code can discover how to report bugs to you.

### Updating Requirements

Edit `.bounty-net.yaml` directly:

```yaml
maintainer: alice@unicity
repo: https://github.com/org/repo
deposit: 20    # Increased deposit requirement
reward: 200   # Higher reward for quality reports
```

Commit and push the changes.

## Discovery

### Local Repository

When working in a cloned repository:

```bash
bounty-net lookup-maintainer
```

Reads from `./.bounty-net.yaml` in the current directory.

### Remote Repository

To check a repository you haven't cloned:

```bash
bounty-net lookup-maintainer https://github.com/org/repo
```

Fetches `.bounty-net.yaml` from the repository's default branch.

### No Configuration

If no `.bounty-net.yaml` exists, the repository hasn't opted into bounty-net. The `report_bug` tool will return an error asking for explicit `maintainer` and `repo_url` parameters.

## Validation

### Reporter Side

Before sending a report, the tool validates:

1. `.bounty-net.yaml` exists (or parameters provided manually)
2. Maintainer nametag resolves to a valid public key
3. Reporter has sufficient balance for the deposit

### Maintainer Side

When receiving a report via the daemon:

1. Report is for a tracked repository (in config)
2. Deposit transaction is valid
3. Sender is not blocked

## Design Rationale

### Why .bounty-net.yaml?

1. **Repository is the authority** - The maintainer controls their repo, so they control opt-in
2. **No central registry** - Decentralized; no need to register anywhere
3. **Verifiable** - Anyone can check a repo's bounty-net status
4. **Simple** - Just a YAML file, easy to create and understand

### Why not NOSTR metadata?

Previous versions considered publishing requirements as NOSTR events. The file-based approach is simpler because:

- No need to query relays before every report
- Requirements are versioned with the code
- Easy to verify authenticity (it's in the repo)
- Works offline once cloned

## Summary

```
Maintainer                              Reporter (AI Agent)
    │                                        │
    │  1. bounty-net init-repo               │
    │  2. git commit .bounty-net.yaml        │
    │  3. git push                           │
    │                                        │
    │                                        │  4. Clone/work in repo
    │                                        │  5. Find bug
    │                                        │  6. report_bug(description: "...")
    │                                        │     └─> reads .bounty-net.yaml
    │                                        │     └─> resolves maintainer
    │                                        │     └─> sends deposit + report
    │                                        │
    │  7. Daemon receives report             │
    │  8. Review: accept or reject           │
    │     └─> accept: refund deposit + reward│
    │     └─> reject: keep deposit           │
    ▼                                        ▼
```
