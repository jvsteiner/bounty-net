# Bounty-Net Implementation Plan

## Project Overview

Bounty-Net enables AI coding agents to participate in a decentralized bug reporting network via NOSTR, with Unicity token payments for spam prevention (deposits) and bounty rewards. Users can operate as reporters (submitting bugs), maintainers (receiving bugs), or both simultaneously.

### Architecture: Hybrid Daemon + MCP Server

The system consists of two main components:

1. **Daemon** (`bounty-net daemon`) - Long-running background process for maintainers
   - Subscribes to NOSTR relays for incoming bug reports
   - Writes to SQLite database
   - Handles background sync even when IDE is closed
   - Exposes IPC socket for commands from MCP server

2. **MCP Server** (`bounty-net serve`) - On-demand process spawned by IDE
   - Exposes tools to AI agents (report_bug, accept_report, etc.)
   - Reads from SQLite database
   - Sends write commands to daemon via IPC (if running)
   - Falls back to direct writes for reporter-only mode

```
┌─────────────────┐
│  NOSTR Relays   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────┐
│     Daemon      │────►│    SQLite    │
│  (always on)    │     │   Database   │
│  - subscriptions│     └──────┬───────┘
│  - sync         │            │
└────────┬────────┘            │ Read
         │ IPC Socket          │
         ▼                     ▼
┌─────────────────┐     ┌──────────────┐     ┌─────────────┐
│  ~/.bounty-net/ │◄────│  MCP Server  │◄───►│     IDE     │
│  daemon.sock    │     │  (on-demand) │     │ (Claude,etc)│
└─────────────────┘     └──────────────┘     └─────────────┘
```

**User Profiles:**
- **Reporter-only**: No daemon needed. MCP server catches up on responses via backfill on startup.
- **Maintainer**: Runs daemon to receive reports in real-time. MCP server reads from synced database.

---

## Project Structure

```
bounty-net/
├── src/
│   ├── cli.ts                    # CLI entry point
│   ├── daemon/
│   │   ├── index.ts              # Daemon entry point
│   │   ├── process.ts            # PID file, singleton management
│   │   ├── ipc-server.ts         # Unix socket server for commands
│   │   ├── sync.ts               # NOSTR subscription & sync logic
│   │   └── handlers.ts           # IPC command handlers
│   ├── server/
│   │   ├── index.ts              # MCP server entry point
│   │   ├── ipc-client.ts         # Connect to daemon socket
│   │   └── fallback.ts           # Direct DB writes when no daemon
│   ├── tools/
│   │   ├── reporter/
│   │   │   ├── report-bug.ts
│   │   │   ├── get-report-status.ts
│   │   │   ├── search-known-issues.ts
│   │   │   ├── claim-reward.ts
│   │   │   ├── list-my-reports.ts
│   │   │   └── index.ts
│   │   ├── maintainer/
│   │   │   ├── list-reports.ts
│   │   │   ├── get-report-details.ts
│   │   │   ├── accept-report.ts
│   │   │   ├── reject-report.ts
│   │   │   ├── publish-fix.ts
│   │   │   ├── set-bounty.ts
│   │   │   ├── list-bounties.ts
│   │   │   ├── block-sender.ts
│   │   │   └── index.ts
│   │   ├── shared/
│   │   │   ├── get-balance.ts
│   │   │   ├── resolve-maintainer.ts
│   │   │   ├── get-reputation.ts
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── services/
│   │   ├── identity/
│   │   │   ├── manager.ts        # Multi-identity management
│   │   │   └── index.ts
│   │   ├── nostr/
│   │   │   ├── client.ts         # NOSTR client wrapper
│   │   │   ├── events.ts         # Event builders/parsers
│   │   │   └── index.ts
│   │   ├── wallet/
│   │   │   ├── service.ts        # Unicity wallet operations
│   │   │   └── index.ts
│   │   ├── discovery/
│   │   │   ├── maintainer.ts     # Maintainer pubkey discovery
│   │   │   ├── nip05.ts          # NIP-05 resolver
│   │   │   └── index.ts
│   │   └── reputation/
│   │       ├── tracker.ts        # Reputation scoring
│   │       └── index.ts
│   ├── storage/
│   │   ├── database.ts           # SQLite setup (sql.js)
│   │   ├── migrations.ts         # Schema migrations
│   │   ├── repositories/
│   │   │   ├── reports.ts
│   │   │   ├── responses.ts
│   │   │   ├── bounties.ts
│   │   │   ├── transactions.ts
│   │   │   ├── reputation.ts
│   │   │   ├── blocked.ts
│   │   │   └── sync-state.ts
│   │   └── index.ts
│   ├── types/
│   │   ├── events.ts             # NOSTR event types
│   │   ├── reports.ts            # Bug report interfaces
│   │   ├── payments.ts           # Payment/bounty interfaces
│   │   ├── config.ts             # Configuration types
│   │   ├── ipc.ts                # IPC message types
│   │   └── index.ts
│   ├── constants/
│   │   ├── event-kinds.ts        # Custom NOSTR event kinds
│   │   ├── coins.ts              # Token IDs
│   │   ├── paths.ts              # File paths (~/.bounty-net/*)
│   │   └── index.ts
│   └── utils/
│       ├── crypto.ts             # Encryption helpers
│       ├── validation.ts         # Schema validation
│       ├── logger.ts             # Logging (pino)
│       └── index.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docs/
│   ├── idea.md
│   └── implementation-plan.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### File Paths

```typescript
// src/constants/paths.ts
import path from "path";
import os from "os";

const BASE_DIR = path.join(os.homedir(), ".bounty-net");

export const PATHS = {
  BASE_DIR,
  CONFIG: path.join(BASE_DIR, "config.json"),
  DATABASE: path.join(BASE_DIR, "bounty-net.db"),
  DAEMON_PID: path.join(BASE_DIR, "daemon.pid"),
  DAEMON_SOCKET: path.join(BASE_DIR, "daemon.sock"),
  DAEMON_LOG: path.join(BASE_DIR, "daemon.log"),
} as const;
```

---

## Phase 1: Foundation

### 1.1 Project Setup

**Tasks:**
1. Initialize Node.js project with TypeScript
2. Configure strict TypeScript with path aliases
3. Set up build pipeline (tsup for ESM output)
4. Add development tooling:
   - ESLint with TypeScript rules
   - Prettier for formatting
   - Vitest for testing
5. Create constants for event kinds and token IDs

**Dependencies:**
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "@unicitylabs/nostr-js-sdk": "latest",
    "@unicitylabs/state-transition-sdk": "latest",
    "sql.js": "^1.x",
    "zod": "^3.x",
    "uuid": "^10.x",
    "pino": "^9.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsup": "^8.x",
    "vitest": "^2.x",
    "@types/uuid": "^10.x",
    "eslint": "^9.x",
    "prettier": "^3.x"
  }
}
```

**Why sql.js:**
- Pure JavaScript (SQLite compiled to WebAssembly)
- No native compilation required - works on any platform without build tools
- Zero installation issues for users
- Same SQLite functionality, just runs in WASM
```

**Constants:**
```typescript
// src/constants/event-kinds.ts
export const EVENT_KINDS = {
  BUG_REPORT: 31337,
  BUG_RESPONSE: 31338,
  BOUNTY: 31339,
} as const;

// src/constants/coins.ts
export const COINS = {
  ALPHA: "414c504841",
} as const;

export const DEFAULT_RELAY = "wss://nostr-relay.testnet.unicity.network";
```

---

### 1.2 Type Definitions

**File: `src/types/events.ts`**

```typescript
import { z } from "zod";

// Severity levels
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

// Bug report content (encrypted in NOSTR event)
export const BugReportContentSchema = z.object({
  bug_id: z.string().uuid(),
  repo: z.string().url(),
  file: z.string().optional(),
  line_start: z.number().optional(),
  line_end: z.number().optional(),
  description: z.string().min(10).max(10000),
  suggested_fix: z.string().optional(),
  severity: SeveritySchema,
  category: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  agent_model: z.string().optional(),
  agent_version: z.string().optional(),
  deposit_tx: z.string().optional(),
  deposit_amount: z.string().optional(),
});
export type BugReportContent = z.infer<typeof BugReportContentSchema>;

// Bug response content
export const ResponseTypeSchema = z.enum([
  "acknowledge",
  "accept",
  "reject",
  "fix_published",
]);
export type ResponseType = z.infer<typeof ResponseTypeSchema>;

export const BugResponseContentSchema = z.object({
  report_id: z.string().uuid(),
  response_type: ResponseTypeSchema,
  message: z.string().optional(),
  commit_hash: z.string().optional(),
  bounty_paid: z.string().optional(),
});
export type BugResponseContent = z.infer<typeof BugResponseContentSchema>;

// Bounty announcement
export const BountySchema = z.object({
  bounty_id: z.string().uuid(),
  repo: z.string().url(),
  severity: SeveritySchema.optional(),
  amount: z.string(),
  coin_id: z.string(),
  description: z.string().optional(),
  expires_at: z.number().optional(),
});
export type Bounty = z.infer<typeof BountySchema>;
```

**File: `src/types/config.ts`**

```typescript
import { z } from "zod";

// Individual identity (keypair + nametag + wallet)
export const IdentitySchema = z.object({
  privateKey: z.string().min(64).max(64),
  nametag: z.string().optional(),
});

// Inbox configuration for a project
export const InboxSchema = z.object({
  identity: z.string(),  // Reference to identity name
  repositories: z.array(z.string()),
  bounties: z.record(z.string(), z.number()).default({}),  // severity -> amount
  depositRequirements: z.object({
    default: z.number().default(100),
    critical: z.number().optional(),
    high: z.number().optional(),
    medium: z.number().optional(),
    low: z.number().optional(),
  }).default({}),
});

export const ConfigSchema = z.object({
  // Multiple identities - each has its own keypair and wallet
  identities: z.record(z.string(), IdentitySchema),
  
  relays: z.array(z.string().url()).default([
    "wss://nostr-relay.testnet.unicity.network",
  ]),
  database: z.string().default("~/.bounty-net/bounty-net.db"),
  
  // Reporter config - uses one identity for outbound reports
  reporter: z.object({
    enabled: z.boolean().default(true),
    identity: z.string(),  // Which identity to use for reporting
    defaultDeposit: z.number().default(100),
    maxReportsPerHour: z.number().default(10),
  }).optional(),
  
  // Maintainer config - multiple inboxes, each with own identity
  maintainer: z.object({
    enabled: z.boolean().default(false),
    inboxes: z.array(InboxSchema).default([]),
  }).default({}),
});

export type Identity = z.infer<typeof IdentitySchema>;
export type Inbox = z.infer<typeof InboxSchema>;
export type Config = z.infer<typeof ConfigSchema>;
```

---

### 1.3 Database Layer

**File: `src/storage/database.ts`**

```typescript
import initSqlJs, { Database } from "sql.js";
import fs from "fs";
import path from "path";
import os from "os";

let SQL: initSqlJs.SqlJsStatic;

export async function initializeDatabase(dbPath: string): Promise<Database> {
  // Initialize sql.js WASM
  if (!SQL) {
    SQL = await initSqlJs();
  }
  
  const resolvedPath = dbPath.replace("~", os.homedir());
  const dir = path.dirname(resolvedPath);
  
  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });
  
  // Load existing database or create new one
  let db: Database;
  if (fs.existsSync(resolvedPath)) {
    const buffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Enable foreign keys
  db.run("PRAGMA foreign_keys = ON");
  
  // Run migrations
  runMigrations(db);
  
  return db;
}

