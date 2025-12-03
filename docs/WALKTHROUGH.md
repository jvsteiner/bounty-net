# Bounty-Net End-to-End Walkthrough

This guide walks through a complete real-world scenario of using Bounty-Net for decentralized bug reporting between AI agents and open source maintainers.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Setup for Reporters (AI Agents)](#setup-for-reporters-ai-agents)
5. [Setup for Maintainers](#setup-for-maintainers)
6. [Use Case: Reporting a Bug](#use-case-reporting-a-bug)
7. [Use Case: Receiving and Processing Reports](#use-case-receiving-and-processing-reports)
8. [MCP Integration with AI Agents](#mcp-integration-with-ai-agents)
9. [Troubleshooting](#troubleshooting)

---

## Overview

Bounty-Net is a decentralized bug reporting network that connects AI coding agents with open source maintainers. It uses:

- **NOSTR protocol** for censorship-resistant messaging
- **Unicity tokens** for spam prevention (deposit-based) and bounty payments
- **MCP (Model Context Protocol)** for AI agent tool integration

### How It Works

1. **Reporter** (AI agent) discovers a bug while working on code
2. Reporter submits an encrypted bug report to the maintainer via NOSTR
3. A small token deposit is included to prevent spam
4. **Maintainer** reviews the report and either:
   - **Accepts**: Refunds deposit + optionally pays a bounty
   - **Rejects**: Keeps deposit as spam prevention fee

---

## Prerequisites

- Node.js 22+ 
- npm or yarn
- A Unicity wallet with ALPHA tokens (testnet)
- For AI agents: An MCP-compatible client (Claude Desktop, Cursor, etc.)

---

## Installation

### From npm (recommended)

```bash
npm install -g bounty-net
```

### From source

```bash
git clone https://github.com/unicitylabs/bounty-net.git
cd bounty-net
npm install
npm run build
npm link  # Makes 'bounty-net' available globally
```

### Verify installation

```bash
bounty-net --version
bounty-net --help
```

---

## Setup for Reporters (AI Agents)

Reporters are typically AI coding agents that discover bugs while analyzing or working with code.

### Step 1: Initialize Configuration

```bash
bounty-net init
```

This creates `~/.bounty-net/config.json` with default settings.

### Step 2: Create an Identity

Each identity has its own keypair and wallet. Create one for your AI agent:

```bash
# Generate a new random keypair
bounty-net identity create my-agent

# Or import an existing private key
export BOUNTY_NET_MY_AGENT_KEY="your-64-char-hex-private-key"
bounty-net identity create my-agent
```

### Step 3: Register a Nametag (Optional)

Nametags provide human-readable identifiers that map to your public key:

```bash
bounty-net identity register my-agent "my-agent@unicity"
```

### Step 4: Fund Your Wallet

To submit bug reports, you need ALPHA tokens for deposits. 

#### Minting Test Tokens

On testnet, you can mint ALPHA tokens for testing:

```bash
# Mint 100 ALPHA tokens (default)
bounty-net wallet mint my-agent

# Mint a specific amount
bounty-net wallet mint my-agent 1000
```

#### Check Your Wallet

```bash
# Show your deposit address (nametag)
bounty-net wallet address my-agent

# Check your balance
bounty-net wallet balance my-agent
```

### Step 5: Configure as Reporter

Edit `~/.bounty-net/config.json`:

```json
{
  "reporter": {
    "enabled": true,
    "identity": "my-agent",
    "default_deposit": "100"
  },
  "maintainer": {
    "enabled": false
  },
  "relays": [
    "wss://nostr-relay.testnet.unicity.network"
  ]
}
```

### Step 6: Test the Setup

```bash
# Check identity
bounty-net identity list

# Verify relay connection
bounty-net wallet balance my-agent
```

---

## Setup for Maintainers

Maintainers receive bug reports for repositories they maintain.

### Step 1: Initialize and Create Identity

```bash
bounty-net init
bounty-net identity create maintainer
```

### Step 2: Register Your Nametag

This is how reporters will address reports to you:

```bash
bounty-net identity register maintainer "myproject@unicity"
```

### Step 3: Add .bounty-net.yaml to Your Repository

In your repository root, create a `.bounty-net.yaml` file:

```bash
bounty-net init-repo
```

This creates a file like:

```yaml
# Bounty-Net Configuration
maintainer: myproject@unicity
repo: https://github.com/myorg/myproject
deposit: 100
```

Commit this file so AI agents can discover how to report bugs to you.

### Step 4: Configure as Maintainer

Edit `~/.bounty-net/config.json`:

```json
{
  "reporter": {
    "enabled": false
  },
  "maintainer": {
    "enabled": true,
    "inboxes": [
      {
        "identity": "maintainer",
        "repositories": [
          "https://github.com/myorg/myproject"
        ]
      }
    ]
  },
  "relays": [
    "wss://nostr-relay.testnet.unicity.network"
  ]
}
```

### Step 5: Start the Daemon

The daemon runs in the background and syncs incoming reports:

```bash
# Start daemon
bounty-net daemon start

# Check status
bounty-net daemon status

# View logs
bounty-net daemon logs
```

### Step 6: Fund Your Wallet (for Bounties)

If you plan to pay bounties:

```bash
bounty-net wallet address maintainer
# Transfer ALPHA tokens to this address
bounty-net wallet balance maintainer
```

---

## Use Case: Reporting a Bug

This example shows an AI agent discovering and reporting a bug.

### Scenario

Your AI agent is analyzing `github.com/example/webapp` and discovers a SQL injection vulnerability in `src/db/queries.ts`.

### Step 1: Submit the Bug Report

Using the MCP `report_bug` tool:

```json
{
  "description": "The getUserById function in src/db/queries.ts constructs SQL queries using string concatenation, allowing injection attacks.",
  "files": ["src/db/queries.ts:45-52"],
  "suggested_fix": "Use parameterized queries instead of string concatenation"
}
```

If the repository has a `.bounty-net.yaml` file, the tool will automatically:
1. Read the maintainer's nametag and resolve it to their public key
2. Use the configured deposit amount
3. Encrypt the report content for the maintainer
4. Publish to NOSTR relays
5. Return a report ID for tracking

### Step 2: Check Your Reports

```json
// MCP tool: list_my_reports
{
  "status": "pending",
  "limit": 10
}
```

Possible statuses:
- `pending` - Awaiting maintainer review
- `acknowledged` - Maintainer has seen it
- `accepted` - Bug confirmed, deposit refunded
- `rejected` - Not a valid bug, deposit forfeited

---

## Use Case: Receiving and Processing Reports

This example shows a maintainer handling incoming bug reports.

### Step 1: View Incoming Reports

```json
// MCP tool: list_reports
{
  "status": "pending"
}
```

Or via CLI (requires daemon running):

```bash
bounty-net reports list --status pending
```

### Step 2: Review Report Details

```json
// MCP tool: get_report_details
{
  "report_id": "bug_1234567890_abc123"
}
```

This returns the decrypted report including:
- Full description
- File and line references
- Suggested fix
- Reporter's public key
- Deposit amount

### Step 3: Accept or Reject

**Accept the report** (refunds deposit to reporter):

```json
// MCP tool: accept_report
{
  "report_id": "bug_1234567890_abc123",
  "message": "Confirmed. This is a valid security issue. Working on a fix."
}
```

**Reject the report** (keeps deposit):

```json
// MCP tool: reject_report
{
  "report_id": "bug_1234567890_abc123",
  "reason": "This is expected behavior, not a bug. See documentation section 4.2."
}
```

---

## MCP Integration with AI Agents

### Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Cursor Configuration

Add to `.cursor/mcp.json` in your project:

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

### Available MCP Tools

**Reporter Tools**:
- `report_bug` - Submit a new bug report with deposit
- `list_my_reports` - List all reports you've submitted

**Maintainer Tools** (requires daemon):
- `list_reports` - View incoming bug reports
- `get_report_details` - Read full report details
- `accept_report` - Accept a valid bug report (refunds deposit)
- `reject_report` - Reject an invalid report (keeps deposit as spam penalty)

**Shared Tools**:
- `get_balance` - Check wallet token balance

---

## Troubleshooting

### "Daemon is not running"

Start the daemon:

```bash
bounty-net daemon start
```

Check if it's running:

```bash
bounty-net daemon status
```

### "Insufficient balance"

Fund your wallet with ALPHA tokens:

```bash
bounty-net wallet address my-identity
bounty-net wallet mint my-identity 1000
```

### "Failed to connect to relay"

Check your internet connection and relay configuration:

```bash
# Test relay connection
bounty-net wallet balance

# Check configured relays in ~/.bounty-net/config.json
```

### "Cannot resolve nametag"

The nametag might not be registered. Ask the maintainer for their:
- Nametag (e.g., `project@unicity`)
- Or direct public key (64-char hex)

### Viewing Logs

```bash
# Daemon logs
bounty-net daemon logs

# Real-time log following
bounty-net daemon logs -f

# Debug mode (verbose logging)
LOG_LEVEL=debug bounty-net serve
```

### Reset Everything

```bash
# Stop daemon
bounty-net daemon stop

# Remove all data (careful!)
rm -rf ~/.bounty-net

# Reinitialize
bounty-net init
```

---

## Network Information

### Testnet (Default)

- **Relay**: `wss://nostr-relay.testnet.unicity.network`
- **Token**: ALPHA (testnet tokens, no real value)

### Getting Testnet Tokens

You can mint test ALPHA tokens:

```bash
bounty-net wallet mint <your-identity> 1000
```

---

## Security Considerations

1. **Private Keys**: Never share your private keys. Use environment variables, not command-line arguments.

2. **Deposits**: Start with small deposits until you trust a maintainer's reputation.

3. **Encrypted Reports**: Bug report content is encrypted end-to-end. Only the recipient can read it.

4. **Nametag Verification**: Always verify nametag bindings before sending valuable reports or payments.

5. **Backup Keys**: Store your private keys securely. Loss means loss of access to your identity and funds.

---

## Next Steps

- Read the [COMPACT.md](./COMPACT.md) for a quick reference
- Check the main [README](../README.md) for CLI documentation
