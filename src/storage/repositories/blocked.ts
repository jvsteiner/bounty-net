import type { DatabaseWrapper } from "../database.js";

export interface BlockedSender {
  pubkey: string;
  reason?: string;
  blocked_at: number;
}

export class BlockedRepository {
  constructor(private db: DatabaseWrapper) {}

  isBlocked(pubkey: string): boolean {
    const result = this.db.get<{ pubkey: string }>(
      "SELECT pubkey FROM blocked_senders WHERE pubkey = ?",
      [pubkey]
    );
    return result !== undefined;
  }

  block(pubkey: string, reason?: string): void {
    this.db.run(
      `
      INSERT INTO blocked_senders (pubkey, reason, blocked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET reason = ?, blocked_at = ?
    `,
      [pubkey, reason ?? null, Date.now(), reason ?? null, Date.now()]
    );
  }

  unblock(pubkey: string): void {
    this.db.run("DELETE FROM blocked_senders WHERE pubkey = ?", [pubkey]);
  }

  list(): BlockedSender[] {
    return this.db.all<BlockedSender>(
      "SELECT * FROM blocked_senders ORDER BY blocked_at DESC"
    );
  }
}