// Persist database to disk
export function saveDatabase(db: Database, dbPath: string): void {
  const resolvedPath = dbPath.replace("~", os.homedir());
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(resolvedPath, buffer);
}

// Helper to wrap db operations and auto-save
export class DatabaseWrapper {
  constructor(
    private db: Database,
    private dbPath: string,
    private autoSaveInterval: number = 30000
  ) {
    // Auto-save periodically
    setInterval(() => this.save(), this.autoSaveInterval);
  }
  
  run(sql: string, params?: unknown[]): void {
    this.db.run(sql, params);
  }
  
  get<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row as T;
    }
    stmt.free();
    return undefined;
  }
  
  all<T>(sql: string, params?: unknown[]): T[] {
    const results: T[] = [];
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }
  
  save(): void {
    saveDatabase(this.db, this.dbPath);
  }
  
  close(): void {
    this.save();
    this.db.close();
  }
}
```

**Schema:**
```sql
-- Bug reports (sent and received)
CREATE TABLE IF NOT EXISTS bug_reports (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  description TEXT NOT NULL,
  suggested_fix TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  category TEXT,
  agent_model TEXT,
  agent_version TEXT,
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  deposit_tx TEXT,
  deposit_amount INTEGER,
  deposit_coin TEXT,
  status TEXT NOT NULL DEFAULT 'pending' 
    CHECK (status IN ('pending', 'acknowledged', 'accepted', 'rejected', 'fix_published')),
  direction TEXT NOT NULL CHECK (direction IN ('sent', 'received')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  nostr_event_id TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_reports_repo ON bug_reports(repo_url);
CREATE INDEX IF NOT EXISTS idx_reports_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_severity ON bug_reports(severity);
CREATE INDEX IF NOT EXISTS idx_reports_direction ON bug_reports(direction);
CREATE INDEX IF NOT EXISTS idx_reports_sender ON bug_reports(sender_pubkey);
CREATE INDEX IF NOT EXISTS idx_reports_recipient ON bug_reports(recipient_pubkey);

-- Report responses
CREATE TABLE IF NOT EXISTS report_responses (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES bug_reports(id),
  response_type TEXT NOT NULL 
    CHECK (response_type IN ('acknowledge', 'accept', 'reject', 'fix_published')),
  message TEXT,
  commit_hash TEXT,
  bounty_paid INTEGER,
  bounty_coin TEXT,
  responder_pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  nostr_event_id TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_responses_report ON report_responses(report_id);

-- Bounties (set by maintainer)
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  severity TEXT CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  amount INTEGER NOT NULL,
  coin_id TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'claimed', 'expired', 'cancelled')),
  created_by TEXT NOT NULL,
  claimed_by TEXT,
  claimed_report_id TEXT REFERENCES bug_reports(id),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  nostr_event_id TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_bounties_repo ON bounties(repo_url);
CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
CREATE INDEX IF NOT EXISTS idx_bounties_severity ON bounties(severity);

-- Transactions (deposits, refunds, bounty payments)
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  tx_hash TEXT,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'refund', 'bounty')),
  amount INTEGER NOT NULL,
  coin_id TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL,
  related_report_id TEXT REFERENCES bug_reports(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'failed')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tx_report ON transactions(related_report_id);
CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);

-- Blocked senders (maintainer feature)
CREATE TABLE IF NOT EXISTS blocked_senders (
  pubkey TEXT PRIMARY KEY,
  reason TEXT,
  blocked_at INTEGER NOT NULL
);

-- Reputation tracking
CREATE TABLE IF NOT EXISTS reputation (
  pubkey TEXT PRIMARY KEY,
  total_reports INTEGER NOT NULL DEFAULT 0,
  accepted_reports INTEGER NOT NULL DEFAULT 0,
  rejected_reports INTEGER NOT NULL DEFAULT 0,
  last_report_at INTEGER,
  deposit_tier TEXT NOT NULL DEFAULT 'standard'
    CHECK (deposit_tier IN ('standard', 'reduced', 'minimal', 'trusted'))
);

-- Sync state (for resuming subscriptions)
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Repository Classes:**

