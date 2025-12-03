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

function runMigrations(db: Database.Database): void {
  getLogger().info("Running database migrations");

  const migrationSQL = `
    -- Bug reports
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
      recipient_pubkey TEXT NOT NULL,
      deposit_tx TEXT,
      deposit_amount INTEGER,
      deposit_coin TEXT,
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

    -- Transactions (deposits, refunds, bounty payments)
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      tx_hash TEXT,
      type TEXT NOT NULL CHECK (type IN ('deposit', 'refund', 'bounty')),
      amount INTEGER NOT NULL,
      coin_id TEXT NOT NULL,
      sender_pubkey TEXT NOT NULL,
      recipient_pubkey TEXT NOT NULL,
      related_report_id TEXT,
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
  `;

  db.exec(migrationSQL);

  // Versioned migrations - each runs once, tracked by version number
  // ADD NEW MIGRATIONS TO THE END OF THIS ARRAY
  const migrations: { version: number; sql: string; description: string }[] = [
    {
      version: 1,
      description: "Add sender_nametag column",
      sql: "ALTER TABLE bug_reports ADD COLUMN sender_nametag TEXT",
    },
    {
      version: 2,
      description: "Remove direction column and merge duplicate self-reports",
      sql: `
        -- SQLite doesn't support DROP COLUMN directly, so we rebuild the table
        -- First, update responses pointing to -received IDs to point to original
        UPDATE report_responses
          SET report_id = REPLACE(report_id, '-received', '')
          WHERE report_id LIKE '%-received';

        -- Delete duplicate -received rows (keep original ID only)
        DELETE FROM bug_reports WHERE id LIKE '%-received';

        -- Create new table without direction column
        CREATE TABLE bug_reports_new (
          id TEXT PRIMARY KEY,
          repo_url TEXT NOT NULL,
          file_path TEXT,
          description TEXT NOT NULL,
          suggested_fix TEXT,
          agent_model TEXT,
          agent_version TEXT,
          sender_pubkey TEXT NOT NULL,
          sender_nametag TEXT,
          recipient_pubkey TEXT NOT NULL,
          deposit_tx TEXT,
          deposit_amount INTEGER,
          deposit_coin TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'accepted', 'rejected', 'completed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          nostr_event_id TEXT
        );

        -- Copy data (excluding direction)
        INSERT INTO bug_reports_new
          SELECT id, repo_url, file_path, description, suggested_fix,
                 agent_model, agent_version, sender_pubkey, sender_nametag,
                 recipient_pubkey, deposit_tx, deposit_amount, deposit_coin,
                 status, created_at, updated_at, nostr_event_id
          FROM bug_reports;

        -- Drop old table and rename
        DROP TABLE bug_reports;
        ALTER TABLE bug_reports_new RENAME TO bug_reports;

        -- Recreate indexes
        CREATE INDEX idx_reports_repo ON bug_reports(repo_url);
        CREATE INDEX idx_reports_status ON bug_reports(status);
        CREATE INDEX idx_reports_sender ON bug_reports(sender_pubkey);
        CREATE INDEX idx_reports_recipient ON bug_reports(recipient_pubkey);
      `,
    },
    // Add new migrations here with incrementing version numbers
  ];

  // Get current schema version
  const versionRow = db
    .prepare("SELECT value FROM sync_state WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  let currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  // Run pending migrations
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      try {
        getLogger().info(
          `Running migration ${migration.version}: ${migration.description}`,
        );
        db.exec(migration.sql);
        currentVersion = migration.version;
        // Update schema version
        db.prepare(
          "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('schema_version', ?, ?)",
        ).run(String(currentVersion), Date.now());
      } catch (e) {
        // Ignore "duplicate column" errors (migration already applied)
        if (e instanceof Error && e.message.includes("duplicate column")) {
          getLogger().debug(
            `Migration ${migration.version} already applied (duplicate column)`,
          );
          // Still update version so we don't retry
          db.prepare(
            "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('schema_version', ?, ?)",
          ).run(String(migration.version), Date.now());
          currentVersion = migration.version;
        } else {
          throw e;
        }
      }
    }
  }

  getLogger().info(
    `Database migrations complete (schema version: ${currentVersion})`,
  );
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
