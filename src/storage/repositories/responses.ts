import type { DatabaseWrapper } from "../database.js";
import type {
  ReportResponse,
  InsertReportResponse,
} from "../../types/reports.js";

export class ResponsesRepository {
  constructor(private db: DatabaseWrapper) {}

  create(response: InsertReportResponse): void {
    this.db.run(
      `
      INSERT INTO report_responses (
        id, report_id, response_type, message, commit_hash,
        responder_pubkey, created_at, nostr_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        response.id,
        response.report_id,
        response.response_type,
        response.message ?? null,
        response.commit_hash ?? null,
        response.responder_pubkey,
        response.created_at,
        response.nostr_event_id ?? null,
      ]
    );
  }

  findByReportId(reportId: string): ReportResponse[] {
    return this.db.all<ReportResponse>(
      "SELECT * FROM report_responses WHERE report_id = ? ORDER BY created_at DESC",
      [reportId]
    );
  }

  findByEventId(eventId: string): ReportResponse | undefined {
    return this.db.get<ReportResponse>(
      "SELECT * FROM report_responses WHERE nostr_event_id = ?",
      [eventId]
    );
  }
}
