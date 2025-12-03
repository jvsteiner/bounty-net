export type TransactionType = "deposit" | "refund" | "bounty";
export type TransactionStatus = "pending" | "confirmed" | "failed";

export interface Transaction {
  id: string;
  tx_hash?: string;
  type: TransactionType;
  amount: number;
  coin_id: string;
  sender_pubkey: string;
  recipient_pubkey: string;
  related_report_id?: string;
  status: TransactionStatus;
  created_at: number;
  confirmed_at?: number;
}

export interface InsertTransaction extends Omit<Transaction, "id"> {
  id: string;
}

export type BountyStatus = "available" | "claimed" | "expired" | "cancelled";

export interface StoredBounty {
  id: string;
  repo_url: string;
  amount: number;
  coin_id: string;
  description?: string;
  status: BountyStatus;
  created_by: string;
  claimed_by?: string;
  claimed_report_id?: string;
  expires_at?: number;
  created_at: number;
  updated_at: number;
  nostr_event_id?: string;
}

export interface InsertBounty extends Omit<StoredBounty, "id"> {
  id: string;
}

export type DepositTier = "standard" | "reduced" | "minimal" | "trusted";

export interface ReputationStats {
  pubkey: string;
  total_reports: number;
  accepted_reports: number;
  rejected_reports: number;
  last_report_at?: number;
  deposit_tier: DepositTier;
}
