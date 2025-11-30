import type { DatabaseWrapper } from "../database.js";
import type {
  StoredBounty,
  InsertBounty,
  BountyStatus,
} from "../../types/payments.js";
import type { Severity } from "../../types/events.js";

export class BountiesRepository {
  constructor(private db: DatabaseWrapper) {}

  create(bounty: InsertBounty): void {
    this.db.run(
      `
      INSERT INTO bounties (
        id, repo_url, severity, amount, coin_id, description,
        status, created_by, claimed_by, claimed_report_id,
        expires_at, created_at, updated_at, nostr_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        bounty.id,
        bounty.repo_url,
        bounty.severity ?? null,
        bounty.amount,
        bounty.coin_id,
        bounty.description ?? null,
        bounty.status,
        bounty.created_by,
        bounty.claimed_by ?? null,
        bounty.claimed_report_id ?? null,
        bounty.expires_at ?? null,
        bounty.created_at,
        bounty.updated_at,
        bounty.nostr_event_id ?? null,
      ]
    );
  }

  findById(id: string): StoredBounty | undefined {
    return this.db.get<StoredBounty>("SELECT * FROM bounties WHERE id = ?", [
      id,
    ]);
  }

  findAvailable(repoUrl: string, severity?: Severity): StoredBounty | undefined {
    // First try to find a bounty matching exact severity
    if (severity) {
      const exactMatch = this.db.get<StoredBounty>(
        `SELECT * FROM bounties
         WHERE repo_url = ? AND severity = ? AND status = 'available'
         AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY amount DESC LIMIT 1`,
        [repoUrl, severity, Date.now()]
      );
      if (exactMatch) return exactMatch;
    }

    // Fall back to general bounty (no severity specified)
    return this.db.get<StoredBounty>(
      `SELECT * FROM bounties
       WHERE repo_url = ? AND severity IS NULL AND status = 'available'
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY amount DESC LIMIT 1`,
      [repoUrl, Date.now()]
    );
  }

  listByRepo(repoUrl: string): StoredBounty[] {
    return this.db.all<StoredBounty>(
      "SELECT * FROM bounties WHERE repo_url LIKE ? ORDER BY created_at DESC",
      [`%${repoUrl}%`]
    );
  }

  listByCreator(pubkey: string): StoredBounty[] {
    return this.db.all<StoredBounty>(
      "SELECT * FROM bounties WHERE created_by = ? ORDER BY created_at DESC",
      [pubkey]
    );
  }

  markClaimed(
    id: string,
    claimedBy: string,
    reportId: string
  ): void {
    this.db.run(
      `UPDATE bounties SET
         status = 'claimed',
         claimed_by = ?,
         claimed_report_id = ?,
         updated_at = ?
       WHERE id = ?`,
      [claimedBy, reportId, Date.now(), id]
    );
  }

  updateStatus(id: string, status: BountyStatus): void {
    this.db.run(
      "UPDATE bounties SET status = ?, updated_at = ? WHERE id = ?",
      [status, Date.now(), id]
    );
  }
}
