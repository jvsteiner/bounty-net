import type { DatabaseWrapper } from "../database.js";
import type { ReputationStats, DepositTier } from "../../types/payments.js";

export class ReputationRepository {
  constructor(private db: DatabaseWrapper) {}

  getStats(pubkey: string): ReputationStats | undefined {
    return this.db.get<ReputationStats>(
      "SELECT * FROM reputation WHERE pubkey = ?",
      [pubkey]
    );
  }

  incrementTotal(pubkey: string): void {
    this.db.run(
      `
      INSERT INTO reputation (pubkey, total_reports, last_report_at)
      VALUES (?, 1, ?)
      ON CONFLICT(pubkey) DO UPDATE SET
        total_reports = total_reports + 1,
        last_report_at = ?
    `,
      [pubkey, Date.now(), Date.now()]
    );
  }

  incrementAccepted(pubkey: string): void {
    this.db.run(
      "UPDATE reputation SET accepted_reports = accepted_reports + 1 WHERE pubkey = ?",
      [pubkey]
    );
    this.updateTier(pubkey);
  }

  incrementRejected(pubkey: string): void {
    this.db.run(
      "UPDATE reputation SET rejected_reports = rejected_reports + 1 WHERE pubkey = ?",
      [pubkey]
    );
    this.updateTier(pubkey);
  }

  private updateTier(pubkey: string): void {
    const stats = this.getStats(pubkey);
    if (!stats) return;

    const newTier = this.calculateTier(stats);
    if (newTier !== stats.deposit_tier) {
      this.db.run("UPDATE reputation SET deposit_tier = ? WHERE pubkey = ?", [
        newTier,
        pubkey,
      ]);
    }
  }

  private calculateTier(stats: ReputationStats): DepositTier {
    const accuracy =
      stats.total_reports > 0
        ? stats.accepted_reports / stats.total_reports
        : 0;

    // Minimal: >90% accuracy, >50 reports
    if (stats.total_reports >= 50 && accuracy >= 0.9) {
      return "minimal";
    }

    // Reduced: >80% accuracy, >10 reports
    if (stats.total_reports >= 10 && accuracy >= 0.8) {
      return "reduced";
    }

    // Standard: everyone else
    return "standard";
  }

  setTrusted(pubkey: string, trusted: boolean): void {
    const tier: DepositTier = trusted ? "trusted" : "standard";
    this.db.run(
      `
      INSERT INTO reputation (pubkey, deposit_tier)
      VALUES (?, ?)
      ON CONFLICT(pubkey) DO UPDATE SET deposit_tier = ?
    `,
      [pubkey, tier, tier]
    );
  }

  getDepositMultiplier(tier: DepositTier): number {
    switch (tier) {
      case "trusted":
        return 0;
      case "minimal":
        return 0.1;
      case "reduced":
        return 0.5;
      case "standard":
        return 1.0;
    }
  }
}
