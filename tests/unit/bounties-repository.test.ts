import { describe, it, expect, beforeEach, afterEach } from "vitest";
import initSqlJs, { Database } from "sql.js";
import { DatabaseWrapper } from "../../src/storage/database.js";
import { BountiesRepository } from "../../src/storage/repositories/bounties.js";
import type { InsertBounty, BountyStatus } from "../../src/types/payments.js";
import type { Severity } from "../../src/types/events.js";

describe("BountiesRepository", () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;
  let db: Database;
  let wrapper: DatabaseWrapper;
  let repo: BountiesRepository;

  const createTestBounty = (
    overrides: Partial<InsertBounty> = {}
  ): InsertBounty => ({
    id: `bounty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    repo_url: "https://github.com/test/repo",
    severity: "high",
    amount: 500,
    coin_id: "ALPHA",
    description: "Test bounty description",
    status: "available",
    created_by: "maintainer123",
    claimed_by: undefined,
    claimed_report_id: undefined,
    expires_at: undefined,
    created_at: Date.now(),
    updated_at: Date.now(),
    nostr_event_id: undefined,
    ...overrides,
  });

  beforeEach(async () => {
    SQL = await initSqlJs();
    db = new SQL.Database();

    db.run(`
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
        claimed_report_id TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        nostr_event_id TEXT UNIQUE
      )
    `);

    wrapper = new DatabaseWrapper(db, "/tmp/test-bounty-net.db", 999999);
    repo = new BountiesRepository(wrapper);
  });

  afterEach(() => {
    wrapper.close();
  });

  describe("create()", () => {
    it("should insert a new bounty", () => {
      const bounty = createTestBounty({ id: "bounty-1" });
      repo.create(bounty);

      const found = repo.findById("bounty-1");
      expect(found).toBeDefined();
      expect(found?.id).toBe("bounty-1");
      expect(found?.amount).toBe(500);
    });

    it("should handle null severity for general bounties", () => {
      const bounty = createTestBounty({
        id: "bounty-general",
        severity: undefined,
      });
      repo.create(bounty);

      const found = repo.findById("bounty-general");
      expect(found).toBeDefined();
      expect(found?.severity).toBeNull();
    });
  });

  describe("findById()", () => {
    it("should find a bounty by ID", () => {
      const bounty = createTestBounty({ id: "find-test" });
      repo.create(bounty);

      const found = repo.findById("find-test");
      expect(found).toBeDefined();
      expect(found?.id).toBe("find-test");
    });

    it("should return undefined for non-existent ID", () => {
      const found = repo.findById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("findAvailable()", () => {
    const futureTime = Date.now() + 86400000; // 1 day from now
    const pastTime = Date.now() - 86400000; // 1 day ago

    beforeEach(() => {
      // High severity bounty for repo-a
      repo.create(createTestBounty({
        id: "bounty-high",
        repo_url: "https://github.com/test/repo-a",
        severity: "high",
        amount: 500,
        status: "available",
        expires_at: futureTime,
      }));
      // Critical severity bounty for repo-a
      repo.create(createTestBounty({
        id: "bounty-critical",
        repo_url: "https://github.com/test/repo-a",
        severity: "critical",
        amount: 1000,
        status: "available",
      }));
      // General bounty (no severity) for repo-a
      repo.create(createTestBounty({
        id: "bounty-general",
        repo_url: "https://github.com/test/repo-a",
        severity: undefined,
        amount: 200,
        status: "available",
      }));
      // Claimed bounty (should not be found)
      repo.create(createTestBounty({
        id: "bounty-claimed",
        repo_url: "https://github.com/test/repo-a",
        severity: "high",
        amount: 300,
        status: "claimed",
      }));
      // Expired bounty (should not be found)
      repo.create(createTestBounty({
        id: "bounty-expired",
        repo_url: "https://github.com/test/repo-a",
        severity: "medium",
        amount: 400,
        status: "available",
        expires_at: pastTime,
      }));
    });

    it("should find bounty matching exact severity", () => {
      const found = repo.findAvailable(
        "https://github.com/test/repo-a",
        "high"
      );
      expect(found).toBeDefined();
      expect(found?.id).toBe("bounty-high");
    });

    it("should fall back to general bounty if severity not found", () => {
      const found = repo.findAvailable(
        "https://github.com/test/repo-a",
        "low"
      );
      expect(found).toBeDefined();
      expect(found?.id).toBe("bounty-general");
    });

    it("should not return claimed bounties", () => {
      // All high bounties except the claimed one
      const found = repo.findAvailable(
        "https://github.com/test/repo-a",
        "high"
      );
      expect(found?.id).not.toBe("bounty-claimed");
    });

    it("should not return expired bounties", () => {
      const found = repo.findAvailable(
        "https://github.com/test/repo-a",
        "medium"
      );
      // Should fall back to general since medium is expired
      expect(found?.id).toBe("bounty-general");
    });

    it("should return undefined for non-existent repo", () => {
      const found = repo.findAvailable("https://github.com/other/repo", "high");
      expect(found).toBeUndefined();
    });
  });

  describe("listByRepo()", () => {
    beforeEach(() => {
      repo.create(createTestBounty({
        id: "bounty-1",
        repo_url: "https://github.com/test/repo-a",
        created_at: 1000,
      }));
      repo.create(createTestBounty({
        id: "bounty-2",
        repo_url: "https://github.com/test/repo-a",
        created_at: 2000,
      }));
      repo.create(createTestBounty({
        id: "bounty-3",
        repo_url: "https://github.com/test/repo-b",
        created_at: 3000,
      }));
    });

    it("should find bounties by repo URL", () => {
      const bounties = repo.listByRepo("repo-a");
      expect(bounties).toHaveLength(2);
    });

    it("should order by created_at DESC", () => {
      const bounties = repo.listByRepo("repo-a");
      expect(bounties[0].id).toBe("bounty-2");
      expect(bounties[1].id).toBe("bounty-1");
    });

    it("should match partial repo URLs", () => {
      const bounties = repo.listByRepo("github.com/test");
      expect(bounties).toHaveLength(3);
    });
  });

  describe("listByCreator()", () => {
    beforeEach(() => {
      repo.create(createTestBounty({
        id: "bounty-1",
        created_by: "maintainer-a",
        created_at: 1000,
      }));
      repo.create(createTestBounty({
        id: "bounty-2",
        created_by: "maintainer-a",
        created_at: 2000,
      }));
      repo.create(createTestBounty({
        id: "bounty-3",
        created_by: "maintainer-b",
        created_at: 3000,
      }));
    });

    it("should find bounties by creator pubkey", () => {
      const bounties = repo.listByCreator("maintainer-a");
      expect(bounties).toHaveLength(2);
    });

    it("should return empty for non-existent creator", () => {
      const bounties = repo.listByCreator("nonexistent");
      expect(bounties).toEqual([]);
    });
  });

  describe("markClaimed()", () => {
    it("should mark a bounty as claimed", () => {
      const bounty = createTestBounty({
        id: "claim-test",
        status: "available",
      });
      repo.create(bounty);

      repo.markClaimed("claim-test", "reporter-pubkey", "report-123");

      const found = repo.findById("claim-test");
      expect(found?.status).toBe("claimed");
      expect(found?.claimed_by).toBe("reporter-pubkey");
      expect(found?.claimed_report_id).toBe("report-123");
    });

    it("should update the updated_at timestamp", () => {
      const originalTime = Date.now() - 10000;
      const bounty = createTestBounty({
        id: "timestamp-test",
        updated_at: originalTime,
      });
      repo.create(bounty);

      repo.markClaimed("timestamp-test", "reporter", "report-1");

      const found = repo.findById("timestamp-test");
      expect(found?.updated_at).toBeGreaterThan(originalTime);
    });
  });

  describe("updateStatus()", () => {
    it("should update bounty status", () => {
      const bounty = createTestBounty({
        id: "status-test",
        status: "available",
      });
      repo.create(bounty);

      repo.updateStatus("status-test", "cancelled");

      const found = repo.findById("status-test");
      expect(found?.status).toBe("cancelled");
    });

    it("should update the updated_at timestamp", () => {
      const originalTime = Date.now() - 10000;
      const bounty = createTestBounty({
        id: "update-time-test",
        updated_at: originalTime,
      });
      repo.create(bounty);

      repo.updateStatus("update-time-test", "expired");

      const found = repo.findById("update-time-test");
      expect(found?.updated_at).toBeGreaterThan(originalTime);
    });
  });
});
