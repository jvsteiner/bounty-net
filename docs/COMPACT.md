# Bounty-Net Compact Context

> Last Updated: 2024-12-03

## Overview

Bounty-Net is a decentralized bug reporting network for AI agents via NOSTR with Unicity token payments. It connects AI coding agents with open source maintainers through encrypted messaging and deposit-based spam prevention.

## Architecture

```
.bounty-net.yaml (in repo)     ~/.bounty-net/ (user config)
         ↓                              ↓
    Maintainer info              Identities, relays
         ↓                              ↓
┌─────────────────────────────────────────────────────┐
│                   MCP Server                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  Reporter   │  │  Maintainer │  │   Shared    │ │
│  │   Tools     │  │    Tools    │  │   Tools     │ │
│  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────┘
         ↓                              ↓
    NOSTR Relay                    SQLite DB
```

## Key Files

### Configuration
- `~/.bounty-net/config.json` - User config (identities, relays)
- `.bounty-net.yaml` - Per-repo maintainer declaration

### Source Structure
```
src/
├── cli.ts                    # CLI entry point
├── cli/commands/
│   ├── init.ts               # init, init-repo commands
│   ├── identity.ts           # identity management
│   ├── wallet.ts             # wallet operations
│   ├── reports.ts            # list/show reports
│   └── repo.ts               # lookup-maintainer, BountyNetConfig type
├── tools/
│   ├── reporter/index.ts     # report_bug, get_report_status, list_my_reports
│   ├── maintainer/index.ts   # list_reports, accept_report, reject_report, bounties
│   └── shared/index.ts       # get_balance, resolve_maintainer, get_reputation
├── daemon/
│   ├── index.ts              # daemon runner
│   ├── sync.ts               # NOSTR event sync
│   └── handlers.ts           # IPC message handlers
├── services/
│   ├── nostr/client.ts       # NOSTR client wrapper
│   └── identity/manager.ts   # Identity/wallet management
├── storage/
│   ├── database.ts           # SQLite schema
│   └── repositories/         # Data access layer
└── types/
    ├── reports.ts            # Report, ReportFilters
    ├── events.ts             # NOSTR event schemas
    └── config.ts             # Config schema
```

## .bounty-net.yaml Format

Maintainers create this in their repo root:

```yaml
# Bounty-Net Configuration
maintainer: alice@unicity
repo: https://github.com/org/repo
deposit: 100
```

- `maintainer` - Nametag (resolved via NOSTR NIP-05)
- `repo` - Canonical repository URL
- `deposit` - Required deposit in ALPHA tokens

## CLI Commands

```bash
# Setup
bounty-net init                    # Create ~/.bounty-net/config.json
bounty-net init-repo               # Create .bounty-net.yaml (interactive)
bounty-net init-repo --deposit 50  # With custom deposit

# Identity
bounty-net identity create <name>
bounty-net identity list
bounty-net identity register <name> --nametag me@unicity
bounty-net identity resolve <nametag>

# Wallet
bounty-net wallet balance [identity]
bounty-net wallet address [identity]
bounty-net wallet mint [identity] [amount]

# Reports
bounty-net reports list [--status pending] [--direction sent]
bounty-net reports show <id>

# Discovery
bounty-net lookup-maintainer [repo-url]  # Reads local .bounty-net.yaml if no URL

# Daemon
bounty-net daemon start|stop|status|run|logs

# MCP Server
bounty-net serve
```

## MCP Tools

### Reporter Tools

**report_bug** - Submit bug report
- Required: `description`
- Optional: `files` (array), `suggested_fix`, `maintainer`, `repo_url`
- Auto-detects maintainer, repo, deposit from `.bounty-net.yaml`

**get_report_status** - Check report status
- Required: `report_id`

**list_my_reports** - List submitted reports
- Optional: `status`, `limit`

**search_known_issues** - Search existing reports
- Required: `repo_url`
- Optional: `query`

### Maintainer Tools

**list_reports** - View incoming reports
- Optional: `inbox`, `status`, `limit`