```typescript
// src/storage/repositories/reports.ts
export class ReportsRepository {
  constructor(private db: DatabaseWrapper) {}
  
  create(report: InsertReport): void {
    this.db.run(`
      INSERT INTO bug_reports (
        id, repo_url, file_path, line_start, line_end, description,
        suggested_fix, severity, category, agent_model, agent_version,
        sender_pubkey, recipient_pubkey, deposit_tx, deposit_amount,
        deposit_coin, status, direction, created_at, updated_at, nostr_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      report.id, report.repo_url, report.file_path, report.line_start,
      report.line_end, report.description, report.suggested_fix, report.severity,
      report.category, report.agent_model, report.agent_version, report.sender_pubkey,
      report.recipient_pubkey, report.deposit_tx, report.deposit_amount,
      report.deposit_coin, report.status, report.direction, report.created_at,
      report.updated_at, report.nostr_event_id
    ]);
  }
  
  findById(id: string): Report | undefined {
    return this.db.get<Report>("SELECT * FROM bug_reports WHERE id = ?", [id]);
  }
  
  findByEventId(eventId: string): Report | undefined {
    return this.db.get<Report>(
      "SELECT * FROM bug_reports WHERE nostr_event_id = ?",
      [eventId]
    );
  }
  
  listReceived(filters: ReportFilters): Report[] {
    let sql = "SELECT * FROM bug_reports WHERE direction = 'received'";
    const params: unknown[] = [];
    
    if (filters.status && filters.status !== "all") {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.severity && filters.severity !== "all") {
      sql += " AND severity = ?";
      params.push(filters.severity);
    }
    if (filters.repo) {
      sql += " AND repo_url LIKE ?";
      params.push(`%${filters.repo}%`);
    }
    
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(filters.limit ?? 50);
    params.push(filters.offset ?? 0);
    
    return this.db.all<Report>(sql, params);
  }
  
  listSent(filters: ReportFilters): Report[] {
    let sql = "SELECT * FROM bug_reports WHERE direction = 'sent'";
    const params: unknown[] = [];
    // Similar filter logic...
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(filters.limit ?? 50);
    params.push(filters.offset ?? 0);
    return this.db.all<Report>(sql, params);
  }
  
  updateStatus(id: string, status: string): void {
    this.db.run(
      "UPDATE bug_reports SET status = ?, updated_at = ? WHERE id = ?",
      [status, Date.now(), id]
    );
  }
  
  search(query: string, filters: ReportFilters): Report[] {
    return this.db.all<Report>(
      `SELECT * FROM bug_reports 
       WHERE description LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [`%${query}%`, filters.limit ?? 50]
    );
  }
}
```

---

### 1.4 NOSTR Client Service

**File: `src/services/nostr/client.ts`**

```typescript
import { NostrKeyManager, NostrClient, Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";
import { EVENT_KINDS } from "../../constants/event-kinds";
import type { BugReportContent, BugResponseContent } from "../../types/events";

export class BountyNetNostrClient {
  private keyManager: NostrKeyManager;
  private client: NostrClient;
  private subscriptions: Map<string, string> = new Map();
  
  constructor(privateKeyHex: string) {
    this.keyManager = NostrKeyManager.fromPrivateKeyHex(privateKeyHex);
    this.client = new NostrClient(this.keyManager);
  }
  
  async connect(relays: string[]): Promise<void> {
    await this.client.connect(...relays);
  }
  
  disconnect(): void {
    for (const subId of this.subscriptions.values()) {
      this.client.unsubscribe(subId);
    }
    this.subscriptions.clear();
    this.client.disconnect();
  }
  
  getPublicKey(): string {
    return this.keyManager.getPublicKeyHex();
  }
  
  // Nametag operations
  async registerNametag(nametag: string): Promise<boolean> {
    return this.client.publishNametagBinding(nametag, this.getPublicKey());
  }
  
  async resolveNametag(nametag: string): Promise<string | null> {
    return this.client.queryPubkeyByNametag(nametag);
  }
  
  // Bug report publishing (reporter role)
  async publishBugReport(
    content: BugReportContent,
    recipientPubkey: string
  ): Promise<string> {
    const encrypted = await this.keyManager.encryptHex(
      JSON.stringify(content),
      recipientPubkey
    );
    
    // Build custom event with tags
    const tags = [
      ["d", content.bug_id],
      ["repo", content.repo],
      ["severity", content.severity],
      ["p", recipientPubkey],
    ];
    
    if (content.file) {
      tags.push(["file", content.file, content.line_start?.toString() ?? ""]);
    }
    if (content.category) {
      tags.push(["category", content.category]);
    }
    if (content.agent_model) {
      tags.push(["agent", content.agent_model, content.agent_version ?? ""]);
    }
    if (content.deposit_tx) {
      tags.push(["deposit", content.deposit_tx]);
      tags.push(["deposit_amount", content.deposit_amount ?? "0"]);
    }
    
    return this.client.publishEvent({
      kind: EVENT_KINDS.BUG_REPORT,
      tags,
      content: encrypted,
    });
  }
  
  // Bug response publishing (maintainer role)
  async publishBugResponse(
    content: BugResponseContent,
    recipientPubkey: string,
    originalEventId: string
  ): Promise<string> {
    const encrypted = await this.keyManager.encryptHex(
      JSON.stringify(content),
      recipientPubkey
    );
    
    const tags = [
      ["d", crypto.randomUUID()],
      ["e", originalEventId],
      ["report_id", content.report_id],
      ["response_type", content.response_type],
      ["p", recipientPubkey],
    ];
    
    if (content.commit_hash) {
      tags.push(["commit", content.commit_hash]);
    }
    if (content.bounty_paid) {
      tags.push(["bounty_paid", content.bounty_paid]);
    }
    
    return this.client.publishEvent({
      kind: EVENT_KINDS.BUG_RESPONSE,
      tags,
      content: encrypted,
    });
  }
  
  // Subscribe to incoming bug reports (maintainer role)
  subscribeToReports(
    since: number,
    onReport: (event: NostrEvent, content: BugReportContent) => void
  ): string {
    const filter = Filter.builder()
      .kinds(EVENT_KINDS.BUG_REPORT)
      .pTags(this.getPublicKey())
      .since(since)
      .build();
    
    const subId = this.client.subscribe(filter, {
      onEvent: async (event) => {
        try {
          const decrypted = await this.keyManager.decryptHex(
            event.content,
            event.pubkey
          );
          const content = JSON.parse(decrypted) as BugReportContent;
          onReport(event, content);
        } catch (error) {
          console.error("Failed to decrypt bug report:", error);
        }
      },
    });
    
    this.subscriptions.set("reports", subId);
    return subId;
  }
  
  // Subscribe to responses for sent reports (reporter role)
  subscribeToResponses(
    since: number,
    onResponse: (event: NostrEvent, content: BugResponseContent) => void
  ): string {
    const filter = Filter.builder()
      .kinds(EVENT_KINDS.BUG_RESPONSE)
      .pTags(this.getPublicKey())
      .since(since)
      .build();
    
    const subId = this.client.subscribe(filter, {
      onEvent: async (event) => {
        try {
          const decrypted = await this.keyManager.decryptHex(
            event.content,
            event.pubkey
          );
          const content = JSON.parse(decrypted) as BugResponseContent;
          onResponse(event, content);
        } catch (error) {
          console.error("Failed to decrypt response:", error);
        }
      },
    });
    
    this.subscriptions.set("responses", subId);
    return subId;
  }
  
  // Subscribe to bounty announcements
  subscribeToBounties(
    repos: string[],
    since: number,
    onBounty: (event: NostrEvent, content: Bounty) => void
  ): string {
    // Query for bounties on specific repos
    const filter = Filter.builder()
      .kinds(EVENT_KINDS.BOUNTY)
      .since(since)
      .build();
    
    const subId = this.client.subscribe(filter, {
      onEvent: (event) => {
        const repoTag = event.tags.find((t) => t[0] === "repo");
        if (repoTag && repos.some((r) => repoTag[1].includes(r))) {
          const content = JSON.parse(event.content) as Bounty;
          onBounty(event, content);
        }
      },
    });
    
    this.subscriptions.set("bounties", subId);
    return subId;
  }
}
```

---

### 1.5 Wallet Service

**File: `src/services/wallet/service.ts`**

```typescript
import { NostrKeyManager, NostrClient, Filter, EventKinds } from "@unicitylabs/nostr-js-sdk";
import { COINS } from "../../constants/coins";

export interface TransferResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export class WalletService {
  private keyManager: NostrKeyManager;
  private client: NostrClient;
  
  constructor(keyManager: NostrKeyManager, client: NostrClient) {
    this.keyManager = keyManager;
    this.client = client;
  }
  
  // Send deposit payment to maintainer
  async sendDeposit(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA
  ): Promise<TransferResult> {
    try {
      const tokenData = JSON.stringify({
        amount: amount.toString(),
        coinId,
        requestId: `deposit_${reportId}`,
        message: `Bug report deposit for ${reportId}`,
      });
      
      const eventId = await this.client.sendTokenTransfer(recipientPubkey, tokenData);
      
      return {
        success: true,
        txHash: eventId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
  
  // Send refund back to reporter (maintainer accepting report)
  async sendRefund(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA
  ): Promise<TransferResult> {
    try {
      const tokenData = JSON.stringify({
        amount: amount.toString(),
        coinId,
        requestId: `refund_${reportId}`,
        message: `Deposit refund for accepted report ${reportId}`,
      });
      
      const eventId = await this.client.sendTokenTransfer(recipientPubkey, tokenData);
      
      return {
        success: true,
        txHash: eventId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
  
  // Send bounty payment (maintainer paying reporter)
  async sendBounty(
    recipientPubkey: string,
    amount: bigint,
    reportId: string,
    coinId: string = COINS.ALPHA
  ): Promise<TransferResult> {
    try {
      const tokenData = JSON.stringify({
        amount: amount.toString(),
        coinId,
        requestId: `bounty_${reportId}`,
        message: `Bounty payment for report ${reportId}`,
      });
      
      const eventId = await this.client.sendTokenTransfer(recipientPubkey, tokenData);
      
      return {
        success: true,
        txHash: eventId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
  
  // Listen for incoming token transfers
  subscribeToTransfers(
    onTransfer: (from: string, amount: string, requestId: string) => void
  ): void {
    const filter = Filter.builder()
      .kinds(EventKinds.TOKEN_TRANSFER)
      .pTags(this.keyManager.getPublicKeyHex())
      .since(Math.floor(Date.now() / 1000) - 3600) // Last hour
      .build();
    
    this.client.subscribe(filter, {
      onEvent: async (event) => {
        try {
          const decrypted = await this.keyManager.decryptHex(
            event.content,
            event.pubkey
          );
          const jsonStr = decrypted.replace(/^token_transfer:/, "");
          const data = JSON.parse(jsonStr);
          onTransfer(event.pubkey, data.amount, data.requestId);
        } catch (error) {
          console.error("Failed to process transfer:", error);
        }
      },
    });
  }
}
```

---

### 1.6 Identity Manager

**File: `src/services/identity/manager.ts`**

Manages multiple identities, each with its own NOSTR client and wallet.

```typescript
import { NostrKeyManager, NostrClient } from "@unicitylabs/nostr-js-sdk";
import { WalletService } from "../wallet/service";
import type { Config, Identity } from "../../types/config";

export interface ManagedIdentity {
  name: string;
  keyManager: NostrKeyManager;
  client: NostrClient;
  wallet: WalletService;
  nametag?: string;
}

export class IdentityManager {
  private identities: Map<string, ManagedIdentity> = new Map();
  private relays: string[];
  
  constructor(private config: Config) {
    this.relays = config.relays;
  }
  
  async initialize(): Promise<void> {
    // Initialize all configured identities
    for (const [name, identity] of Object.entries(this.config.identities)) {
      await this.addIdentity(name, identity);
    }
  }
  
  private async addIdentity(name: string, identity: Identity): Promise<void> {
    const keyManager = NostrKeyManager.fromPrivateKeyHex(identity.privateKey);
    const client = new NostrClient(keyManager);
    
    await client.connect(...this.relays);
    
    // Register nametag if configured and not already registered
    if (identity.nametag) {
      const existing = await client.queryPubkeyByNametag(identity.nametag);
      if (!existing) {
        await client.publishNametagBinding(identity.nametag, keyManager.getPublicKeyHex());
      }
    }
    
    const wallet = new WalletService(keyManager, client);
    
    this.identities.set(name, {
      name,
      keyManager,
      client,
      wallet,
      nametag: identity.nametag,
    });
  }
  
  get(name: string): ManagedIdentity | undefined {
    return this.identities.get(name);
  }
  
  getReporterIdentity(): ManagedIdentity | undefined {
    if (!this.config.reporter?.identity) return undefined;
    return this.identities.get(this.config.reporter.identity);
  }
  
  getInboxIdentity(inboxName: string): ManagedIdentity | undefined {
    const inbox = this.config.maintainer.inboxes.find(
      (i) => i.identity === inboxName
    );
    if (!inbox) return undefined;
    return this.identities.get(inbox.identity);
  }
  
  getAllInboxIdentities(): ManagedIdentity[] {
    return this.config.maintainer.inboxes
      .map((inbox) => this.identities.get(inbox.identity))
      .filter((id): id is ManagedIdentity => id !== undefined);
  }
  
  listIdentities(): string[] {
    return Array.from(this.identities.keys());
  }
  
  disconnect(): void {
    for (const identity of this.identities.values()) {
      identity.client.disconnect();
    }
    this.identities.clear();
  }
}
```

**Usage in tools:**

```typescript
// Reporter tool - uses configured reporter identity
const reporter = identityManager.getReporterIdentity();
await reporter.wallet.sendDeposit(recipientPubkey, amount, reportId);
await reporter.client.publishBugReport(content, recipientPubkey);

// Maintainer tool - uses specific inbox identity
const inbox = identityManager.getInboxIdentity("mylib");
await inbox.wallet.sendBounty(reporterPubkey, amount, reportId);
```

---

## Phase 2: Daemon

### 2.1 Process Management

**File: `src/daemon/process.ts`**

Singleton enforcement using PID file:

```typescript
import fs from "fs";
import { PATHS } from "../constants/paths";

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check if process exists
    return true;
  } catch {
    return false;
  }
}

export function checkSingleton(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PATHS.DAEMON_PID)) {
    return { running: false };
  }
  
  const pid = parseInt(fs.readFileSync(PATHS.DAEMON_PID, "utf-8").trim(), 10);
  
  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }
  
  // Stale PID file - process died without cleanup
  fs.unlinkSync(PATHS.DAEMON_PID);
  return { running: false };
}

export function writePidFile(): void {
  fs.writeFileSync(PATHS.DAEMON_PID, process.pid.toString());
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(PATHS.DAEMON_PID);
  } catch {
    // Ignore if already removed
  }
}

export function setupCleanup(): void {
  const cleanup = () => {
    removePidFile();
    process.exit(0);
  };
  
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("exit", removePidFile);
}
```

### 2.2 IPC Server

**File: `src/daemon/ipc-server.ts`**

Unix socket server for receiving commands from MCP server:

```typescript
import net from "net";
import fs from "fs";
import { PATHS } from "../constants/paths";
import { logger } from "../utils/logger";
import type { IpcRequest, IpcResponse } from "../types/ipc";

export type CommandHandler = (request: IpcRequest) => Promise<IpcResponse>;

export class IpcServer {
  private server: net.Server | null = null;
  private handler: CommandHandler;
  
  constructor(handler: CommandHandler) {
    this.handler = handler;
  }
  
  start(): void {
    // Remove stale socket file
    if (fs.existsSync(PATHS.DAEMON_SOCKET)) {
      fs.unlinkSync(PATHS.DAEMON_SOCKET);
    }
    
    this.server = net.createServer((socket) => {
      let buffer = "";
      
      socket.on("data", async (data) => {
        buffer += data.toString();
        
        // Simple newline-delimited JSON protocol
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const request = JSON.parse(line) as IpcRequest;
            const response = await this.handler(request);
            socket.write(JSON.stringify(response) + "\n");
          } catch (error) {
            const errorResponse: IpcResponse = {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
            socket.write(JSON.stringify(errorResponse) + "\n");
          }
        }
      });
      
      socket.on("error", (err) => {
        logger.error("IPC socket error", err);
      });
    });
    
    this.server.listen(PATHS.DAEMON_SOCKET, () => {
      logger.info(`IPC server listening on ${PATHS.DAEMON_SOCKET}`);
    });
  }
  
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (fs.existsSync(PATHS.DAEMON_SOCKET)) {
      fs.unlinkSync(PATHS.DAEMON_SOCKET);
    }
  }
}
```

**File: `src/types/ipc.ts`**

```typescript
// Commands from MCP server to daemon
export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  | { type: "accept_report"; inbox: string; reportId: string; message?: string; payBounty?: boolean }
  | { type: "reject_report"; inbox: string; reportId: string; reason: string }
  | { type: "publish_fix"; inbox: string; reportId: string; commitHash: string; message?: string }
  | { type: "set_bounty"; inbox: string; repo: string; severity: string; amount: number }
  | { type: "block_sender"; inbox: string; pubkey: string; reason?: string }
  | { type: "unblock_sender"; inbox: string; pubkey: string };

export interface IpcResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptime: number;
  connectedRelays: string[];
  inboxes: {
    identity: string;
    nametag?: string;
    repositories: string[];
    pendingReports: number;
  }[];
  lastSync: number;
}
```

### 2.3 Daemon Entry Point

**File: `src/daemon/index.ts`**

```typescript
import { loadConfig } from "../config/loader";
import { initializeDatabase, DatabaseWrapper } from "../storage/database";
import { IdentityManager } from "../services/identity/manager";
import { IpcServer } from "./ipc-server";
import { createCommandHandler } from "./handlers";
import { startSync } from "./sync";
import { checkSingleton, writePidFile, setupCleanup } from "./process";
import { logger } from "../utils/logger";
import { PATHS } from "../constants/paths";

export async function runDaemon(): Promise<void> {
  // Check singleton
  const status = checkSingleton();
  if (status.running) {
    logger.error(`Daemon already running (PID ${status.pid})`);
    process.exit(1);
  }
  
  // Write PID file and setup cleanup handlers
  writePidFile();
  setupCleanup();
  
  logger.info(`Daemon starting (PID ${process.pid})`);
  
  // Load config
  const config = await loadConfig();
  
  // Check if maintainer mode is enabled
  if (!config.maintainer?.enabled || config.maintainer.inboxes.length === 0) {
    logger.error("No inboxes configured. Daemon requires maintainer.enabled=true with at least one inbox.");
    process.exit(1);
  }
  
  // Initialize database
  const rawDb = await initializeDatabase(config.database ?? PATHS.DATABASE);
  const db = new DatabaseWrapper(rawDb, config.database ?? PATHS.DATABASE);
  
  // Initialize identity manager
  const identityManager = new IdentityManager(config);
  await identityManager.initialize();
  
  logger.info(`Loaded ${identityManager.listIdentities().length} identities`);
  
  // Start NOSTR sync for all inboxes
  await startSync(identityManager, db, config);
  
  // Start IPC server
  const handler = createCommandHandler(identityManager, db, config);
  const ipcServer = new IpcServer(handler);
  ipcServer.start();
  
  // Keep process alive
  logger.info("Daemon running. Press Ctrl+C to stop.");
  
  // Periodic database save
  setInterval(() => {
    db.save();
  }, 30000);
}
```

### 2.4 NOSTR Sync

**File: `src/daemon/sync.ts`**

```typescript
import { IdentityManager, ManagedIdentity } from "../services/identity/manager";
import { DatabaseWrapper } from "../storage/database";
import { ReportsRepository } from "../storage/repositories/reports";
import { SyncStateRepository } from "../storage/repositories/sync-state";
import { ReputationRepository } from "../storage/repositories/reputation";
import { BlockedRepository } from "../storage/repositories/blocked";
import { BugReportContentSchema } from "../types/events";
import { logger } from "../utils/logger";
import type { Config } from "../types/config";
import { v4 as uuid } from "uuid";

export async function startSync(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
): Promise<void> {
  const syncRepo = new SyncStateRepository(db);
  const reportsRepo = new ReportsRepository(db);
  const repRepo = new ReputationRepository(db);
  const blockedRepo = new BlockedRepository(db);
  
  // Get last sync time (default to 7 days ago)
  const lastSync = syncRepo.get("last_sync") ?? Math.floor(Date.now() / 1000) - 604800;
  
  for (const inbox of identityManager.getAllInboxIdentities()) {
    const inboxConfig = config.maintainer.inboxes.find(i => i.identity === inbox.name);
    if (!inboxConfig) continue;
    
    logger.info(`Starting sync for inbox: ${inbox.name} (${inbox.nametag ?? inbox.keyManager.getPublicKeyHex().slice(0, 16)}...)`);
    
    // Subscribe to incoming bug reports
    inbox.client.subscribeToReports(lastSync, async (event, content) => {
      // Validate content
      const parsed = BugReportContentSchema.safeParse(content);
      if (!parsed.success) {
        logger.warn(`Invalid bug report content: ${parsed.error.message}`);
        return;
      }
      
      // Check blocked
      if (blockedRepo.isBlocked(event.pubkey)) {
        logger.debug(`Ignored report from blocked sender: ${event.pubkey.slice(0, 16)}...`);
        return;
      }
      
      // Check duplicate
      const existing = reportsRepo.findById(content.bug_id);
      if (existing) {
        logger.debug(`Duplicate report ignored: ${content.bug_id}`);
        return;
      }
      
      // Check if repo matches this inbox
      const repoMatches = inboxConfig.repositories.some(r => 
        content.repo.includes(r) || r.includes(content.repo)
      );
      if (!repoMatches) {
        logger.debug(`Report for untracked repo: ${content.repo}`);
        return;
      }
      
      // Store report
      reportsRepo.create({
        id: content.bug_id,
        repo_url: content.repo,
        file_path: content.file,
        line_start: content.line_start,
        line_end: content.line_end,
        description: content.description,
        suggested_fix: content.suggested_fix,
        severity: content.severity,
        category: content.category,
        agent_model: content.agent_model,
        agent_version: content.agent_version,
        sender_pubkey: event.pubkey,
        recipient_pubkey: inbox.keyManager.getPublicKeyHex(),
        deposit_tx: content.deposit_tx,
        deposit_amount: content.deposit_amount ? parseInt(content.deposit_amount, 10) : undefined,
        deposit_coin: "414c504841", // ALPHA
        status: "pending",
        direction: "received",
        created_at: event.created_at * 1000,
        updated_at: Date.now(),
        nostr_event_id: event.id,
      });
      
      // Update sender reputation
      repRepo.incrementTotal(event.pubkey);
      
      logger.info(`New report received: ${content.bug_id} [${content.severity}] from ${event.pubkey.slice(0, 16)}...`);
    });
  }
  
  // Update sync state periodically
  setInterval(() => {
    syncRepo.set("last_sync", Math.floor(Date.now() / 1000));
  }, 60000);
  
  logger.info("NOSTR sync started");
}
```

### 2.5 Command Handlers

**File: `src/daemon/handlers.ts`**

```typescript
import type { IpcRequest, IpcResponse, DaemonStatus } from "../types/ipc";
import { IdentityManager } from "../services/identity/manager";
import { DatabaseWrapper } from "../storage/database";
import { ReportsRepository } from "../storage/repositories/reports";
import { BountiesRepository } from "../storage/repositories/bounties";
import { ResponsesRepository } from "../storage/repositories/responses";
import { ReputationRepository } from "../storage/repositories/reputation";
import { BlockedRepository } from "../storage/repositories/blocked";
import type { Config } from "../types/config";
import { v4 as uuid } from "uuid";
import { COINS } from "../constants/coins";

const startTime = Date.now();

export function createCommandHandler(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
) {
  return async (request: IpcRequest): Promise<IpcResponse> => {
    switch (request.type) {
      case "ping":
        return { success: true, data: "pong" };
        
      case "status":
        return { success: true, data: getDaemonStatus(identityManager, db, config) };
        
      case "accept_report":
        return handleAcceptReport(request, identityManager, db, config);
        
      case "reject_report":
        return handleRejectReport(request, identityManager, db, config);
        
      case "publish_fix":
        return handlePublishFix(request, identityManager, db, config);
        
      case "set_bounty":
        return handleSetBounty(request, identityManager, db, config);
        
      case "block_sender":
        return handleBlockSender(request, db);
        
      case "unblock_sender":
        return handleUnblockSender(request, db);
        
      default:
        return { success: false, error: `Unknown command: ${(request as any).type}` };
    }
  };
}

function getDaemonStatus(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
): DaemonStatus {
  const reportsRepo = new ReportsRepository(db);
  
  return {
    running: true,
    pid: process.pid,
    uptime: Date.now() - startTime,
    connectedRelays: config.relays,
    inboxes: config.maintainer.inboxes.map(inbox => {
      const identity = identityManager.get(inbox.identity);
      const pendingCount = reportsRepo.countByStatus(
        identity?.keyManager.getPublicKeyHex() ?? "",
        "pending"
      );
      return {
        identity: inbox.identity,
        nametag: identity?.nametag,
        repositories: inbox.repositories,
        pendingReports: pendingCount,
      };
    }),
    lastSync: Date.now(),
  };
}

async function handleAcceptReport(
  request: Extract<IpcRequest, { type: "accept_report" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
): Promise<IpcResponse> {
  const inbox = identityManager.getInboxIdentity(request.inbox);
  if (!inbox) {
    return { success: false, error: `Inbox not found: ${request.inbox}` };
  }
  
  const reportsRepo = new ReportsRepository(db);
  const report = reportsRepo.findById(request.reportId);
  
  if (!report) {
    return { success: false, error: `Report not found: ${request.reportId}` };
  }
  
  if (report.status !== "pending" && report.status !== "acknowledged") {
    return { success: false, error: `Report already ${report.status}` };
  }
  
  // Refund deposit
  if (report.deposit_amount && report.deposit_amount > 0) {
    const refundResult = await inbox.wallet.sendRefund(
      report.sender_pubkey,
      BigInt(report.deposit_amount),
      request.reportId
    );
    if (!refundResult.success) {
      return { success: false, error: `Failed to refund deposit: ${refundResult.error}` };
    }
  }
  
  // Pay bounty if requested
  let bountyPaid = 0;
  if (request.payBounty !== false) {
    const bountiesRepo = new BountiesRepository(db);
    const bounty = bountiesRepo.findAvailable(report.repo_url, report.severity);
    if (bounty) {
      const bountyResult = await inbox.wallet.sendBounty(
        report.sender_pubkey,
        BigInt(bounty.amount),
        request.reportId
      );
      if (bountyResult.success) {
        bountyPaid = bounty.amount;
        bountiesRepo.markClaimed(bounty.id, report.sender_pubkey, request.reportId);
      }
    }
  }
  
  // Update report status
  reportsRepo.updateStatus(request.reportId, "accepted");
  
  // Update reputation
  const repRepo = new ReputationRepository(db);
  repRepo.incrementAccepted(report.sender_pubkey);
  
  // Publish response to NOSTR
  await inbox.client.publishBugResponse(
    {
      report_id: request.reportId,
      response_type: "accept",
      message: request.message,
      bounty_paid: bountyPaid > 0 ? bountyPaid.toString() : undefined,
    },
    report.sender_pubkey,
    report.nostr_event_id!
  );
  
  // Store response
  const responsesRepo = new ResponsesRepository(db);
  responsesRepo.create({
    id: uuid(),
    report_id: request.reportId,
    response_type: "accept",
    message: request.message,
    bounty_paid: bountyPaid,
    bounty_coin: bountyPaid > 0 ? COINS.ALPHA : undefined,
    responder_pubkey: inbox.keyManager.getPublicKeyHex(),
    created_at: Date.now(),
  });
  
  db.save();
  
  return {
    success: true,
    data: { depositRefunded: report.deposit_amount ?? 0, bountyPaid },
  };
}

// Similar implementations for reject_report, publish_fix, set_bounty, block_sender, unblock_sender...
async function handleRejectReport(
  request: Extract<IpcRequest, { type: "reject_report" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
): Promise<IpcResponse> {
  // Implementation similar to accept but keeps deposit
  // ...
  return { success: true };
}

async function handlePublishFix(
  request: Extract<IpcRequest, { type: "publish_fix" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
): Promise<IpcResponse> {
  // Publish fix_published response with commit hash
  // ...
  return { success: true };
}

async function handleSetBounty(
  request: Extract<IpcRequest, { type: "set_bounty" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
): Promise<IpcResponse> {
  // Create or update bounty in database
  // ...
  return { success: true };
}

function handleBlockSender(
  request: Extract<IpcRequest, { type: "block_sender" }>,
  db: DatabaseWrapper
): IpcResponse {
  const blockedRepo = new BlockedRepository(db);
  blockedRepo.block(request.pubkey, request.reason);
  db.save();
  return { success: true };
}

function handleUnblockSender(
  request: Extract<IpcRequest, { type: "unblock_sender" }>,
  db: DatabaseWrapper
): IpcResponse {
  const blockedRepo = new BlockedRepository(db);
  blockedRepo.unblock(request.pubkey);
  db.save();
  return { success: true };
}
```

---

## Phase 3: CLI

### 3.1 CLI Entry Point

**File: `src/cli.ts`**

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { runDaemon } from "./daemon";
import { runServer } from "./server";
import { 
  initCommand, 
  identityCommands, 
  daemonCommands, 
  walletCommands 
} from "./cli/commands";

const program = new Command();

program
  .name("bounty-net")
  .description("Decentralized bug reporting network for AI agents")
  .version("1.0.0");

// bounty-net init
program
  .command("init")
  .description("Initialize Bounty-Net configuration")
  .action(initCommand);

// bounty-net identity <subcommand>
const identity = program.command("identity").description("Manage identities");
identity
  .command("create <name>")
  .description("Generate a new identity keypair")
  .action(identityCommands.create);
identity
  .command("list")
  .description("List configured identities")
  .action(identityCommands.list);
identity
  .command("register <name>")
  .option("--nametag <tag>", "Nametag to register")
  .description("Register identity nametag on NOSTR network")
  .action(identityCommands.register);

// bounty-net daemon <subcommand>
const daemon = program.command("daemon").description("Manage background daemon");
daemon
  .command("start")
  .description("Start daemon in background")
  .action(daemonCommands.start);
daemon
  .command("stop")
  .description("Stop running daemon")
  .action(daemonCommands.stop);
daemon
  .command("status")
  .description("Check daemon status")
  .action(daemonCommands.status);
daemon
  .command("run")
  .description("Run daemon in foreground (for debugging)")
  .action(runDaemon);
daemon
  .command("logs")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .description("View daemon logs")
  .action(daemonCommands.logs);

// bounty-net wallet <subcommand>
const wallet = program.command("wallet").description("Wallet operations");
wallet
  .command("balance [identity]")
  .description("Check token balance")
  .action(walletCommands.balance);
wallet
  .command("address [identity]")
  .description("Show deposit address")
  .action(walletCommands.address);

// bounty-net serve (MCP server - called by IDE)
program
  .command("serve")
  .description("Run MCP server (called by IDE)")
  .action(runServer);

program.parse();
```

### 3.2 Daemon CLI Commands

**File: `src/cli/commands/daemon.ts`**

```typescript
import { spawn } from "child_process";
import fs from "fs";
import { checkSingleton, isProcessRunning } from "../../daemon/process";
import { PATHS } from "../../constants/paths";
import { IpcClient } from "../../server/ipc-client";

export async function start(): Promise<void> {
  const status = checkSingleton();
  if (status.running) {
    console.log(`Daemon already running (PID ${status.pid})`);
    return;
  }
  
  // Ensure base directory exists
  fs.mkdirSync(PATHS.BASE_DIR, { recursive: true });
  
  // Spawn daemon in background
  const logFile = fs.openSync(PATHS.DAEMON_LOG, "a");
  const child = spawn(process.execPath, [process.argv[1], "daemon", "run"], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
  });
  
  child.unref();
  
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${PATHS.DAEMON_LOG}`);
}

export async function stop(): Promise<void> {
  const status = checkSingleton();
  if (!status.running) {
    console.log("Daemon is not running");
    return;
  }
  
  try {
    process.kill(status.pid!, "SIGTERM");
    console.log(`Daemon stopped (PID ${status.pid})`);
  } catch (error) {
    console.error("Failed to stop daemon:", error);
  }
}

export async function status(): Promise<void> {
  const processStatus = checkSingleton();
  
  if (!processStatus.running) {
    console.log("Daemon is not running");
    return;
  }
  
  console.log(`Daemon running (PID ${processStatus.pid})`);
  
  // Try to get detailed status via IPC
  try {
    const client = new IpcClient();
    await client.connect();
    const response = await client.send({ type: "status" });
    client.disconnect();
    
    if (response.success && response.data) {
      const data = response.data as any;
      console.log(`Uptime: ${Math.floor(data.uptime / 1000)}s`);
      console.log(`Connected relays: ${data.connectedRelays.join(", ")}`);
      console.log("Inboxes:");
      for (const inbox of data.inboxes) {
        console.log(`  - ${inbox.identity} (${inbox.nametag ?? "no nametag"}): ${inbox.pendingReports} pending`);
      }
    }
  } catch {
    console.log("(Could not connect to daemon for detailed status)");
  }
}

export async function logs(options: { follow?: boolean; lines?: string }): Promise<void> {
  if (!fs.existsSync(PATHS.DAEMON_LOG)) {
    console.log("No log file found");
    return;
  }
  
  if (options.follow) {
    // Use tail -f
    const tail = spawn("tail", ["-f", "-n", options.lines ?? "50", PATHS.DAEMON_LOG], {
      stdio: "inherit",
    });
    tail.on("error", () => {
      // Fallback: just read the file
      console.log(fs.readFileSync(PATHS.DAEMON_LOG, "utf-8"));
    });
  } else {
    // Read last N lines
    const content = fs.readFileSync(PATHS.DAEMON_LOG, "utf-8");
    const lines = content.split("\n");
    const n = parseInt(options.lines ?? "50", 10);
    console.log(lines.slice(-n).join("\n"));
  }
}
```

---

## Phase 4: MCP Server & Tools

### 4.1 IPC Client

**File: `src/server/ipc-client.ts`**

Client for communicating with daemon from MCP server:

```typescript
import net from "net";
import fs from "fs";
import { PATHS } from "../constants/paths";
import type { IpcRequest, IpcResponse } from "../types/ipc";

export class IpcClient {
  private socket: net.Socket | null = null;
  
  isDaemonRunning(): boolean {
    return fs.existsSync(PATHS.DAEMON_SOCKET);
  }
  
  async connect(): Promise<void> {
    if (!this.isDaemonRunning()) {
      throw new Error("Daemon is not running");
    }
    
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(PATHS.DAEMON_SOCKET);
      this.socket.once("connect", () => resolve());
      this.socket.once("error", (err) => reject(err));
    });
  }
  
  async send(request: IpcRequest): Promise<IpcResponse> {
    if (!this.socket) {
      throw new Error("Not connected");
    }
    
    return new Promise((resolve, reject) => {
      let buffer = "";
      
      const onData = (data: Buffer) => {
        buffer += data.toString();
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          this.socket!.off("data", onData);
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("Invalid response from daemon"));
          }
        }
      };
      
      this.socket!.on("data", onData);
      this.socket!.write(JSON.stringify(request) + "\n");
      
      // Timeout after 30 seconds
      setTimeout(() => {
        this.socket!.off("data", onData);
        reject(new Error("Timeout waiting for daemon response"));
      }, 30000);
    });
  }
  
  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}

// Singleton instance for MCP server
let client: IpcClient | null = null;

export async function getDaemonClient(): Promise<IpcClient | null> {
  if (!fs.existsSync(PATHS.DAEMON_SOCKET)) {
    return null; // Daemon not running
  }
  
  if (!client) {
    client = new IpcClient();
    try {
      await client.connect();
    } catch {
      client = null;
      return null;
    }
  }
  
  return client;
}

export function disconnectDaemonClient(): void {
  if (client) {
    client.disconnect();
    client = null;
  }
}
```

### 4.2 MCP Server Setup

**File: `src/server/index.ts`**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../config/loader";
import { initializeDatabase, DatabaseWrapper } from "../storage/database";
import { IdentityManager } from "../services/identity/manager";
import { createReporterTools } from "../tools/reporter";
import { createMaintainerTools } from "../tools/maintainer";
import { createSharedTools } from "../tools/shared";
import { getDaemonClient, disconnectDaemonClient } from "./ipc-client";
import { backfillResponses } from "./backfill";
import { PATHS } from "../constants/paths";
import { logger } from "../utils/logger";

export async function runServer(): Promise<void> {
  // Load configuration
  const config = await loadConfig();
  
  // Initialize database (read-only if daemon is running, else read-write)
  const rawDb = await initializeDatabase(config.database ?? PATHS.DATABASE);
  const db = new DatabaseWrapper(rawDb, config.database ?? PATHS.DATABASE);
  
  // Check if daemon is running
  const daemonClient = await getDaemonClient();
  const daemonRunning = daemonClient !== null;
  
  logger.info(`MCP server starting (daemon: ${daemonRunning ? "connected" : "not running"})`);
  
  // Initialize identity manager
  const identityManager = new IdentityManager(config);
  await identityManager.initialize();
  
  // For reporter-only mode without daemon: backfill responses on startup
  if (config.reporter?.enabled && !daemonRunning) {
    const reporterIdentity = identityManager.getReporterIdentity();
    if (reporterIdentity) {
      await backfillResponses(reporterIdentity, db);
    }
  }
  
  // Create MCP server
  const server = new Server(
    { name: "bounty-net", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  
  // Collect tools based on enabled roles
  const tools: Tool[] = [];
  const handlers: Map<string, ToolHandler> = new Map();
  
  // Always include shared tools
  const sharedTools = createSharedTools(identityManager, db, config);
  tools.push(...sharedTools.definitions);
  sharedTools.handlers.forEach((h, name) => handlers.set(name, h));
  
  // Reporter tools if enabled
  if (config.reporter?.enabled) {
    const reporterIdentity = identityManager.getReporterIdentity();
    if (!reporterIdentity) {
      throw new Error(
        `Reporter identity "${config.reporter.identity}" not found in identities`
      );
    }
    
    const reporterTools = createReporterTools(
      reporterIdentity,
      db,
      config.reporter
    );
    tools.push(...reporterTools.definitions);
    reporterTools.handlers.forEach((h, name) => handlers.set(name, h));
  }
  
  // Maintainer tools if enabled
  if (config.maintainer?.enabled && config.maintainer.inboxes.length > 0) {
    // Maintainer tools route writes through daemon if available
    const maintainerTools = createMaintainerTools(
      identityManager,
      db,
      config.maintainer,
      daemonClient  // Pass daemon client for IPC writes
    );
    tools.push(...maintainerTools.definitions);
    maintainerTools.handlers.forEach((h, name) => handlers.set(name, h));
  }
  
  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));
  
  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers.get(name);
    
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    return handler(args);
  });
  
  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Graceful shutdown
  process.on("SIGINT", () => {
    disconnectDaemonClient();
    identityManager.disconnect();
    db.close();
    process.exit(0);
  });
}
```

### 4.3 Response Backfill (Reporter-only mode)

**File: `src/server/backfill.ts`**

For reporters without a daemon, catch up on responses at startup:

```typescript
import { ManagedIdentity } from "../services/identity/manager";
import { DatabaseWrapper } from "../storage/database";
import { SyncStateRepository } from "../storage/repositories/sync-state";
import { ReportsRepository } from "../storage/repositories/reports";
import { ResponsesRepository } from "../storage/repositories/responses";
import { BugResponseContentSchema } from "../types/events";
import { logger } from "../utils/logger";

