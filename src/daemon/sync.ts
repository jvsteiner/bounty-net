import { v4 as uuid } from "uuid";
import { IdentityManager } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  ResponsesRepository,
  SyncStateRepository,
  ReputationRepository,
  BlockedRepository,
} from "../storage/repositories/index.js";
import { BugReportContentSchema } from "../types/events.js";
import { createLogger } from "../utils/logger.js";
import type { Config } from "../types/config.js";

const logger = createLogger("daemon-sync");

// Hard cutoff: ignore ALL events before this timestamp (December 5, 2025 - schema v2)
// This ensures old events with incompatible formats are never processed
const SCHEMA_V2_CUTOFF = 1733400000; // ~Dec 5, 2025 12:00 UTC

export async function startSync(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
): Promise<void> {
  const syncRepo = new SyncStateRepository(db);
  const reportsRepo = new ReportsRepository(db);
  const repRepo = new ReputationRepository(db);
  const blockedRepo = new BlockedRepository(db);

  // Always use NOW as the starting point - never fetch historical data
  // Old events have incompatible formats that will crash the daemon
  const now = Math.floor(Date.now() / 1000);
  const lastSync = Math.max(syncRepo.get("last_sync") ?? now, SCHEMA_V2_CUTOFF);

  for (const inbox of identityManager.getAllInboxIdentities()) {
    const inboxConfig = config.maintainer.inboxes.find(
      (i) => i.identity === inbox.name,
    );
    if (!inboxConfig) continue;

    logger.info(
      `Starting sync for inbox: ${inbox.name} (${inbox.nametag ?? inbox.client.getPublicKey().slice(0, 16)}...)`,
    );

    // Subscribe to incoming token transfers (deposits from reporters)
    inbox.wallet.subscribeToTransfers(
      (from: string, amount: string, success: boolean) => {
        if (success) {
          logger.info(
            `Received token transfer: ${amount} from ${from.slice(0, 16)}...`,
          );
        } else {
          logger.warn(
            `Failed to finalize token transfer from ${from.slice(0, 16)}...`,
          );
        }
      },
      lastSync,
    );

    // Subscribe to incoming bug reports
    inbox.client.subscribeToReports(lastSync, async (event, content) => {
      // Skip events before schema v2 cutoff
      if (event.created_at < SCHEMA_V2_CUTOFF) {
        logger.debug(`Skipping old event before schema v2: ${event.id.slice(0, 16)}...`);
        return;
      }

      logger.info(
        `Received NOSTR event: ${event.id.slice(0, 16)}... from ${event.pubkey.slice(0, 16)}...`,
      );

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

      const reportId = content.bug_id;

      // Check duplicate by report ID
      const existingById = reportsRepo.findById(reportId);
      if (existingById) {
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

      // Verify sender's nametag if provided
      let verifiedNametag: string | undefined;
      if (parsed.data.sender_nametag) {
        try {
          const resolvedPubkey = await inbox.client.resolveNametag(
            parsed.data.sender_nametag,
          );
          if (resolvedPubkey === event.pubkey) {
            verifiedNametag = parsed.data.sender_nametag;
            logger.debug(
              `Verified nametag: ${verifiedNametag} for ${event.pubkey.slice(0, 16)}...`,
            );
          } else {
            logger.warn(
              `Nametag verification failed: ${parsed.data.sender_nametag} resolves to ${resolvedPubkey?.slice(0, 16) ?? "null"}, expected ${event.pubkey.slice(0, 16)}...`,
            );
          }
        } catch (error) {
          logger.warn(
            `Failed to verify nametag ${parsed.data.sender_nametag}: ${error}`,
          );
        }
      }

      // Store report
      try {
        logger.debug(`Creating report with id: ${reportId}`);
        const filePath = Array.isArray(content.files)
          ? content.files.join(", ")
          : content.file;

        reportsRepo.create({
          id: reportId,
          repo_url: content.repo,
          file_path: filePath,
          description: content.description,
          suggested_fix: content.suggested_fix,
          agent_model: content.agent_model,
          agent_version: content.agent_version,
          sender_pubkey: event.pubkey,
          sender_nametag: verifiedNametag,
          recipient_pubkey: inbox.client.getPublicKey(),
          status: "pending",
          created_at: event.created_at * 1000,
          updated_at: Date.now(),
          nostr_event_id: event.id,
        });
        logger.debug(`Report created successfully: ${reportId}`);
      } catch (error) {
        logger.error(`Failed to create report ${reportId}: ${error}`);
        return;
      }

      // Update sender reputation
      repRepo.incrementTotal(event.pubkey);

      // Update sync state
      const currentSync = syncRepo.get("last_sync") ?? 0;
      if (event.created_at > currentSync) {
        syncRepo.set("last_sync", event.created_at);
      }

      logger.info(
        `New report received: ${reportId} from ${event.pubkey.slice(0, 16)}...`,
      );
    });
  }

  // Subscribe to responses for reporter identity
  const reporterIdentity = identityManager.getReporterIdentity();
  if (reporterIdentity && config.reporter?.enabled) {
    logger.info(
      `Starting response sync for reporter: ${reporterIdentity.name}`,
    );

    // Subscribe to incoming token transfers (refunds/rewards from maintainers)
    reporterIdentity.wallet.subscribeToTransfers(
      (from: string, amount: string, success: boolean) => {
        if (success) {
          logger.info(
            `Received token transfer: ${amount} from ${from.slice(0, 16)}...`,
          );
        } else {
          logger.warn(
            `Failed to finalize token transfer from ${from.slice(0, 16)}...`,
          );
        }
      },
      lastSync,
    );

    const responsesRepo = new ResponsesRepository(db);

    reporterIdentity.client.subscribeToResponses(
      lastSync,
      async (event, content) => {
        // Skip events before schema v2 cutoff
        if (event.created_at < SCHEMA_V2_CUTOFF) {
          logger.debug(`Skipping old response before schema v2: ${event.id.slice(0, 16)}...`);
          return;
        }

        const report = reportsRepo.findById(content.report_id);
        if (!report) {
          logger.debug(`Response for unknown report: ${content.report_id}`);
          return;
        }

        if (report.sender_pubkey !== reporterIdentity.client.getPublicKey()) {
          logger.debug(
            `Response for report we didn't send: ${content.report_id}`,
          );
          return;
        }

        const existingResponses = responsesRepo.findByReportId(
          content.report_id,
        );
        const alreadyHasResponse = existingResponses.some(
          (r) => r.response_type === content.response_type,
        );
        if (alreadyHasResponse) {
          logger.debug(`Duplicate response ignored for: ${content.report_id}`);
          return;
        }

        responsesRepo.create({
          id: uuid(),
          report_id: content.report_id,
          response_type: content.response_type,
          message: content.message,
          responder_pubkey: event.pubkey,
          created_at: event.created_at * 1000,
        });

        if (
          content.response_type === "accepted" ||
          content.response_type === "rejected"
        ) {
          reportsRepo.updateStatus(
            content.report_id,
            content.response_type as "accepted" | "rejected",
          );
          logger.info(
            `Report ${content.report_id} ${content.response_type} by maintainer`,
          );
        }

        const currentSync = syncRepo.get("last_sync") ?? 0;
        if (event.created_at > currentSync) {
          syncRepo.set("last_sync", event.created_at);
        }
      },
    );
  }

  logger.info("NOSTR sync started");
}
