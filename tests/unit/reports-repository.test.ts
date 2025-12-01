import { describe, it, expect, beforeEach, afterEach } from "vitest";
import initSqlJs, { Database } from "sql.js";
import { DatabaseWrapper } from "../../src/storage/database.js";
import { ReportsRepository } from "../../src/storage/repositories/reports.js";
import type {
  InsertReport,
  Report,
  ReportStatus,
} from "../../src/types/reports.js";

describe("ReportsRepository", () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;
  let db: Database;
  let wrapper: DatabaseWrapper;
  let repo: ReportsRepository;

  let reportCounter = 0;
  const createTestReport = (
    overrides: Partial<InsertReport> = {},
  ): InsertReport => {
    const uniqueId = `${Date.now()}-${++reportCounter}-${Math.random().toString(36).slice(2)}`;
    return {
      id: `report-${uniqueId}`,
      repo_url: "https://github.com/test/repo",
      file_path: "src/index.ts",
      line_start: 10,
      line_end: 15,
      description: "Test bug description",
      suggested_fix: "Fix the bug",
      severity: "medium",
      category: "security",
      agent_model: "claude-3",
      agent_version: "1.0.0",
      sender_pubkey: "sender123",
      recipient_pubkey: "recipient456",
      deposit_tx: "tx123",
      deposit_amount: 100,
      deposit_coin: "ALPHA",
      status: "pending",
      direction: "received",
      created_at: Date.now(),
      updated_at: Date.now(),
      nostr_event_id: `event-${uniqueId}`,
      ...overrides,
    };
  };

  beforeEach(async () => {
    SQL = await initSqlJs();
    db = new SQL.Database();

    // Create the bug_reports table
    db.run(`
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
      )
    `);

    wrapper = new DatabaseWrapper(db, "/tmp/test-bounty-net.db", 999999);
    repo = new ReportsRepository(wrapper);
  });

  afterEach(() => {
    wrapper.close();
  });

  describe("create()", () => {
    it("should insert a new report", () => {
      const report = createTestReport({ id: "test-report-1" });
      repo.create(report);

      const found = repo.findById("test-report-1");
      expect(found).toBeDefined();
      expect(found?.id).toBe("test-report-1");
      expect(found?.description).toBe("Test bug description");
    });

    it("should handle null optional fields", () => {
      const report = createTestReport({
        id: "test-report-2",
        file_path: undefined,
        line_start: undefined,
        line_end: undefined,
        suggested_fix: undefined,
        category: undefined,
        deposit_tx: undefined,
        nostr_event_id: undefined,
      });
      repo.create(report);

      const found = repo.findById("test-report-2");
      expect(found).toBeDefined();
      expect(found?.file_path).toBeNull();
      expect(found?.suggested_fix).toBeNull();
    });
  });

  describe("findById()", () => {
    it("should find a report by ID", () => {
      const report = createTestReport({ id: "find-by-id-test" });
      repo.create(report);

      const found = repo.findById("find-by-id-test");
      expect(found).toBeDefined();
      expect(found?.id).toBe("find-by-id-test");
    });

    it("should return undefined for non-existent ID", () => {
      const found = repo.findById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("findByEventId()", () => {
    it("should find a report by NOSTR event ID", () => {
      const report = createTestReport({
        id: "event-id-test",
        nostr_event_id: "nostr-event-abc123",
      });
      repo.create(report);

      const found = repo.findByEventId("nostr-event-abc123");
      expect(found).toBeDefined();
      expect(found?.id).toBe("event-id-test");
    });

    it("should return undefined for non-existent event ID", () => {
      const found = repo.findByEventId("nonexistent-event");
      expect(found).toBeUndefined();
    });
  });

  describe("listReceived()", () => {
    beforeEach(() => {
      // Create multiple received reports
      repo.create(
        createTestReport({
          id: "received-1",
          direction: "received",
          status: "pending",
          severity: "high",
          repo_url: "https://github.com/test/repo-a",
          created_at: 1000,
        }),
      );
      repo.create(
        createTestReport({
          id: "received-2",
          direction: "received",
          status: "accepted",
          severity: "medium",
          repo_url: "https://github.com/test/repo-b",
          created_at: 2000,
        }),
      );
      repo.create(
        createTestReport({
          id: "received-3",
          direction: "received",
          status: "pending",
          severity: "low",
          repo_url: "https://github.com/test/repo-a",
          created_at: 3000,
        }),
      );
      // Also create a sent report to ensure it's not included
      repo.create(
        createTestReport({
          id: "sent-1",
          direction: "sent",
          status: "pending",
          created_at: 4000,
        }),
      );
    });

    it("should list only received reports", () => {
      const reports = repo.listReceived({});
      expect(reports).toHaveLength(3);
      expect(reports.every((r) => r.direction === "received")).toBe(true);
    });

    it("should filter by status", () => {
      const reports = repo.listReceived({ status: "pending" });
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.status === "pending")).toBe(true);
    });

    it("should filter by severity", () => {
      const reports = repo.listReceived({ severity: "high" });
      expect(reports).toHaveLength(1);
      expect(reports[0].id).toBe("received-1");
    });

    it("should filter by repo", () => {
      const reports = repo.listReceived({ repo: "repo-a" });
      expect(reports).toHaveLength(2);
    });

    it("should respect limit", () => {
      const reports = repo.listReceived({ limit: 2 });
      expect(reports).toHaveLength(2);
    });

    it("should respect offset", () => {
      const reports = repo.listReceived({ limit: 10, offset: 2 });
      expect(reports).toHaveLength(1);
    });

    it("should order by created_at DESC", () => {
      const reports = repo.listReceived({});
      expect(reports[0].created_at).toBeGreaterThan(reports[1].created_at);
      expect(reports[1].created_at).toBeGreaterThan(reports[2].created_at);
    });
  });

  describe("listSent()", () => {
    beforeEach(() => {
      repo.create(
        createTestReport({
          id: "sent-1",
          direction: "sent",
          status: "pending",
          created_at: 1000,
        }),
      );
      repo.create(
        createTestReport({
          id: "sent-2",
          direction: "sent",
          status: "accepted",
          created_at: 2000,
        }),
      );
      repo.create(
        createTestReport({
          id: "received-1",
          direction: "received",
          status: "pending",
          created_at: 3000,
        }),
      );
    });

    it("should list only sent reports", () => {
      const reports = repo.listSent({});
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.direction === "sent")).toBe(true);
    });

    it("should filter by status", () => {
      const reports = repo.listSent({ status: "pending" });
      expect(reports).toHaveLength(1);
      expect(reports[0].id).toBe("sent-1");
    });
  });

  describe("updateStatus()", () => {
    it("should update the status of a report", () => {
      const report = createTestReport({ id: "status-test", status: "pending" });
      repo.create(report);

      repo.updateStatus("status-test", "accepted");

      const found = repo.findById("status-test");
      expect(found?.status).toBe("accepted");
    });

    it("should update the updated_at timestamp", () => {
      const originalTime = Date.now() - 10000;
      const report = createTestReport({
        id: "timestamp-test",
        status: "pending",
        updated_at: originalTime,
      });
      repo.create(report);

      repo.updateStatus("timestamp-test", "rejected");

      const found = repo.findById("timestamp-test");
      expect(found?.updated_at).toBeGreaterThan(originalTime);
    });
  });

  describe("search()", () => {
    beforeEach(() => {
      repo.create(
        createTestReport({
          id: "search-1",
          description: "Memory leak in user authentication module",
        }),
      );
      repo.create(
        createTestReport({
          id: "search-2",
          description: "SQL injection vulnerability in login form",
        }),
      );
      repo.create(
        createTestReport({
          id: "search-3",
          description: "Race condition in payment processing",
        }),
      );
    });

    it("should find reports matching the query", () => {
      const reports = repo.search("authentication", {});
      expect(reports).toHaveLength(1);
      expect(reports[0].id).toBe("search-1");
    });

    it("should be case-insensitive", () => {
      const reports = repo.search("MEMORY", {});
      expect(reports).toHaveLength(1);
    });

    it("should match partial words", () => {
      const reports = repo.search("inject", {});
      expect(reports).toHaveLength(1);
      expect(reports[0].id).toBe("search-2");
    });

    it("should respect limit", () => {
      const reports = repo.search("in", { limit: 1 });
      expect(reports).toHaveLength(1);
    });
  });

  describe("countByStatus()", () => {
    beforeEach(() => {
      const recipientPubkey = "maintainer-pubkey-123";
      repo.create(
        createTestReport({
          id: "count-1",
          recipient_pubkey: recipientPubkey,
          direction: "received",
          status: "pending",
        }),
      );
      repo.create(
        createTestReport({
          id: "count-2",
          recipient_pubkey: recipientPubkey,
          direction: "received",
          status: "pending",
        }),
      );
      repo.create(
        createTestReport({
          id: "count-3",
          recipient_pubkey: recipientPubkey,
          direction: "received",
          status: "accepted",
        }),
      );
      // Different recipient
      repo.create(
        createTestReport({
          id: "count-4",
          recipient_pubkey: "other-maintainer",
          direction: "received",
          status: "pending",
        }),
      );
      // Sent report (should not count)
      repo.create(
        createTestReport({
          id: "count-5",
          recipient_pubkey: recipientPubkey,
          direction: "sent",
          status: "pending",
        }),
      );
    });

    it("should count reports by status for a specific recipient", () => {
      const count = repo.countByStatus("maintainer-pubkey-123", "pending");
      expect(count).toBe(2);
    });

    it("should return 0 for non-existent recipient", () => {
      const count = repo.countByStatus("nonexistent", "pending");
      expect(count).toBe(0);
    });

    it("should count different statuses correctly", () => {
      const pendingCount = repo.countByStatus(
        "maintainer-pubkey-123",
        "pending",
      );
      const acceptedCount = repo.countByStatus(
        "maintainer-pubkey-123",
        "accepted",
      );
      expect(pendingCount).toBe(2);
      expect(acceptedCount).toBe(1);
    });
  });
});
