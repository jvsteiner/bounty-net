import type { DatabaseWrapper } from "../database.js";

export class SyncStateRepository {
  constructor(private db: DatabaseWrapper) {}

  get(key: string): number | undefined {
    const result = this.db.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = ?",
      [key]
    );
    return result ? parseInt(result.value, 10) : undefined;
  }

  set(key: string, value: number): void {
    this.db.run(
      `
      INSERT INTO sync_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
    `,
      [key, value.toString(), Date.now(), value.toString(), Date.now()]
    );
  }

  delete(key: string): void {
    this.db.run("DELETE FROM sync_state WHERE key = ?", [key]);
  }
}
