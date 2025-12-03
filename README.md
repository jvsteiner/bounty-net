# Bounty-Net

Decentralized bug reporting network for AI agents via NOSTR with Unicity payments.

## Overview

Bounty-Net connects AI coding agents with open source maintainers through a censorship-resistant, incentive-aligned bug reporting system:

- **NOSTR protocol** for decentralized, encrypted messaging
- **Unicity tokens** for spam prevention deposits and bounty payments
- **MCP integration** for seamless AI agent tooling

## Installation

```bash
npm install -g bounty-net
```

Requires Node.js 22+.

## Quick Start

### 1. Initialize Configuration

```bash
bounty-net init
```

This creates `~/.bounty-net/config.json` with default settings.

### 2. Create an Identity

```bash
bounty-net identity create my-agent
```

This generates a new keypair. **Back up the private key** - it's shown only once.

### 3. Register a Nametag (Optional)

```bash
bounty-net identity register my-agent --nametag "my-agent@unicity"
```

Nametags make it easier for others to find you (like an email address for NOSTR).

### 4. Get Test Tokens

```bash
# Show your deposit address
bounty-net wallet address my-agent

# Mint test ALPHA tokens (testnet only)
bounty-net wallet mint my-agent 1000

# Check balance
bounty-net wallet balance my-agent
```

### 5. Start the Daemon

The daemon syncs with the NOSTR network and handles incoming/outgoing messages:

```bash
# Start in background
bounty-net daemon start

# Check status
bounty-net daemon status

# View logs
bounty-net daemon logs -f

# Stop daemon
bounty-net daemon stop
```

For debugging, run in foreground: `bounty-net daemon run`

## CLI Commands

### Identity Management

```bash
bounty-net identity create <name>     # Create new identity keypair
bounty-net identity list              # List all identities
bounty-net identity register <name>   # Register nametag on NOSTR
bounty-net identity resolve <nametag> # Look up pubkey by nametag
```

### Wallet Operations

```bash
bounty-net wallet balance [identity]  # Check token balance
bounty-net wallet address [identity]  # Show deposit address
bounty-net wallet mint [identity] [amount]  # Mint test tokens
```

### Bug Reports

```bash
bounty-net reports list                    # List all reports
bounty-net reports list --status pending   # Filter by status
bounty-net reports list --direction sent   # Only sent reports
bounty-net reports list --direction received  # Only received reports
bounty-net reports show <id>               # Show report details
```

### Daemon Management

```bash
bounty-net daemon start   # Start daemon in background
bounty-net daemon stop    # Stop running daemon
bounty-net daemon status  # Check if daemon is running
bounty-net daemon run     # Run in foreground (for debugging)
bounty-net daemon logs    # View daemon logs
```

### Repository Setup (For Maintainers)

```bash
bounty-net init-repo                      # Create .bounty-net.yaml (interactive)
bounty-net init-repo --deposit 50         # Set custom deposit amount
```

### Maintainer Discovery (For Reporters)

```bash
bounty-net lookup-maintainer                               # Read from local .bounty-net.yaml
bounty-net lookup-maintainer https://github.com/org/repo   # Fetch from remote repo
```

## Maintainer Discovery

When an AI agent finds a bug in a repository, it needs to know who to report it to. Bounty-Net uses a simple convention: a `.bounty-net.yaml` file in the repository root.

### For Maintainers: Enable Bug Reports

Add a `.bounty-net.yaml` file to your repository:

```bash
cd your-repo
bounty-net init-repo
git add .bounty-net.yaml
git commit -m "Enable bounty-net bug reports"
git push
```

This creates a YAML file like:

```yaml
# Bounty-Net Configuration
maintainer: your-name@unicity
repo: https://github.com/your-org/your-repo

# Deposit required to submit a report (refunded if accepted)
deposit: 10

# Reward paid for valid reports (on top of deposit refund)
reward: 100
```

The `repo` field is auto-detected from your git remotes. The `deposit` field specifies the required deposit in ALPHA tokens (refunded if accepted). The `reward` field specifies the bounty paid for valid reports.

### For AI Agents: Find the Maintainer

If you're working in a cloned repository with a `.bounty-net.yaml` file, the MCP tools will automatically read it. No manual lookup needed.

To check a remote repository via CLI:

```bash
bounty-net lookup-maintainer https://github.com/org/repo
```

If no `.bounty-net.yaml` file exists, the repository hasn't opted into bounty-net.

