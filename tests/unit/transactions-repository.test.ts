import { describe, it, expect, beforeEach, afterEach } from "vitest";
import initSqlJs, { Database } from "sql.js";
import { DatabaseWrapper } from "../../src/storage/database.js";
import { TransactionsRepository } from "../../src/storage/repositories/transactions.js";
import type { InsertTransaction, TransactionStatus } from "../../src/types/payments.js";

describe("TransactionsRepository", () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;
  let db: Database;
  let wrapper: DatabaseWrapper;
  let repo: TransactionsRepository;

  const createTestTransaction = (
    overrides: Partial<InsertTransaction> = {}
  ): InsertTransaction => ({
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tx_hash: `hash-${Date.now()}`,
    type: "deposit",
    amount: 100,
    coin_id: "ALPHA",
    sender_pubkey: "sender123",
    recipient_pubkey: "recipient456",
    related_report_id: "report123",
    status: "pending",
    created_at: Date.now(),
    confirmed_at: undefined,
    ...overrides,
  });

  beforeEach(async () => {
    SQL = await initSqlJs();
    db = new SQL.Database();

    db.run(`
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
      )
    `);

    wrapper = new DatabaseWrapper(db, "/tmp/test-bounty-net.db", 999999);
    repo = new TransactionsRepository(wrapper);
  });

  afterEach(() => {
    wrapper.close();
  });

  describe("create()", () => {
    it("should insert a new transaction", () => {
      const tx = createTestTransaction({ id: "tx-1" });
      repo.create(tx);

      const found = repo.findById("tx-1");
      expect(found).toBeDefined();
      expect(found?.id).toBe("tx-1");
      expect(found?.type).toBe("deposit");
      expect(found?.amount).toBe(100);
    });

    it("should handle null optional fields", () => {
      const tx = createTestTransaction({
        id: "tx-2",
        tx_hash: undefined,
        related_report_id: undefined,
        confirmed_at: undefined,
      });
      repo.create(tx);

      const found = repo.findById("tx-2");
      expect(found).toBeDefined();
      expect(found?.tx_hash).toBeNull();
      expect(found?.related_report_id).toBeNull();
    });
  });

  describe("findById()", () => {
    it("should find a transaction by ID", () => {
      const tx = createTestTransaction({ id: "find-test" });
      repo.create(tx);

      const found = repo.findById("find-test");
      expect(found).toBeDefined();
      expect(found?.id).toBe("find-test");
    });

    it("should return undefined for non-existent ID", () => {
      const found = repo.findById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("findByReportId()", () => {
    beforeEach(() => {
      repo.create(createTestTransaction({
        id: "tx-1",
        related_report_id: "report-a",
        type: "deposit",
        created_at: 1000,
      }));
      repo.create(createTestTransaction({
        id: "tx-2",
        related_report_id: "report-a",
        type: "refund",
        created_at: 2000,
      }));
      repo.create(createTestTransaction({
        id: "tx-3",
        related_report_id: "report-b",
        type: "bounty",
        created_at: 3000,
      }));
    });

    it("should find all transactions for a report", () => {
      const txs = repo.findByReportId("report-a");
      expect(txs).toHaveLength(2);
    });

    it("should order by created_at DESC", () => {
      const txs = repo.findByReportId("report-a");
      expect(txs[0].id).toBe("tx-2");
      expect(txs[1].id).toBe("tx-1");
    });

    it("should return empty array for non-existent report", () => {
      const txs = repo.findByReportId("nonexistent");
      expect(txs).toEqual([]);
    });
  });

  describe("findByTxHash()", () => {
    it("should find a transaction by hash", () => {
      const tx = createTestTransaction({
        id: "hash-test",
        tx_hash: "unique-hash-123",
      });
      repo.create(tx);

      const found = repo.findByTxHash("unique-hash-123");
      expect(found).toBeDefined();
      expect(found?.id).toBe("hash-test");
    });

    it("should return undefined for non-existent hash", () => {
      const found = repo.findByTxHash("nonexistent-hash");
      expect(found).toBeUndefined();
    });
  });

  describe("updateStatus()", () => {
    it("should update status to confirmed", () => {
      const tx = createTestTransaction({ id: "status-test", status: "pending" });
      repo.create(tx);

      repo.updateStatus("status-test", "confirmed");

      const found = repo.findById("status-test");
      expect(found?.status).toBe("confirmed");
      expect(found?.confirmed_at).toBeDefined();
      expect(found?.confirmed_at).toBeGreaterThan(0);
    });

    it("should update status to failed without confirmed_at", () => {
      const tx = createTestTransaction({ id: "failed-test", status: "pending" });
      repo.create(tx);

      repo.updateStatus("failed-test", "failed");

      const found = repo.findById("failed-test");
      expect(found?.status).toBe("failed");
      expect(found?.confirmed_at).toBeNull();
    });
  });
});
