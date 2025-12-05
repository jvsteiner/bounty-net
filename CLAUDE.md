# CLAUDE.md

> Bounty-Net: Decentralized Bug Reporting Network
> Version: 0.1.14

## Project Overview

Bounty-Net is a decentralized bug reporting network that connects AI coding agents with open-source maintainers through a censorship-resistant, incentive-aligned system. It uses:

- **NOSTR protocol** for decentralized, encrypted messaging
- **Unicity tokens** for spam prevention deposits and bounty payments
- **MCP integration** for seamless AI agent tooling in IDEs

## Tech Stack

| Category | Technology | Version |
|----------|------------|---------|
| Language | TypeScript | 5.7.2 |
| Runtime | Node.js | 22+ |
| Build | tsup | 8.3.5 |
| Database | SQLite (better-sqlite3) | 12.5.0 |
| CLI | Commander | 12.1.0 |
| Web Server | Express | 5.2.1 |
| Logging | Pino | 9.6.0 |
| Validation | Zod | 3.24.1 |
| Testing | Vitest | 2.1.8 |
| NOSTR | @unicitylabs/nostr-js-sdk | 0.2.0 |
| Tokens | @unicitylabs/state-transition-sdk | 1.6.0 |
| MCP | @modelcontextprotocol/sdk | 1.0.0 |

## Quick Reference