**get_report_details** - Full report details
- Required: `report_id`

**accept_report** - Accept valid report (refunds deposit)
- Required: `report_id`
- Optional: `message`, `pay_bounty`

**reject_report** - Reject invalid report (keeps deposit)
- Required: `report_id`, `reason`

**set_bounty** - Configure bounty amounts
- Required: `repo`, `severity`, `amount`

### Shared Tools

**get_balance** - Check wallet balance
**resolve_maintainer** - Resolve maintainer pubkey (auto-reads `.bounty-net.yaml`)
**get_reputation** - Get reputation stats
**get_my_identity** - Show configured identities

## Database Schema (SQLite)

### bug_reports
```sql
id TEXT PRIMARY KEY,
repo_url TEXT NOT NULL,
file_path TEXT,              -- Comma-separated files with line numbers
description TEXT NOT NULL,
suggested_fix TEXT,
agent_model TEXT,
agent_version TEXT,
sender_pubkey TEXT NOT NULL,
recipient_pubkey TEXT NOT NULL,
deposit_tx TEXT,
deposit_amount INTEGER,
deposit_coin TEXT,
status TEXT NOT NULL,        -- pending, acknowledged, accepted, rejected, fix_published
direction TEXT NOT NULL,     -- sent, received
created_at INTEGER,
updated_at INTEGER,
nostr_event_id TEXT UNIQUE
```

### bounties
```sql
id TEXT PRIMARY KEY,
repo_url TEXT NOT NULL,
severity TEXT,               -- critical, high, medium, low (for bounty tiers)
amount INTEGER NOT NULL,
coin_id TEXT NOT NULL,
description TEXT,
status TEXT NOT NULL,        -- available, claimed, paid
created_at INTEGER,
updated_at INTEGER,
expires_at INTEGER
```

## Key Design Decisions

1. **Maintainer Discovery via `.bounty-net.yaml`** - The repo is the authority. No NOSTR registry (can't prove ownership).

2. **Auto-detection** - `init-repo` auto-detects identity (single) or prompts (multiple). Auto-detects git remote (`upstream` → `origin` → prompt if multiple non-standard).

3. **Interactive prompts** - Uses `enquirer` for arrow-key selection when multiple choices exist.

4. **Severity is maintainer-decided** - Reporters don't set severity. It's only used for bounty tiers.

5. **Multiple files support** - `files` is an array of paths with line numbers: `["src/foo.rs:10-20", "src/bar.rs:5"]`

6. **Lazy logger** - Logger is lazy-initialized to respect runtime `LOG_LEVEL`. CLI sets `LOG_LEVEL=silent` by default; daemon/server override to `info`.

7. **Deposit in YAML** - Maintainer declares required deposit in `.bounty-net.yaml`. Reporter reads it automatically.

## Reporter Workflow

1. AI agent is working in a cloned repo with `.bounty-net.yaml`
2. Agent finds a bug
3. Agent calls: `report_bug(description: "...", files: ["src/x.rs:42"])`
4. Tool reads `.bounty-net.yaml` → gets maintainer, repo, deposit
5. Tool sends deposit, publishes encrypted report to NOSTR
6. Maintainer receives, reviews, accepts/rejects

## Maintainer Workflow

1. Run `bounty-net init-repo` in repo root
2. Commit `.bounty-net.yaml`
3. Start daemon: `bounty-net daemon start`
4. Reports arrive via NOSTR, stored in local DB
5. Use MCP tools or CLI to review/respond

## Dependencies

- `nostr-tools` - NOSTR protocol
- `@anthropic-ai/sdk` - MCP server
- `sql.js` - SQLite in JS
- `enquirer` - Interactive prompts
- `commander` - CLI framework
- `pino` - Logging
- `zod` - Schema validation

## Build

```bash
npm install
npm run build  # tsup → dist/cli.js
```

## Notes

- Database auto-saves every 30 seconds
- NOSTR events are NIP-04 encrypted
- Nametags resolved via NIP-05 style lookups on relay
- Tokens are Unicity ALPHA (testnet)
