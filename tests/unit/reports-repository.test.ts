import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DatabaseWrapper } from "../../src/storage/database.js";
import { ReportsRepository } from "../../src/storage/repositories/reports.js";
import type { InsertReport } from "../../src/types/reports.js";

describe("ReportsRepository", () => {
  let db: Database.Database;
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
      description: "Test bug description",
      suggested_fix: "Fix the bug",
      agent_model: "claude-3",
      agent_version: "1.0.0",
      sender_pubkey: "sender123",
      recipient_pubkey: "recipient456",
      status: "pending",
      created_at: Date.now(),
      updated_at: Date.now(),
      nostr_event_id: `event-${uniqueId}`,
      ...overrides,
    };
  };

  beforeEach(() => {
    db = new Database(":memory:");

    // Create the bug_reports table (matches current schema)
    db.exec(`
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
        nostr_event_id TEXT UNIQUE
      )
    `);

    wrapper = new DatabaseWrapper(db);
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
        suggested_fix: undefined,
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

  describe("listByRecipient()", () => {
    const recipientPubkey = "recipient456";

    beforeEach(() => {
      // Create multiple reports for recipient
      repo.create(
        createTestReport({
          id: "received-1",
          recipient_pubkey: recipientPubkey,
          status: "pending",
          repo_url: "https://github.com/test/repo-a",
          created_at: 1000,
        }),
      );
      repo.create(
        createTestReport({
          id: "received-2",
          recipient_pubkey: recipientPubkey,
          status: "accepted",
          repo_url: "https://github.com/test/repo-b",
          created_at: 2000,
        }),
      );
      repo.create(
        createTestReport({
          id: "received-3",
          recipient_pubkey: recipientPubkey,
          status: "pending",
          repo_url: "https://github.com/test/repo-a",
          created_at: 3000,
        }),
      );
      // Different recipient
      repo.create(
        createTestReport({
          id: "other-1",
          recipient_pubkey: "other-recipient",
          status: "pending",
          created_at: 4000,
        }),
      );
    });

    it("should list only reports for the specified recipient", () => {
      const reports = repo.listByRecipient(recipientPubkey, {});
      expect(reports).toHaveLength(3);
      expect(reports.every((r) => r.recipient_pubkey === recipientPubkey)).toBe(true);
    });

    it("should filter by status", () => {
      const reports = repo.listByRecipient(recipientPubkey, { status: "pending" });
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.status === "pending")).toBe(true);
    });

    it("should filter by repo", () => {
      const reports = repo.listByRecipient(recipientPubkey, { repo: "repo-a" });
      expect(reports).toHaveLength(2);
    });

    it("should respect limit", () => {
      const reports = repo.listByRecipient(recipientPubkey, { limit: 2 });
      expect(reports).toHaveLength(2);
    });

    it("should respect offset", () => {
      const reports = repo.listByRecipient(recipientPubkey, { limit: 10, offset: 2 });
      expect(reports).toHaveLength(1);
    });

    it("should order by created_at DESC", () => {
      const reports = repo.listByRecipient(recipientPubkey, {});
      expect(reports[0].created_at).toBeGreaterThan(reports[1].created_at);
      expect(reports[1].created_at).toBeGreaterThan(reports[2].created_at);
    });
  });

  describe("listBySender()", () => {
    const senderPubkey = "sender123";

    beforeEach(() => {
      repo.create(
        createTestReport({
          id: "sent-1",
          sender_pubkey: senderPubkey,
          status: "pending",
          created_at: 1000,
        }),
      );
      repo.create(
        createTestReport({
          id: "sent-2",
          sender_pubkey: senderPubkey,
          status: "accepted",
          created_at: 2000,
        }),
      );
      repo.create(
        createTestReport({
          id: "other-1",
          sender_pubkey: "other-sender",
          status: "pending",
          created_at: 3000,
        }),
      );
    });

    it("should list only reports from the specified sender", () => {
      const reports = repo.listBySender(senderPubkey, {});
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.sender_pubkey === senderPubkey)).toBe(true);
    });

    it("should filter by status", () => {
      const reports = repo.listBySender(senderPubkey, { status: "pending" });
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
          status: "pending",
        }),
      );
      repo.create(
        createTestReport({
          id: "count-2",
          recipient_pubkey: recipientPubkey,
          status: "pending",
        }),
      );
      repo.create(
        createTestReport({
          id: "count-3",
          recipient_pubkey: recipientPubkey,
          status: "accepted",
        }),
      );
      // Different recipient
      repo.create(
        createTestReport({
          id: "count-4",
          recipient_pubkey: "other-maintainer",
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
