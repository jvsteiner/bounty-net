import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "../utils/logger.js";

// Lazy logger to respect LOG_LEVEL set at runtime
const getLogger = () => createLogger("database");

export function initializeDatabase(dbPath: string): Database.Database {
  const resolvedPath = dbPath.replace("~", os.homedir());
  const dir = path.dirname(resolvedPath);

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  const isNew = !fs.existsSync(resolvedPath);

  if (isNew) {
    getLogger().info(`Creating new database at ${resolvedPath}`);
  } else {
    getLogger().info(`Loading existing database from ${resolvedPath}`);
  }

  // Open database (creates if doesn't exist)
  const db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent access
  db.pragma("journal_mode = WAL");

  // Enable foreign keys
  db.pragma("foreign_keys = ON");

  // Run migrations
  runMigrations(db);

  return db;
}

/**
 * Open an existing database without running migrations.
 * Use this for read-only clients like the MCP server that shouldn't create/modify schema.
 * Throws if database doesn't exist.
 */
export function openDatabase(dbPath: string): Database.Database {
  const resolvedPath = dbPath.replace("~", os.homedir());

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Database not found: ${resolvedPath}. Start the daemon first to create it.`,
    );
  }

  getLogger().info(`Opening existing database at ${resolvedPath}`);

  const db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent access
  db.pragma("journal_mode = WAL");

  // Enable foreign keys
  db.pragma("foreign_keys = ON");

  return db;
}

function runMigrations(db: Database.Database): void {
  getLogger().info("Initializing database schema");

  // Check if we need to add sender_wallet_pubkey column to existing table
  const hasWalletPubkeyColumn = db
    .prepare("PRAGMA table_info(bug_reports)")
    .all()
    .some((col: { name: string }) => col.name === "sender_wallet_pubkey");

  const schema = `
    -- Bug reports (tokens on disk are source of truth for payments)
    CREATE TABLE IF NOT EXISTS bug_reports (
      id TEXT PRIMARY KEY,
      repo_url TEXT NOT NULL,
      file_path TEXT,
      description TEXT NOT NULL,
      suggested_fix TEXT,
      agent_model TEXT,
      agent_version TEXT,
      sender_pubkey TEXT NOT NULL,
      sender_nametag TEXT,
      sender_wallet_pubkey TEXT,
      recipient_pubkey TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      nostr_event_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reports_repo ON bug_reports(repo_url);
    CREATE INDEX IF NOT EXISTS idx_reports_status ON bug_reports(status);
    CREATE INDEX IF NOT EXISTS idx_reports_sender ON bug_reports(sender_pubkey);
    CREATE INDEX IF NOT EXISTS idx_reports_recipient ON bug_reports(recipient_pubkey);

    -- Report responses
    CREATE TABLE IF NOT EXISTS report_responses (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      response_type TEXT NOT NULL
        CHECK (response_type IN ('acknowledged', 'accepted', 'rejected', 'fix_published')),
      message TEXT,
      commit_hash TEXT,
      responder_pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      nostr_event_id TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_responses_report ON report_responses(report_id);

    -- Bounties (set by maintainer)
    CREATE TABLE IF NOT EXISTS bounties (
      id TEXT PRIMARY KEY,
      repo_url TEXT NOT NULL,
      amount INTEGER NOT NULL,
      coin_id TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'claimed', 'expired', 'cancelled')),
      created_by TEXT NOT NULL,
      claimed_by TEXT,
      claimed_report_id TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      nostr_event_id TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_bounties_repo ON bounties(repo_url);
    CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);

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
  `;

  db.exec(schema);

  // Add sender_wallet_pubkey column if it doesn't exist (migration for existing DBs)
  if (!hasWalletPubkeyColumn) {
    try {
      db.exec(
        "ALTER TABLE bug_reports ADD COLUMN sender_wallet_pubkey TEXT",
      );
      getLogger().info("Added sender_wallet_pubkey column to bug_reports");
    } catch {
      // Column might not exist yet if table was just created, that's fine
    }
  }

  getLogger().info("Database schema initialized");
}

/**
 * DatabaseWrapper provides a consistent interface for database operations.
 * With better-sqlite3, all operations are synchronous and write directly to disk.
 * No manual save() calls needed.
 */
export class DatabaseWrapper {
  constructor(private db: Database.Database) {}

  run(sql: string, params?: unknown[]): Database.RunResult {
    const stmt = this.db.prepare(sql);
    return stmt.run(...(params ?? []));
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params ?? [])) as T | undefined;
  }

  all<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params ?? [])) as T[];
  }

  /**
   * @deprecated No longer needed with better-sqlite3 - writes are immediate
   */
  save(): void {
    // No-op: better-sqlite3 writes directly to disk
  }

  close(): void {
    this.db.close();
  }

  /**
   * Get the underlying better-sqlite3 database instance
   */
  getDb(): Database.Database {
    return this.db;
  }
}