export async function backfillResponses(
  identity: ManagedIdentity,
  db: DatabaseWrapper
): Promise<void> {
  const syncRepo = new SyncStateRepository(db);
  const reportsRepo = new ReportsRepository(db);
  const responsesRepo = new ResponsesRepository(db);
  
  // Get last sync time (default to 7 days ago)
  const lastSync = syncRepo.get("reporter_last_sync") ?? Math.floor(Date.now() / 1000) - 604800;
  
  logger.info(`Backfilling responses since ${new Date(lastSync * 1000).toISOString()}`);
  
  // Query for responses to our sent reports
  const responses = await identity.client.queryResponses(lastSync);
  
  let count = 0;
  for (const { event, content } of responses) {
    // Validate content
    const parsed = BugResponseContentSchema.safeParse(content);
    if (!parsed.success) continue;
    
    // Find the original report
    const report = reportsRepo.findById(content.report_id);
    if (!report || report.direction !== "sent") continue;
    
    // Check if we already have this response
    const existing = responsesRepo.findByEventId(event.id);
    if (existing) continue;
    
    // Update report status
    reportsRepo.updateStatus(content.report_id, content.response_type);
    
    // Store response
    responsesRepo.create({
      id: crypto.randomUUID(),
      report_id: content.report_id,
      response_type: content.response_type,
      message: content.message,
      commit_hash: content.commit_hash,
      bounty_paid: content.bounty_paid ? parseInt(content.bounty_paid, 10) : undefined,
      responder_pubkey: event.pubkey,
      created_at: event.created_at * 1000,
      nostr_event_id: event.id,
    });
    
    count++;
  }
  
  // Update sync state
  syncRepo.set("reporter_last_sync", Math.floor(Date.now() / 1000));
  db.save();
  
  logger.info(`Backfilled ${count} responses`);
}

