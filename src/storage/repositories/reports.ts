import type { DatabaseWrapper } from "../database.js";
import type {
  Report,
  InsertReport,
  ReportFilters,
  ReportStatus,
} from "../../types/reports.js";

export class ReportsRepository {
  constructor(private db: DatabaseWrapper) {}

  create(report: InsertReport): void {
    this.db.run(
      `
      INSERT INTO bug_reports (
        id, repo_url, file_path, description,
        suggested_fix, agent_model, agent_version,
        sender_pubkey, sender_nametag, recipient_pubkey,
        status, created_at, updated_at, nostr_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        report.id,
        report.repo_url,
        report.file_path ?? null,
        report.description,
        report.suggested_fix ?? null,
        report.agent_model ?? null,
        report.agent_version ?? null,
        report.sender_pubkey,
        report.sender_nametag ?? null,
        report.recipient_pubkey,
        report.status,
        report.created_at,
        report.updated_at,
        report.nostr_event_id ?? null,
      ],
    );
  }

  findById(id: string): Report | undefined {
    return this.db.get<Report>("SELECT * FROM bug_reports WHERE id = ?", [id]);
  }

  findByEventId(eventId: string): Report | undefined {
    return this.db.get<Report>(
      "SELECT * FROM bug_reports WHERE nostr_event_id = ?",
      [eventId],
    );
  }

  listByRecipient(recipientPubkey: string, filters: ReportFilters): Report[] {
    let sql = "SELECT * FROM bug_reports WHERE recipient_pubkey = ?";
    const params: unknown[] = [recipientPubkey];

    if (filters.status && filters.status !== "all") {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.repo) {
      sql += " AND repo_url LIKE ?";
      params.push(`%${filters.repo}%`);
    }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(filters.limit ?? 50);
    params.push(filters.offset ?? 0);

    return this.db.all<Report>(sql, params);
  }

  listBySender(senderPubkey: string, filters: ReportFilters): Report[] {
    let sql = "SELECT * FROM bug_reports WHERE sender_pubkey = ?";
    const params: unknown[] = [senderPubkey];

    if (filters.status && filters.status !== "all") {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.repo) {
      sql += " AND repo_url LIKE ?";
      params.push(`%${filters.repo}%`);
    }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(filters.limit ?? 50);
    params.push(filters.offset ?? 0);

    return this.db.all<Report>(sql, params);
  }

  updateStatus(id: string, status: ReportStatus): void {
    this.db.run(
      "UPDATE bug_reports SET status = ?, updated_at = ? WHERE id = ?",
      [status, Date.now(), id],
    );
  }

  search(query: string, filters: ReportFilters): Report[] {
    return this.db.all<Report>(
      `SELECT * FROM bug_reports
       WHERE description LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [`%${query}%`, filters.limit ?? 50],
    );
  }

  countByStatus(recipientPubkey: string, status: ReportStatus): number {
    const result = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM bug_reports
       WHERE recipient_pubkey = ? AND status = ?`,
      [recipientPubkey, status],
    );
    return result?.count ?? 0;
  }
}
