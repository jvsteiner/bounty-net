import type { DatabaseWrapper } from "../database.js";
import type {
  Transaction,
  InsertTransaction,
  TransactionStatus,
} from "../../types/payments.js";

export class TransactionsRepository {
  constructor(private db: DatabaseWrapper) {}

  create(transaction: InsertTransaction): void {
    this.db.run(
      `
      INSERT INTO transactions (
        id, tx_hash, type, amount, coin_id, sender_pubkey,
        recipient_pubkey, related_report_id, status, created_at, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        transaction.id,
        transaction.tx_hash ?? null,
        transaction.type,
        transaction.amount,
        transaction.coin_id,
        transaction.sender_pubkey,
        transaction.recipient_pubkey,
        transaction.related_report_id ?? null,
        transaction.status,
        transaction.created_at,
        transaction.confirmed_at ?? null,
      ]
    );
  }

  findById(id: string): Transaction | undefined {
    return this.db.get<Transaction>(
      "SELECT * FROM transactions WHERE id = ?",
      [id]
    );
  }

  findByReportId(reportId: string): Transaction[] {
    return this.db.all<Transaction>(
      "SELECT * FROM transactions WHERE related_report_id = ? ORDER BY created_at DESC",
      [reportId]
    );
  }

  findByTxHash(txHash: string): Transaction | undefined {
    return this.db.get<Transaction>(
      "SELECT * FROM transactions WHERE tx_hash = ?",
      [txHash]
    );
  }

  updateStatus(id: string, status: TransactionStatus): void {
    const confirmedAt = status === "confirmed" ? Date.now() : null;
    this.db.run(
      "UPDATE transactions SET status = ?, confirmed_at = ? WHERE id = ?",
      [status, confirmedAt, id]
    );
  }
}