---

### 4.4 Reporter Tools

**File: `src/tools/reporter/report-bug.ts`**

```typescript
import { v4 as uuid } from "uuid";
import type { BountyNetNostrClient } from "../../services/nostr/client";
import type { WalletService } from "../../services/wallet/service";
import type { Database } from "better-sqlite3";
import { BugReportContentSchema } from "../../types/events";
import { discoverMaintainer } from "../../services/discovery/maintainer";

export const reportBugTool = {
  name: "report_bug",
  description: "Submit a bug report to a library maintainer with a deposit stake",
  inputSchema: {
    type: "object",
    properties: {
      maintainer: {
        type: "string",
        description: "Maintainer's npub, nametag, or repository URL for discovery",
      },
      repo_url: {
        type: "string",
        description: "Repository URL (e.g., https://github.com/org/lib)",
      },
      file_path: {
        type: "string",
        description: "File path with optional line numbers (e.g., src/main.rs:123-145)",
      },
      description: {
        type: "string",
        description: "Detailed bug description",
      },
      suggested_fix: {
        type: "string",
        description: "Suggested code fix (optional)",
      },
      severity: {
        type: "string",
        enum: ["critical", "high", "medium", "low"],
        description: "Bug severity level",
      },
      category: {
        type: "string",
        description: "Bug category (e.g., memory-leak, race-condition)",
      },
      context: {
        type: "object",
        description: "Additional context (dependencies, runtime, etc.)",
      },
    },
    required: ["maintainer", "repo_url", "description", "severity"],
  },
};

export function createReportBugHandler(
  nostrClient: BountyNetNostrClient,
  walletService: WalletService,
  db: Database,
  config: ReporterConfig
) {
  return async (args: Record<string, unknown>) => {
    // 1. Resolve maintainer pubkey
    let recipientPubkey: string;
    const maintainerInput = args.maintainer as string;
    
    if (maintainerInput.startsWith("npub")) {
      // Direct npub
      recipientPubkey = npubToHex(maintainerInput);
    } else if (maintainerInput.includes("/")) {
      // Repository URL - discover maintainer
      const discovered = await discoverMaintainer(maintainerInput);
      if (!discovered) {
        return {
          content: [{
            type: "text",
            text: `Could not discover maintainer for ${maintainerInput}. Please provide an npub or nametag directly.`,
          }],
          isError: true,
        };
      }
      recipientPubkey = discovered.pubkey;
    } else {
      // Nametag
      const resolved = await nostrClient.resolveNametag(maintainerInput);
      if (!resolved) {
        return {
          content: [{
            type: "text",
            text: `Could not resolve nametag: ${maintainerInput}`,
          }],
          isError: true,
        };
      }
      recipientPubkey = resolved;
    }
    
    // 2. Parse file path for line numbers
    let filePath = args.file_path as string | undefined;
    let lineStart: number | undefined;
    let lineEnd: number | undefined;
    
    if (filePath) {
      const match = filePath.match(/^(.+):(\d+)(?:-(\d+))?$/);
      if (match) {
        filePath = match[1];
        lineStart = parseInt(match[2], 10);
        lineEnd = match[3] ? parseInt(match[3], 10) : lineStart;
      }
    }
    
    // 3. Generate report ID
    const reportId = uuid();
    
    // 4. Send deposit
    const depositAmount = BigInt(config.defaultDeposit);
    const depositResult = await walletService.sendDeposit(
      recipientPubkey,
      depositAmount,
      reportId
    );
    
    if (!depositResult.success) {
      return {
        content: [{
          type: "text",
          text: `Failed to send deposit: ${depositResult.error}`,
        }],
        isError: true,
      };
    }
    
    // 5. Build report content
    const content: BugReportContent = {
      bug_id: reportId,
      repo: args.repo_url as string,
      file: filePath,
      line_start: lineStart,
      line_end: lineEnd,
      description: args.description as string,
      suggested_fix: args.suggested_fix as string | undefined,
      severity: args.severity as Severity,
      category: args.category as string | undefined,
      context: args.context as Record<string, unknown> | undefined,
      agent_model: process.env.AGENT_MODEL,
      agent_version: process.env.AGENT_VERSION,
      deposit_tx: depositResult.txHash,
      deposit_amount: depositAmount.toString(),
    };
    
    // 6. Publish to NOSTR
    const eventId = await nostrClient.publishBugReport(content, recipientPubkey);
    
    // 7. Store locally
    const reportsRepo = new ReportsRepository(db);
    reportsRepo.create({
      id: reportId,
      repo_url: content.repo,
      file_path: content.file,
      line_start: content.line_start,
      line_end: content.line_end,
      description: content.description,
      suggested_fix: content.suggested_fix,
      severity: content.severity,
      category: content.category,
      agent_model: content.agent_model,
      agent_version: content.agent_version,
      sender_pubkey: nostrClient.getPublicKey(),
      recipient_pubkey: recipientPubkey,
      deposit_tx: depositResult.txHash,
      deposit_amount: Number(depositAmount),
      deposit_coin: COINS.ALPHA,
      status: "pending",
      direction: "sent",
      created_at: Date.now(),
      updated_at: Date.now(),
      nostr_event_id: eventId,
    });
    
    // 8. Record transaction
    const txRepo = new TransactionsRepository(db);
    txRepo.create({
      id: uuid(),
      tx_hash: depositResult.txHash,
      type: "deposit",
      amount: Number(depositAmount),
      coin_id: COINS.ALPHA,
      sender_pubkey: nostrClient.getPublicKey(),
      recipient_pubkey: recipientPubkey,
      related_report_id: reportId,
      status: "confirmed",
      created_at: Date.now(),
      confirmed_at: Date.now(),
    });
    
    return {
      content: [{
        type: "text",
        text: `Bug report submitted successfully!\n\nReport ID: ${reportId}\nEvent ID: ${eventId}\nDeposit: ${depositAmount} ALPHA (tx: ${depositResult.txHash})\n\nThe maintainer will be notified. Use get_report_status to check for responses.`,
      }],
    };
  };
}
```

