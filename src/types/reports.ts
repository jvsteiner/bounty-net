import type { ResponseType } from "./events.js";

export type ReportStatus =
  | "pending"
  | "acknowledged"
  | "accepted"
  | "rejected"
  | "fix_published";

export type ReportDirection = "sent" | "received";

export interface Report {
  id: string;
  repo_url: string;
  file_path?: string;
  description: string;
  suggested_fix?: string;
  agent_model?: string;
  agent_version?: string;
  sender_pubkey: string;
  recipient_pubkey: string;
  deposit_tx?: string;
  deposit_amount?: number;
  deposit_coin?: string;
  status: ReportStatus;
  direction: ReportDirection;
  created_at: number;
  updated_at: number;
  nostr_event_id?: string;
}

export interface InsertReport extends Omit<Report, "id"> {
  id: string;
}

export interface ReportFilters {
  status?: ReportStatus | "all";
  repo?: string;
  limit?: number;
  offset?: number;
}

export interface ReportResponse {
  id: string;
  report_id: string;
  response_type: ResponseType;
  message?: string;
  commit_hash?: string;
  bounty_paid?: number;
  bounty_coin?: string;
  responder_pubkey: string;
  created_at: number;
  nostr_event_id?: string;
}

export interface InsertReportResponse extends Omit<ReportResponse, "id"> {
  id: string;
}
