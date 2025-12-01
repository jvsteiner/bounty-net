import { v4 as uuid } from "uuid";
import {
  IdentityManager,
  ManagedIdentity,
} from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  SyncStateRepository,
  ReputationRepository,
  BlockedRepository,
} from "../storage/repositories/index.js";
import { BugReportContentSchema } from "../types/events.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../types/config.js";

const logger = createLogger("daemon-sync");

export async function startSync(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
): Promise<void> {
  const syncRepo = new SyncStateRepository(db);
  const reportsRepo = new ReportsRepository(db);
  const repRepo = new ReputationRepository(db);
  const blockedRepo = new BlockedRepository(db);

  // Get last sync time (default to 7 days ago)
  const lastSync =
    syncRepo.get("last_sync") ?? Math.floor(Date.now() / 1000) - 604800;

  for (const inbox of identityManager.getAllInboxIdentities()) {
    const inboxConfig = config.maintainer.inboxes.find(
      (i) => i.identity === inbox.name,
    );
    if (!inboxConfig) continue;

    logger.info(
      `Starting sync for inbox: ${inbox.name} (${inbox.nametag ?? inbox.client.getPublicKey().slice(0, 16)}...)`,
    );

    // Subscribe to incoming bug reports
    inbox.client.subscribeToReports(lastSync, async (event, content) => {
      // Validate content
      const parsed = BugReportContentSchema.safeParse(content);
      if (!parsed.success) {
        logger.warn(`Invalid bug report content: ${parsed.error.message}`);
        return;
      }

      // Check blocked
      if (blockedRepo.isBlocked(event.pubkey)) {
        logger.debug(
          `Ignored report from blocked sender: ${event.pubkey.slice(0, 16)}...`,
        );
        return;
      }

      // Use modified ID for received reports to distinguish from sent reports
      const reportId = `${content.bug_id}-received`;

      // Check duplicate by NOSTR event ID (more reliable than bug_id)
      // For self-reports, the same event creates both sent and received copies
      const existingByEvent = reportsRepo.findByEventId(event.id);
      if (existingByEvent && existingByEvent.direction === "received") {
        logger.debug(`Duplicate report ignored (event ${event.id})`);
        return;
      }

      // Also check by bug_id for received reports
      const existingById = reportsRepo.findById(reportId);
      if (existingById && existingById.direction === "received") {
        logger.debug(`Duplicate report ignored: ${reportId}`);
        return;
      }

      // Check if repo matches this inbox
      const repoMatches = inboxConfig.repositories.some(
        (r) => content.repo.includes(r) || r.includes(content.repo),
      );
      if (!repoMatches) {
        logger.debug(`Report for untracked repo: ${content.repo}`);
        return;
      }

      // Store report
      try {
        logger.debug(`Creating report with id: ${reportId}`);
        reportsRepo.create({
          id: reportId,
          repo_url: content.repo,
          file_path: content.file,
          line_start: content.line_start,
          line_end: content.line_end,
          description: content.description,
          suggested_fix: content.suggested_fix,
          severity: content.severity,
          category: content.category,
          agent_model: content.agent_model,
          agent_version: content.agent_version,
          sender_pubkey: event.pubkey,
          recipient_pubkey: inbox.client.getPublicKey(),
          deposit_tx: content.deposit_tx,
          deposit_amount: content.deposit_amount
            ? parseInt(content.deposit_amount, 10)
            : undefined,
          deposit_coin: "414c504841", // ALPHA
          status: "pending",
          direction: "received",
          created_at: event.created_at * 1000,
          updated_at: Date.now(),
          // Always suffix received event IDs to avoid UNIQUE constraint with sent reports
          nostr_event_id: `${event.id}-received`,
        });
        logger.debug(`Report created successfully: ${reportId}`);
      } catch (error) {
        logger.error(`Failed to create report ${reportId}: ${error}`);
        return;
      }

      // Update sender reputation
      repRepo.incrementTotal(event.pubkey);

      logger.info(
        `New report received: ${reportId} [${content.severity}] from ${event.pubkey.slice(0, 16)}...`,
      );
    });
  }

  // Update sync state periodically
  setInterval(() => {
    syncRepo.set("last_sync", Math.floor(Date.now() / 1000));
  }, 60000);

  logger.info("NOSTR sync started");
}