**Other Reporter Tools (summarized):**

```typescript
// get_report_status - Check status of a submitted report
// search_known_issues - Search for existing reports on a library
// claim_reward - Claim deposit refund after acceptance
// list_my_reports - List all reports submitted by this agent
// get_bounties - List available bounties for a repo
```

---

### 4.5 Maintainer Tools

**File: `src/tools/maintainer/helpers.ts`**

```typescript
import { IdentityManager, ManagedIdentity } from "../../services/identity/manager";
import type { MaintainerConfig } from "../../types/config";

// Resolve which inbox to use - defaults to first if only one configured
export function resolveInbox(
  identityManager: IdentityManager,
  config: MaintainerConfig,
  inboxName?: string
): ManagedIdentity | undefined {
  // If inbox specified, use that
  if (inboxName) {
    return identityManager.getInboxIdentity(inboxName);
  }
  
  // If only one inbox, use it as default
  if (config.inboxes.length === 1) {
    return identityManager.getInboxIdentity(config.inboxes[0].identity);
  }
  
  // Multiple inboxes and none specified - return undefined (error)
  return undefined;
}

// Get inbox config by identity name
export function getInboxConfig(config: MaintainerConfig, identityName: string) {
  return config.inboxes.find((i) => i.identity === identityName);
}
```

**File: `src/tools/maintainer/list-reports.ts`**

```typescript
export const listReportsTool = {
  name: "list_reports",
  description: "List incoming bug reports for an inbox",
  inputSchema: {
    type: "object",
    properties: {
      inbox: {
        type: "string",
        description: "Which inbox to list reports for. Required if multiple inboxes configured.",
      },
      status: {
        type: "string",
        enum: ["pending", "acknowledged", "accepted", "rejected", "all"],
        default: "pending",
      },
      severity: {
        type: "string",
        enum: ["critical", "high", "medium", "low", "all"],
      },
      limit: {
        type: "number",
        default: 50,
      },
    },
  },
};
```

**File: `src/tools/maintainer/accept-report.ts`**

```typescript
export const acceptReportTool = {
  name: "accept_report",
  description: "Accept a bug report as valid, refunding the deposit and optionally paying bounty",
  inputSchema: {
    type: "object",
    properties: {
      inbox: {
        type: "string",
        description: "Which inbox identity to use (e.g., 'mylib'). Required if multiple inboxes configured.",
      },
      report_id: {
        type: "string",
        description: "The bug report ID to accept",
      },
      message: {
        type: "string",
        description: "Optional message to the reporter",
      },
      pay_bounty: {
        type: "boolean",
        description: "Whether to pay the bounty if available",
        default: true,
      },
    },
    required: ["report_id"],
  },
};

export function createAcceptReportHandler(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: MaintainerConfig,
  daemonClient: IpcClient | null  // null = daemon not running
) {
  return async (args: Record<string, unknown>) => {
    const inboxName = args.inbox as string | undefined;
    const reportId = args.report_id as string;
    const message = args.message as string | undefined;
    const payBounty = args.pay_bounty !== false;
    
    // Resolve which inbox to use
    const resolvedInboxName = inboxName ?? (config.inboxes.length === 1 ? config.inboxes[0].identity : undefined);
    if (!resolvedInboxName) {
      return {
        content: [{
          type: "text",
          text: "Multiple inboxes configured. Specify which inbox to use with the 'inbox' parameter.",
        }],
        isError: true,
      };
    }
    
    // Verify inbox exists
    const inboxConfig = config.inboxes.find(i => i.identity === resolvedInboxName);
    if (!inboxConfig) {
      return {
        content: [{
          type: "text",
          text: `Inbox "${resolvedInboxName}" not found`,
        }],
        isError: true,
      };
    }
    
    // Read-only validation from local database
    const reportsRepo = new ReportsRepository(db);
    const report = reportsRepo.findById(reportId);
    
    if (!report) {
      return {
        content: [{ type: "text", text: `Report not found: ${reportId}` }],
        isError: true,
      };
    }
    
    if (report.direction !== "received") {
      return {
        content: [{ type: "text", text: "Can only accept reports you received" }],
        isError: true,
      };
    }
    
    if (report.status !== "pending" && report.status !== "acknowledged") {
      return {
        content: [{ type: "text", text: `Report already ${report.status}` }],
        isError: true,
      };
    }
    
    // Route through daemon if available (preferred for maintainer writes)
    if (daemonClient) {
      const response = await daemonClient.send({
        type: "accept_report",
        inbox: resolvedInboxName,
        reportId,
        message,
        payBounty,
      });
      
      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed to accept report: ${response.error}` }],
          isError: true,
        };
      }
      
      const data = response.data as { depositRefunded: number; bountyPaid: number };
      let resultText = `Report ${reportId} accepted.\n`;
      if (data.depositRefunded > 0) {
        resultText += `Deposit refunded: ${data.depositRefunded} ALPHA\n`;
      }
      if (data.bountyPaid > 0) {
        resultText += `Bounty paid: ${data.bountyPaid} ALPHA\n`;
      }
      
      return { content: [{ type: "text", text: resultText }] };
    }
    
    // Fallback: Direct execution (daemon not running)
    // This path is typically only used in testing or edge cases
    const inbox = identityManager.getInboxIdentity(resolvedInboxName);
    if (!inbox) {
      return {
        content: [{
          type: "text",
          text: `Inbox identity "${resolvedInboxName}" not loaded. Start the daemon for maintainer operations.`,
        }],
        isError: true,
      };
    }
    
    // Direct execution logic (same as daemon handler)
    let refundResult: TransferResult | null = null;
    if (report.deposit_amount && report.deposit_amount > 0) {
      refundResult = await inbox.wallet.sendRefund(
        report.sender_pubkey,
        BigInt(report.deposit_amount),
        reportId
      );
      
      if (!refundResult.success) {
        return {
          content: [{
            type: "text",
            text: `Failed to refund deposit: ${refundResult.error}`,
          }],
          isError: true,
        };
      }
    }
    
    let bountyAmount = 0;
    if (payBounty) {
      const bountiesRepo = new BountiesRepository(db);
      const bounty = bountiesRepo.findAvailable(report.repo_url, report.severity);
      
      if (bounty) {
        const bountyResult = await inbox.wallet.sendBounty(
          report.sender_pubkey,
          BigInt(bounty.amount),
          reportId
        );
        
        if (bountyResult.success) {
          bountyAmount = bounty.amount;
          bountiesRepo.markClaimed(bounty.id, report.sender_pubkey, reportId);
        }
      }
    }
    
    reportsRepo.updateStatus(reportId, "accepted");
    
    const repRepo = new ReputationRepository(db);
    repRepo.incrementAccepted(report.sender_pubkey);
    
    const responseContent: BugResponseContent = {
      report_id: reportId,
      response_type: "accept",
      message,
      bounty_paid: bountyAmount > 0 ? bountyAmount.toString() : undefined,
    };
    
    const eventId = await inbox.client.publishBugResponse(
      responseContent,
      report.sender_pubkey,
      report.nostr_event_id!
    );
    
    const responsesRepo = new ResponsesRepository(db);
    responsesRepo.create({
      id: uuid(),
      report_id: reportId,
      response_type: "accept",
      message,
      bounty_paid: bountyAmount,
      bounty_coin: bountyAmount > 0 ? COINS.ALPHA : undefined,
      responder_pubkey: inbox.keyManager.getPublicKeyHex(),
      created_at: Date.now(),
      nostr_event_id: eventId,
    });
    
    db.save();
    
    let resultText = `Report ${reportId} accepted.\n`;
    if (refundResult?.success) {
      resultText += `Deposit refunded: ${report.deposit_amount} ALPHA\n`;
    }
    if (bountyAmount > 0) {
      resultText += `Bounty paid: ${bountyAmount} ALPHA\n`;
    }
    
    return {
      content: [{ type: "text", text: resultText }],
    };
  };
}
```

**Other Maintainer Tools (summarized):**

All maintainer tools follow the same pattern: read-only operations (list, get) query the local database directly, while write operations (accept, reject, block, etc.) route through the daemon via IPC when available, with a fallback to direct execution.

```typescript
// Read-only tools (direct database access):
// list_reports - List incoming bug reports with filters
// get_report_details - Get full details of a report
// list_bounties - List configured bounties

