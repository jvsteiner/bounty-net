import initSqlJs, { Database } from "sql.js";
import fs from "fs";
import path from "path";
import os from "os";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("database");

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

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
    logger.info(`Loading existing database from ${resolvedPath}`);
    const buffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(buffer);
  } else {
    logger.info(`Creating new database at ${resolvedPath}`);
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
  logger.debug(`Database saved to ${resolvedPath}`);
}

function runMigrations(db: Database): void {
  logger.info("Running database migrations");

  db.run(`
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
        CHECK (response_type IN ('acknowledged', 'accepted', 'rejected', 'fix_published')),
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
  `);

  logger.info("Database migrations complete");
}

// Helper to wrap db operations and auto-save
export class DatabaseWrapper {
  private saveInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private dbPath: string,
    private autoSaveInterval: number = 30000,
  ) {
    // Auto-save periodically
    this.saveInterval = setInterval(() => this.save(), this.autoSaveInterval);
  }

  run(sql: string, params?: unknown[]): void {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(params as (string | number | null | Uint8Array)[]);
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
    if (params) stmt.bind(params as (string | number | null | Uint8Array)[]);
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
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    this.save();
    this.db.close();
  }
}