### Build & Run

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript to dist/
npm run dev          # Watch mode build
npm run start        # Run CLI (node dist/cli.js)
npm run serve        # Start MCP server
npm run daemon       # Run daemon in foreground
```

### Testing

```bash
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run typecheck    # Type check only
npm run lint         # ESLint
npm run format       # Prettier
```

### Key CLI Commands

```bash
bounty-net init                    # Initialize config
bounty-net identity create <name>  # Create identity keypair
bounty-net daemon start|stop|status
bounty-net wallet balance [identity]
bounty-net reports list
bounty-net serve                   # MCP server for IDEs
bounty-net ui                      # Web dashboard
```

## Architecture

### Three Application Modes

1. **CLI Mode** (`src/cli.ts`) - User-facing command interface
2. **Daemon Mode** (`src/daemon/`) - Background NOSTR sync and event processing
3. **MCP Server Mode** (`src/server/`) - IDE integration for AI agents

### Directory Structure

```
src/
├── cli.ts                    # CLI entry point
├── cli/commands/             # CLI command implementations
├── daemon/                   # Background daemon
│   ├── index.ts             # Daemon startup
│   ├── ipc-server.ts        # IPC for CLI communication
│   ├── handlers.ts          # Command handlers
│   └── sync.ts              # NOSTR event sync
├── server/                   # MCP server
│   ├── index.ts             # MCP server startup
│   ├── ipc-client.ts        # Daemon communication
│   └── backfill.ts          # Offline response handling
├── services/
│   ├── nostr/               # NOSTR protocol client
│   ├── wallet/              # Token wallet management
│   └── identity/            # Multi-identity system
├── storage/
│   ├── database.ts          # SQLite init & migrations
│   └── repositories/        # Data access layer
├── tools/                    # MCP tool implementations
│   ├── reporter/            # report_bug, list_my_reports
│   ├── maintainer/          # list_reports, accept/reject
│   └── shared/              # get_balance
├── types/                    # TypeScript types (Zod schemas)
├── constants/                # Paths, event kinds, coins
├── config/                   # Config loading
├── ui/                       # Express web dashboard
└── utils/                    # Logger, utilities
```

### Key Patterns

**Multi-Identity System**: Each user can have multiple identities with separate keypairs, nametags, and wallets. Identities are stored in `~/.bounty-net/config.json`.

**Role Separation**:
- **Reporter**: AI agents that submit bug reports (uses `report_bug` MCP tool)
- **Maintainer**: Project owners receiving reports (uses maintainer tools)

**Token Source of Truth**: Token files on disk (`~/.bounty-net/tokens/`) are the source of truth for payments, not the database.

**IPC Communication**: CLI and MCP server communicate with daemon via Unix socket (`~/.bounty-net/daemon.sock`).

## Data Storage

| Path | Purpose |
|------|---------|
| `~/.bounty-net/config.json` | Configuration |
| `~/.bounty-net/bounty-net.db` | SQLite database |
| `~/.bounty-net/tokens/` | Token files per identity |
| `~/.bounty-net/daemon.pid` | Daemon PID file |
| `~/.bounty-net/daemon.sock` | IPC socket |
| `~/.bounty-net/daemon.log` | Daemon logs |

## Database Schema

**Main Tables**:
- `bug_reports` - Bug reports with sender/recipient, status, NOSTR event ID
- `report_responses` - Responses (acknowledged/accepted/rejected/fix_published)
- `bounties` - Bounty announcements by maintainers
- `blocked_senders` - Spam prevention list
- `reputation` - Sender reputation metrics
- `sync_state` - Last sync timestamps, schema version

**Migrations**: Version-based system in `src/storage/database.ts`. Add new migrations to the end of the `migrations` array with incrementing version numbers.

## NOSTR Event Types

```typescript
enum EVENT_KINDS {
  BUG_REPORT = 31337,    // Encrypted bug report
  BUG_RESPONSE = 31338,  // Maintainer's response
  BOUNTY = 31339,        // Bounty announcement
}
```

## Configuration Schema

Configuration is validated with Zod (`src/types/config.ts`):

```typescript
{
  identities: Record<string, { privateKey: string, nametag?: string }>,
  relays: string[],
  aggregatorUrl: string,
  database: string,
  reporter: { enabled, identity, defaultDeposit, maxReportsPerHour },
  maintainer: { enabled, inboxes: [{ identity, repositories, depositRequirements }] },
  ui: { ideProtocol: 'zed' | 'vscode' | 'cursor' | 'jetbrains' }
}
```

Private keys can reference env vars: `"privateKey": "env:BOUNTY_NET_PRIVATE_KEY"`

## Code Style

- **Strict TypeScript**: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- **ESM Modules**: Use `.js` extensions in imports (e.g., `./foo.js`)
- **Path Aliases**: `@/*` maps to `./src/*`
- **Logging**: Use `createLogger(name)` from `src/utils/logger.ts`
- **Validation**: Use Zod for runtime validation of configs and event content

## Testing

- **Framework**: Vitest with globals enabled
- **Location**: `tests/unit/*.test.ts`
- **Database Tests**: Use in-memory SQLite (`:memory:`)
- **Coverage**: V8 provider configured

## MCP Tools

### Reporter Tools
- `report_bug` - Submit bug report with deposit
- `list_my_reports` - List submitted reports

### Maintainer Tools
- `list_reports` - View incoming reports
- `get_report_details` - Read full report
- `accept_report` - Accept (refunds deposit + pays reward)
- `reject_report` - Reject (keeps deposit as spam penalty)

### Shared Tools
- `get_balance` - Check wallet token balance

## Repository Configuration

Projects opt into bounty-net with `.bounty-net.yaml`:

```yaml
maintainer: name@unicity
repo: https://github.com/org/repo
deposit: 10    # Required deposit (refunded if accepted)
reward: 100    # Bounty for valid reports
```

## Development Workflow

1. Make changes in `src/`
2. Run `npm run build` (or `npm run dev` for watch mode)
3. Test with `npm test`
4. For daemon testing: `bounty-net daemon run` (foreground)
5. For MCP testing: Configure IDE to use `bounty-net serve`

## Important Notes

- Daemon must be running for MCP server to work
- Token operations require connection to Unicity aggregator
- All NOSTR messages are encrypted end-to-end (NIP-04)
- Database uses WAL mode for concurrent access

## Claude Code Instructions

- **Always use MCP tools for bounty-net operations** - Do not use curl or direct API calls. If the MCP server is disconnected, ask the user to reconnect it with `/mcp`. This ensures MCP integration issues are consistently surfaced and addressed.

- **NEVER run servers or daemons in background** - Do not use `run_in_background`, `&`, or any other method to start long-running processes. Background processes become stale and cause chaos when they run old code. If the user needs a server running, tell them to run it manually in a separate terminal.