// Write tools (route through daemon IPC):
// reject_report - Reject report as spam (keep deposit)
// publish_fix - Announce a fix with commit hash
// set_bounty - Set bounty amounts for a repo/severity
// block_sender - Block a sender from future reports
// unblock_sender - Remove a sender from blocklist
```

**File: `src/tools/maintainer/index.ts`**

```typescript
import type { IpcClient } from "../../server/ipc-client";
import type { IdentityManager } from "../../services/identity/manager";
import type { DatabaseWrapper } from "../../storage/database";
import type { MaintainerConfig } from "../../types/config";

export function createMaintainerTools(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: MaintainerConfig,
  daemonClient: IpcClient | null
) {
  const definitions = [
    listReportsTool,
    getReportDetailsTool,
    acceptReportTool,
    rejectReportTool,
    publishFixTool,
    setBountyTool,
    listBountiesTool,
    blockSenderTool,
    unblockSenderTool,
  ];
  
  const handlers = new Map([
    ["list_reports", createListReportsHandler(db, config)],
    ["get_report_details", createGetReportDetailsHandler(db)],
    ["accept_report", createAcceptReportHandler(identityManager, db, config, daemonClient)],
    ["reject_report", createRejectReportHandler(identityManager, db, config, daemonClient)],
    ["publish_fix", createPublishFixHandler(identityManager, db, config, daemonClient)],
    ["set_bounty", createSetBountyHandler(db, config, daemonClient)],
    ["list_bounties", createListBountiesHandler(db, config)],
    ["block_sender", createBlockSenderHandler(db, daemonClient)],
    ["unblock_sender", createUnblockSenderHandler(db, daemonClient)],
  ]);
  
  return { definitions, handlers };
}
```

---

### 4.6 Shared Tools

**File: `src/tools/shared/index.ts`**

```typescript
export const sharedTools = [
  {
    name: "get_balance",
    description: "Check wallet balance",
    inputSchema: {
      type: "object",
      properties: {
        coin_id: {
          type: "string",
          description: "Token ID (default: ALPHA)",
        },
      },
    },
  },
  {
    name: "resolve_maintainer",
    description: "Resolve a repository or package name to maintainer's NOSTR pubkey",
    inputSchema: {
      type: "object",
      properties: {
        repo_url: {
          type: "string",
          description: "Repository URL",
        },
        package_name: {
          type: "string",
          description: "Package name (npm, cargo, pip, etc.)",
        },
      },
    },
  },
  {
    name: "get_reputation",
    description: "Get reputation stats for a pubkey",
    inputSchema: {
      type: "object",
      properties: {
        pubkey: {
          type: "string",
          description: "NOSTR pubkey (hex or npub)",
        },
      },
      required: ["pubkey"],
    },
  },
  {
    name: "get_my_identity",
    description: "Get this server's NOSTR identity",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];
```

---

## Phase 5: Background Services

### 5.1 Subscription Manager

**File: `src/services/nostr/subscriptions.ts`**

```typescript
export function setupSubscriptions(
  nostrClient: BountyNetNostrClient,
  walletService: WalletService,
  db: Database,
  config: Config
): void {
  const syncRepo = new SyncStateRepository(db);
  const reportsRepo = new ReportsRepository(db);
  const responsesRepo = new ResponsesRepository(db);
  const repRepo = new ReputationRepository(db);
  const blockedRepo = new BlockedRepository(db);
  
  // Get last sync time or default to 24 hours ago
  const lastSync = syncRepo.get("last_sync") ?? Math.floor(Date.now() / 1000) - 86400;
  
  // Reporter: Subscribe to responses for our sent reports
  if (config.reporter.enabled) {
    nostrClient.subscribeToResponses(lastSync, async (event, content) => {
      // Find the original report
      const report = reportsRepo.findById(content.report_id);
      if (!report || report.direction !== "sent") return;
      
      // Update report status based on response
      reportsRepo.updateStatus(report.id, content.response_type);
      
      // Store the response
      responsesRepo.create({
        id: uuid(),
        report_id: content.report_id,
        response_type: content.response_type,
        message: content.message,
        commit_hash: content.commit_hash,
        bounty_paid: content.bounty_paid ? parseInt(content.bounty_paid, 10) : undefined,
        responder_pubkey: event.pubkey,
        created_at: event.created_at * 1000,
        nostr_event_id: event.id,
      });
      
      console.log(`Response received for report ${content.report_id}: ${content.response_type}`);
    });
  }
  
  // Maintainer: Subscribe to incoming bug reports
  if (config.maintainer.enabled) {
    nostrClient.subscribeToReports(lastSync, async (event, content) => {
      // Check if sender is blocked
      if (blockedRepo.isBlocked(event.pubkey)) {
        console.log(`Ignored report from blocked sender: ${event.pubkey}`);
        return;
      }
      
      // Check for duplicate
      const existing = reportsRepo.findById(content.bug_id);
      if (existing) {
        console.log(`Duplicate report ignored: ${content.bug_id}`);
        return;
      }
      
      // Store the report
      reportsRepo.create({
        id: content.bug_id,
        repo_url: content.repo,
        file_path: content.file,
        line_start: content.line_start,
        line_end: content.line_end,
        description: content.description,
        suggested_fix: content.suggested_fix,
        severity: content.severity,
        category: content.category,
        agent_model: content.agent_model,
        agent_version: content.agent_version,
        sender_pubkey: event.pubkey,
        recipient_pubkey: nostrClient.getPublicKey(),
        deposit_tx: content.deposit_tx,
        deposit_amount: content.deposit_amount ? parseInt(content.deposit_amount, 10) : undefined,
        deposit_coin: COINS.ALPHA,
        status: "pending",
        direction: "received",
        created_at: event.created_at * 1000,
        updated_at: Date.now(),
        nostr_event_id: event.id,
      });
      
      // Update sender reputation stats
      repRepo.incrementTotal(event.pubkey);
      
      console.log(`New bug report received: ${content.bug_id} (${content.severity})`);
    });
  }
  
  // Periodically update sync state
  setInterval(() => {
    syncRepo.set("last_sync", Math.floor(Date.now() / 1000));
  }, 60000); // Every minute
}
```

---

### 5.2 Maintainer Discovery Service

**File: `src/services/discovery/maintainer.ts`**

```typescript
interface DiscoveryResult {
  pubkey: string;
  nametag?: string;
  source: "package_json" | "nip05" | "github" | "relay";
  verified: boolean;
}

export async function discoverMaintainer(
  repoUrl: string
): Promise<DiscoveryResult | null> {
  // Try methods in order of reliability
  
  // 1. Check package.json for nostr field
  const pkgResult = await tryPackageJson(repoUrl);
  if (pkgResult) return pkgResult;
  
  // 2. Try NIP-05 on repo domain
  const nip05Result = await tryNip05(repoUrl);
  if (nip05Result) return nip05Result;
  
  // 3. Try GitHub API to find owner
  const githubResult = await tryGitHub(repoUrl);
  if (githubResult) return githubResult;
  
  return null;
}

async function tryPackageJson(repoUrl: string): Promise<DiscoveryResult | null> {
  // Parse repo URL
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return null;
  
  const [, owner, repo] = match;
  
  // Try raw package.json from GitHub
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/main/package.json`
    );
    if (!response.ok) return null;
    
    const pkg = await response.json();
    
    // Check for nostr field
    if (pkg.nostr) {
      if (pkg.nostr.startsWith("npub")) {
        return {
          pubkey: npubToHex(pkg.nostr),
          source: "package_json",
          verified: true,
        };
      }
      // Could be a nametag
      // Resolve it
      const resolved = await resolveNametag(pkg.nostr);
      if (resolved) {
        return {
          pubkey: resolved,
          nametag: pkg.nostr,
          source: "package_json",
          verified: true,
        };
      }
    }
  } catch {
    // Ignore fetch errors
  }
  
  return null;
}

async function tryNip05(repoUrl: string): Promise<DiscoveryResult | null> {
  // Extract domain from GitHub pages or custom domain
  // Query .well-known/nostr.json
  // ... implementation
  return null;
}

async function tryGitHub(repoUrl: string): Promise<DiscoveryResult | null> {
  // Use GitHub API to get owner
  // Search NOSTR relays for profile with matching GitHub link
  // ... implementation
  return null;
}
```

---

### 5.3 Reputation Tracker

**File: `src/services/reputation/tracker.ts`**

```typescript
export interface ReputationStats {
  pubkey: string;
  totalReports: number;
  acceptedReports: number;
  rejectedReports: number;
  accuracyScore: number;
  depositTier: DepositTier;
}

export type DepositTier = "standard" | "reduced" | "minimal" | "trusted";

export function calculateDepositTier(stats: ReputationStats): DepositTier {
  // Trusted: manually whitelisted (handled separately)
  
  // Minimal: >90% accuracy, >50 reports
  if (stats.totalReports >= 50 && stats.accuracyScore >= 0.9) {
    return "minimal";
  }
  
  // Reduced: >80% accuracy, >10 reports
  if (stats.totalReports >= 10 && stats.accuracyScore >= 0.8) {
    return "reduced";
  }
  
  // Standard: everyone else
  return "standard";
}

export function getDepositMultiplier(tier: DepositTier): number {
  switch (tier) {
    case "trusted": return 0;
    case "minimal": return 0.1;
    case "reduced": return 0.5;
    case "standard": return 1.0;
  }
}

export class ReputationRepository {
  constructor(private db: DatabaseWrapper) {}
  
  getStats(pubkey: string): ReputationStats | null {
    const row = this.db.get<ReputationRow>(
      "SELECT * FROM reputation WHERE pubkey = ?",
      [pubkey]
    );
    
    if (!row) return null;
    
    const accuracy = row.total_reports > 0
      ? row.accepted_reports / row.total_reports
      : 0;
    
    return {
      pubkey: row.pubkey,
      totalReports: row.total_reports,
      acceptedReports: row.accepted_reports,
      rejectedReports: row.rejected_reports,
      accuracyScore: accuracy,
      depositTier: row.deposit_tier as DepositTier,
    };
  }
  
  incrementTotal(pubkey: string): void {
    this.db.run(`
      INSERT INTO reputation (pubkey, total_reports, last_report_at)
      VALUES (?, 1, ?)
      ON CONFLICT(pubkey) DO UPDATE SET
        total_reports = total_reports + 1,
        last_report_at = ?
    `, [pubkey, Date.now(), Date.now()]);
  }
  
  incrementAccepted(pubkey: string): void {
    this.db.run(
      "UPDATE reputation SET accepted_reports = accepted_reports + 1 WHERE pubkey = ?",
      [pubkey]
    );
    this.updateTier(pubkey);
  }
  
  incrementRejected(pubkey: string): void {
    this.db.run(
      "UPDATE reputation SET rejected_reports = rejected_reports + 1 WHERE pubkey = ?",
      [pubkey]
    );
    this.updateTier(pubkey);
  }
  
  private updateTier(pubkey: string): void {
    const stats = this.getStats(pubkey);
    if (!stats) return;
    
    const newTier = calculateDepositTier(stats);
    if (newTier !== stats.depositTier) {
      this.db.run(
        "UPDATE reputation SET deposit_tier = ? WHERE pubkey = ?",
        [newTier, pubkey]
      );
    }
  }
  
  setTrusted(pubkey: string, trusted: boolean): void {
    const tier = trusted ? "trusted" : "standard";
    this.db.run(`
      INSERT INTO reputation (pubkey, deposit_tier)
      VALUES (?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET deposit_tier = ?
    `, [pubkey, tier, tier]);
  }
}
```

---

## Phase 6: Configuration & CLI

### 6.1 Configuration System

**File: `src/config/loader.ts`**

```typescript
import fs from "fs";
import path from "path";
import os from "os";
import { ConfigSchema, type Config } from "../types/config";

const CONFIG_PATHS = [
  "./bounty-net.json",
  path.join(os.homedir(), ".bounty-net/config.json"),
  path.join(os.homedir(), ".config/bounty-net/config.json"),
];

export async function loadConfig(): Promise<Config> {
  // Find config file
  let configPath: string | null = null;
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      configPath = p;
      break;
    }
  }
  
  if (!configPath) {
    throw new Error(
      `Config file not found. Create one at: ${CONFIG_PATHS[0]}\n` +
      `See documentation for config format.`
    );
  }
  
  // Load and parse
  const raw = fs.readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw);
  
  // Interpolate environment variables
  const interpolated = interpolateEnv(json);
  
  // Validate with Zod
  const config = ConfigSchema.parse(interpolated);
  
  return config;
}

function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    // Handle env: prefix
    if (obj.startsWith("env:")) {
      const envVar = obj.slice(4);
      const value = process.env[envVar];
      if (!value) {
        throw new Error(`Environment variable not set: ${envVar}`);
      }
      return value;
    }
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnv);
  }
  
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnv(value);
    }
    return result;
  }
  
  return obj;
}
```

**Example Configuration:**

```json
{
  "identities": {
    "personal": {
      "privateKey": "env:BOUNTY_NET_PERSONAL_KEY",
      "nametag": "jamie"
    },
    "mylib": {
      "privateKey": "env:BOUNTY_NET_MYLIB_KEY",
      "nametag": "mylib-bugs"
    },
    "otherproject": {
      "privateKey": "env:BOUNTY_NET_OTHER_KEY",
      "nametag": "otherproject-inbox"
    }
  },
  "relays": [
    "wss://nostr-relay.testnet.unicity.network"
  ],
  "database": "~/.bounty-net/bounty-net.db",
  "reporter": {
    "enabled": true,
    "identity": "personal",
    "defaultDeposit": 100,
    "maxReportsPerHour": 10
  },
  "maintainer": {
    "enabled": true,
    "inboxes": [
      {
        "identity": "mylib",
        "repositories": ["https://github.com/jamie/mylib"],
        "bounties": {
          "critical": 1000,
          "high": 500,
          "medium": 100,
          "low": 50
        },
        "depositRequirements": {
          "default": 100,
          "critical": 200
        }
      },
      {
        "identity": "otherproject",
        "repositories": ["https://github.com/jamie/otherproject"],
        "bounties": {
          "high": 250
        }
      }
    ]
  }
}
```

**Identity Model:**
- **Personal identity** (`jamie`) - Used for submitting bug reports. Your reputation as a reporter is tied to this identity. Deposits are paid from this wallet.
- **Project identities** (`mylib-bugs`, `otherproject-inbox`) - Each project has its own inbox identity. Bounties are paid from the project's wallet. Multiple team members can share the same project key to access the same inbox.

---

### 6.2 CLI (Optional Enhancement)

**File: `src/cli.ts`**

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const program = new Command();

program
  .name("bounty-net")
  .description("Bounty-Net MCP Server CLI")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize configuration file")
  .option("-d, --dir <directory>", "Config directory", "~/.bounty-net")
  .action(async (options) => {
    const dir = options.dir.replace("~", os.homedir());
    fs.mkdirSync(dir, { recursive: true });
    
    const configPath = path.join(dir, "config.json");
    
    if (fs.existsSync(configPath)) {
      console.log("Config already exists at:", configPath);
      return;
    }
    
    const template = {
      identity: {
        privateKey: "env:BOUNTY_NET_PRIVATE_KEY",
        nametag: "",
      },
      relays: ["wss://nostr-relay.testnet.unicity.network"],
      database: path.join(dir, "bounty-net.db"),
      reporter: {
        enabled: true,
        defaultDeposit: 100,
      },
      maintainer: {
        enabled: false,
        repositories: [],
        bounties: {},
      },
    };
    
    fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
    console.log("Created config at:", configPath);
    console.log("\nNext steps:");
    console.log("1. Generate a private key: bounty-net keys generate");
    console.log("2. Set BOUNTY_NET_PRIVATE_KEY environment variable");
    console.log("3. Edit the config file to add your nametag and repositories");
  });

program
  .command("keys")
  .description("Key management")
  .command("generate")
  .description("Generate a new private key")
  .action(() => {
    const privateKey = randomBytes(32).toString("hex");
    console.log("Generated private key (keep this secret!):");
    console.log(privateKey);
    console.log("\nSet it as an environment variable:");
    console.log(`export BOUNTY_NET_PRIVATE_KEY="${privateKey}"`);
  });

program.parse();
```

---

## Phase 7: Testing

### 7.1 Unit Tests

```typescript
// tests/unit/types.test.ts
import { describe, it, expect } from "vitest";
import { BugReportContentSchema } from "../../src/types/events";

describe("BugReportContentSchema", () => {
  it("validates a complete report", () => {
    const report = {
      bug_id: "550e8400-e29b-41d4-a716-446655440000",
      repo: "https://github.com/org/lib",
      description: "Memory leak in parser module",
      severity: "high",
    };
    
    const result = BugReportContentSchema.safeParse(report);
    expect(result.success).toBe(true);
  });
  
  it("rejects invalid severity", () => {
    const report = {
      bug_id: "550e8400-e29b-41d4-a716-446655440000",
      repo: "https://github.com/org/lib",
      description: "Memory leak",
      severity: "super-critical", // invalid
    };
    
    const result = BugReportContentSchema.safeParse(report);
    expect(result.success).toBe(false);
  });
});
```

### 7.2 Integration Tests

```typescript
// tests/integration/nostr.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BountyNetNostrClient } from "../../src/services/nostr/client";

describe("NOSTR Client", () => {
  let client: BountyNetNostrClient;
  
  beforeAll(async () => {
    const testKey = "0".repeat(64); // Test key
    client = new BountyNetNostrClient(testKey);
    await client.connect(["wss://nostr-relay.testnet.unicity.network"]);
  });
  
  afterAll(() => {
    client.disconnect();
  });
  
  it("can register and resolve nametag", async () => {
    const nametag = `test-${Date.now()}`;
    const success = await client.registerNametag(nametag);
    expect(success).toBe(true);
    
    // Wait for propagation
    await new Promise((r) => setTimeout(r, 2000));
    
    const resolved = await client.resolveNametag(nametag);
    expect(resolved).toBe(client.getPublicKey());
  });
});
```

### 7.3 E2E Tests

```typescript
// tests/e2e/report-flow.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("Full Report Flow", () => {
  let reporterClient: BountyNetNostrClient;
  let maintainerClient: BountyNetNostrClient;
  
  beforeAll(async () => {
    // Set up two clients simulating reporter and maintainer
    // ...
  });
  
  it("complete flow: report -> accept -> refund", async () => {
    // 1. Reporter submits bug with deposit
    // 2. Maintainer receives report
    // 3. Maintainer accepts report
    // 4. Reporter receives refund + bounty
    // 5. Verify all database states
  });
});
```

---

## Milestones

**M1: Foundation**
- Project setup with TypeScript, build tools
- Type definitions and schemas
- Database layer with all tables (sql.js)
- Basic NOSTR client wrapper
- Identity manager with multi-identity support
- Wallet service for token operations

**M2: Daemon**
- PID file singleton management
- IPC server (Unix socket)
- NOSTR subscription sync for maintainer inboxes
- Command handlers (accept, reject, block, etc.)

**M3: CLI**
- CLI entry point with commander.js
- Daemon management commands (start, stop, status, logs)
- Identity and wallet commands
- Init command for config setup

**M4: MCP Server**
- IPC client for daemon communication
- Response backfill for reporter-only mode
- Reporter tools (report_bug, get_report_status, etc.)
- Maintainer tools with IPC routing
- Shared tools (get_balance, resolve_maintainer, etc.)

**M5: Background Services**
- Subscription manager
- Maintainer discovery service
- Reputation tracker

**M6: Configuration**
- Config loader with env variable interpolation
- Multi-identity configuration format
- Example configurations

**M7: Testing**
- Unit tests for all components
- Integration tests against testnet
- E2E tests for full flows
- Documentation and README

---

## Open Questions

1. **Token Balance Checking**: Does the Unicity SDK provide a way to check token balance, or do we need to track it ourselves from transfer events?

2. **Deposit Verification**: How do we verify that a deposit was actually sent? Do we need to wait for aggregator confirmation, or is the NOSTR event sufficient?

3. **Multi-Maintainer**: Should we support multiple maintainers per repo? Would require list of pubkeys and any-of-them can accept.

4. **Dispute Resolution**: What happens if reporter disagrees with rejection? Consider adding appeal mechanism in future.

5. **Rate Limiting**: Should rate limits be per-repo or global? Current design is global.
