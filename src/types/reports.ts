import type { ResponseType } from "./events.js";

export type ReportStatus =
  | "pending" // Needs review
  | "accepted" // Valid bug, reward paid
  | "rejected" // Invalid/spam, deposit kept
  | "completed"; // Archived, hidden from default view

export interface Report {
  id: string;
  repo_url: string;
  file_path?: string;
  description: string;
  suggested_fix?: string;
  agent_model?: string;
  agent_version?: string;
  sender_pubkey: string;
  sender_nametag?: string; // Verified nametag of sender
  recipient_pubkey: string;
  status: ReportStatus;
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
  responder_pubkey: string;
  created_at: number;
  nostr_event_id?: string;
}

export interface InsertReportResponse extends Omit<ReportResponse, "id"> {
  id: string;
}
