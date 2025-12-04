import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DatabaseWrapper } from "../../src/storage/database.js";

describe("DatabaseWrapper", () => {
  let db: Database.Database;
  let wrapper: DatabaseWrapper;

  beforeEach(() => {
    // Use in-memory database for testing
    db = new Database(":memory:");

    // Create a simple test table
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        value INTEGER
      )
    `);

    wrapper = new DatabaseWrapper(db);
  });

  afterEach(() => {
    wrapper.close();
  });

  describe("run()", () => {
    it("should execute INSERT statements", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "test",
        42,
      ]);

      const result = wrapper.get<{ id: string; name: string; value: number }>(
        "SELECT * FROM test_items WHERE id = ?",
        ["1"]
      );

      expect(result).toBeDefined();
      expect(result?.id).toBe("1");
      expect(result?.name).toBe("test");
      expect(result?.value).toBe(42);
    });

    it("should execute UPDATE statements", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "test",
        42,
      ]);
      wrapper.run("UPDATE test_items SET value = ? WHERE id = ?", [100, "1"]);

      const result = wrapper.get<{ value: number }>(
        "SELECT value FROM test_items WHERE id = ?",
        ["1"]
      );

      expect(result?.value).toBe(100);
    });

    it("should execute DELETE statements", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "test",
        42,
      ]);
      wrapper.run("DELETE FROM test_items WHERE id = ?", ["1"]);

      const result = wrapper.get<{ id: string }>(
        "SELECT * FROM test_items WHERE id = ?",
        ["1"]
      );

      expect(result).toBeUndefined();
    });
  });

  describe("get()", () => {
    it("should return a single row when found", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "test",
        42,
      ]);

      const result = wrapper.get<{ id: string; name: string; value: number }>(
        "SELECT * FROM test_items WHERE id = ?",
        ["1"]
      );

      expect(result).toEqual({ id: "1", name: "test", value: 42 });
    });

    it("should return undefined when no row found", () => {
      const result = wrapper.get<{ id: string }>(
        "SELECT * FROM test_items WHERE id = ?",
        ["nonexistent"]
      );

      expect(result).toBeUndefined();
    });

    it("should work without parameters", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "test",
        42,
      ]);

      const result = wrapper.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM test_items"
      );

      expect(result?.count).toBe(1);
    });
  });

  describe("all()", () => {
    it("should return all matching rows", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "a",
        10,
      ]);
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "2",
        "b",
        20,
      ]);
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "3",
        "c",
        30,
      ]);

      const results = wrapper.all<{ id: string; name: string; value: number }>(
        "SELECT * FROM test_items ORDER BY id"
      );

      expect(results).toHaveLength(3);
      expect(results[0].id).toBe("1");
      expect(results[1].id).toBe("2");
      expect(results[2].id).toBe("3");
    });

    it("should return empty array when no rows match", () => {
      const results = wrapper.all<{ id: string }>(
        "SELECT * FROM test_items WHERE value > ?",
        [1000]
      );

      expect(results).toEqual([]);
    });

    it("should filter by parameters", () => {
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "1",
        "a",
        10,
      ]);
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "2",
        "b",
        20,
      ]);
      wrapper.run("INSERT INTO test_items (id, name, value) VALUES (?, ?, ?)", [
        "3",
        "c",
        30,
      ]);

      const results = wrapper.all<{ id: string }>(
        "SELECT * FROM test_items WHERE value >= ?",
        [20]
      );

      expect(results).toHaveLength(2);
    });
  });
});