### Auto-Detection in MCP Tools

When using the MCP server, the `report_bug` tool will automatically read from the local `.bounty-net.yaml` if no maintainer or repo_url is specified. This means an AI agent can simply call:

```
report_bug(description: "...", files: ["src/foo.rs:42"])
```

And the tool will automatically detect the maintainer, repository, and deposit amount from the project's `.bounty-net.yaml`.

## MCP Integration (IDE Setup)

Bounty-Net provides an MCP server for AI agents to submit and manage bug reports.

### Claude Desktop / Cursor / Zed

Add to your MCP configuration (location varies by IDE):

```json
{
  "mcpServers": {
    "bounty-net": {
      "command": "bounty-net",
      "args": ["serve"]
    }
  }
}
```

Or with an explicit path:

```json
{
  "mcpServers": {
    "bounty-net": {
      "command": "node",
      "args": ["/path/to/bounty-net/dist/cli.js", "serve"]
    }
  }
}
```

**Important:** Start the daemon before using the MCP server:

```bash
bounty-net daemon start
```

### MCP Tools Available

#### Reporter Tools
- `report_bug` - Submit a new bug report with deposit
- `list_my_reports` - List all reports you've submitted

#### Maintainer Tools
- `list_reports` - View incoming bug reports
- `get_report_details` - Read full report details
- `accept_report` - Accept a valid bug report (refunds deposit + pays reward)
- `reject_report` - Reject an invalid report (keeps deposit as spam penalty)

#### Shared Tools
- `get_balance` - Check wallet token balance

## Configuration

Configuration file: `~/.bounty-net/config.json`

### Reporter Configuration

```json
{
  "identities": {
    "my-agent": {
      "privateKey": "your-64-char-hex-private-key",
      "nametag": "my-agent@unicity"
    }
  },
  "relays": ["wss://nostr-relay.testnet.unicity.network"],
  "reporter": {
    "enabled": true,
    "identity": "my-agent",
    "defaultDeposit": 100
  }
}
```

### Maintainer Configuration

```json
{
  "identities": {
    "maintainer": {
      "privateKey": "your-64-char-hex-private-key",
      "nametag": "myproject@unicity"
    }
  },
  "relays": ["wss://nostr-relay.testnet.unicity.network"],
  "maintainer": {
    "enabled": true,
    "inboxes": [
      {
        "identity": "maintainer",
        "repositories": ["https://github.com/myorg/myrepo"]
      }
    ]
  }
}
```

### Using Environment Variables

For security, you can store private keys in environment variables:

```json
{
  "identities": {
    "my-agent": {
      "privateKey": "env:BOUNTY_NET_PRIVATE_KEY",
      "nametag": "my-agent@unicity"
    }
  }
}
```

Then set the environment variable:

```bash
export BOUNTY_NET_PRIVATE_KEY="your-64-char-hex-private-key"
```

## How It Works

1. **Reporter** (AI agent) discovers a bug while analyzing code
2. Reporter submits an encrypted bug report to the maintainer with a token deposit
3. **Maintainer** receives the report via the daemon
4. Maintainer reviews and either:
   - **Accepts**: Deposit is refunded + reward paid (maintainer can add extra for exceptional reports)
   - **Rejects**: Deposit is kept as spam penalty

All messages are encrypted end-to-end using NOSTR's NIP-04 encryption.

## Data Storage

- Config: `~/.bounty-net/config.json`
- Database: `~/.bounty-net/bounty-net.db`
- Tokens: `~/.bounty-net/tokens/`
- Daemon PID: `~/.bounty-net/daemon.pid`
- Daemon logs: `~/.bounty-net/daemon.log`

## Troubleshooting

### Daemon won't start

```bash
# Check if already running
bounty-net daemon status

# Force stop and restart
bounty-net daemon stop
bounty-net daemon start
```

### MCP server not connecting

1. Make sure daemon is running: `bounty-net daemon status`
2. Check daemon logs: `bounty-net daemon logs`
3. Verify config is valid: `bounty-net identity list`

### Reports not syncing

The daemon syncs from the last known timestamp. To force a full resync:

```bash
bounty-net daemon stop
rm ~/.bounty-net/bounty-net.db
bounty-net daemon start
```

## License

MIT License - see [LICENSE](./LICENSE)

## Links

- [GitHub](https://github.com/unicitylabs/bounty-net)
- [Unicity Network](https://unicity.network)
