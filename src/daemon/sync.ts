import { v4 as uuid } from "uuid";
import { IdentityManager, ManagedIdentity } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  ResponsesRepository,
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
  const reportsRepo = new ReportsRepository(db);
  const responsesRepo = new ResponsesRepository(db);
  const repRepo = new ReputationRepository(db);
  const blockedRepo = new BlockedRepository(db);

  // ALWAYS use NOW - never read historical events from NOSTR
  // If daemon is offline, events are missed. NOSTR is not a durable queue.
  const now = Math.floor(Date.now() / 1000);

  // Get list of repositories this identity is a maintainer for (if any)
  function getRepositoriesForIdentity(identityName: string): string[] {
    const inbox = config.maintainer?.inboxes?.find(
      (i) => i.identity === identityName
    );
    return inbox?.repositories ?? [];
  }

  // Subscribe ALL identities to incoming messages
  for (const identity of identityManager.getAllIdentities()) {
    logger.info(
      `Starting sync for identity: ${identity.name} (${identity.nametag ?? identity.client.getPublicKey().slice(0, 16)}...)`,
    );

    // Subscribe to incoming token transfers (deposits, refunds, rewards)
    identity.wallet.subscribeToTransfers(
      (from: string, amount: string, success: boolean) => {
        if (success) {
          logger.info(
            `[${identity.name}] Received token transfer: ${amount} from ${from.slice(0, 16)}...`,
          );
        } else {
          logger.warn(
            `[${identity.name}] Failed to finalize token transfer from ${from.slice(0, 16)}...`,
          );
        }
      },
      now,
    );

    // Subscribe to incoming bug reports (for maintainers)
    const repositories = getRepositoriesForIdentity(identity.name);
    if (repositories.length > 0) {
      subscribeToReports(identity, repositories, now, reportsRepo, repRepo, blockedRepo);
    }

    // Subscribe to responses (for reporters - everyone can receive responses)
    subscribeToResponses(identity, now, reportsRepo, responsesRepo);
  }

  logger.info("NOSTR sync started");
}

function subscribeToReports(
  identity: ManagedIdentity,
  repositories: string[],
  syncStartTime: number,
  reportsRepo: ReportsRepository,
  repRepo: ReputationRepository,
  blockedRepo: BlockedRepository,
): void {
  logger.info(`[${identity.name}] Listening for bug reports on: ${repositories.join(", ")}`);

  identity.client.subscribeToReports(syncStartTime, async (event, content) => {
    // HARD FILTER: Relay ignores 'since', so we filter here
    logger.debug(`[${identity.name}] EVENT CHECK: created_at=${event.created_at}, syncStartTime=${syncStartTime}`);
    if (event.created_at < syncStartTime) {
      logger.debug(`[${identity.name}] REJECTING old event ${event.id.slice(0, 16)}...`);
      return;
    }

    logger.info(
      `[${identity.name}] ACCEPTING NOSTR event: ${event.id.slice(0, 16)}... from ${event.pubkey.slice(0, 16)}...`,
    );

    // Validate content
    const parsed = BugReportContentSchema.safeParse(content);
    if (!parsed.success) {
      logger.warn(`[${identity.name}] Invalid bug report content: ${parsed.error.message}`);
      return;
    }

    // Check blocked
    if (blockedRepo.isBlocked(event.pubkey)) {
      logger.debug(`[${identity.name}] Ignored report from blocked sender: ${event.pubkey.slice(0, 16)}...`);
      return;
    }

    const reportId = content.bug_id;

    // Check duplicate by report ID
    const existingById = reportsRepo.findById(reportId);
    if (existingById) {
      logger.debug(`[${identity.name}] Duplicate report ignored: ${reportId}`);
      return;
    }

    // Check if repo matches this identity's repositories
    const repoMatches = repositories.some(
      (r) => content.repo.includes(r) || r.includes(content.repo),
    );
    if (!repoMatches) {
      logger.debug(`[${identity.name}] Report for untracked repo: ${content.repo}`);
      return;
    }

    // Verify sender's nametag if provided
    let verifiedNametag: string | undefined;
    if (parsed.data.sender_nametag) {
      try {
        const resolvedPubkey = await identity.client.resolveNametag(
          parsed.data.sender_nametag,
        );
        if (resolvedPubkey === event.pubkey) {
          verifiedNametag = parsed.data.sender_nametag;
          logger.debug(`[${identity.name}] Verified nametag: ${verifiedNametag}`);
        } else {
          logger.warn(
            `[${identity.name}] Nametag verification failed: ${parsed.data.sender_nametag}`,
          );
        }
      } catch (error) {
        logger.warn(`[${identity.name}] Failed to verify nametag: ${error}`);
      }
    }

    // Wallet pubkey comes from the report content (sender includes it)
    const senderWalletPubkey = parsed.data.sender_wallet_pubkey;
    if (senderWalletPubkey) {
      logger.debug(`[${identity.name}] Sender wallet pubkey: ${senderWalletPubkey.slice(0, 16)}...`);
    }

    // Store report
    try {
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
        sender_wallet_pubkey: senderWalletPubkey,
        recipient_pubkey: identity.client.getPublicKey(),
        status: "pending",
        created_at: event.created_at * 1000,
        updated_at: Date.now(),
        nostr_event_id: event.id,
      });
      logger.info(`[${identity.name}] New report received: ${reportId}`);
    } catch (error) {
      logger.error(`[${identity.name}] Failed to create report ${reportId}: ${error}`);
      return;
    }

    // Update sender reputation
    repRepo.incrementTotal(event.pubkey);
  });
}

function subscribeToResponses(
  identity: ManagedIdentity,
  syncStartTime: number,
  reportsRepo: ReportsRepository,
  responsesRepo: ResponsesRepository,
): void {
  logger.info(`[${identity.name}] Listening for responses to sent reports`);

  identity.client.subscribeToResponses(syncStartTime, async (event, content) => {
    // HARD FILTER: Relay ignores 'since', so we filter here
    if (event.created_at < syncStartTime) {
      logger.debug(`[${identity.name}] Ignoring old response ${event.id.slice(0, 16)}...`);
      return;
    }

    const report = reportsRepo.findById(content.report_id);
    if (!report) {
      logger.debug(`[${identity.name}] Response for unknown report: ${content.report_id}`);
      return;
    }

    // Only process responses for reports we sent
    if (report.sender_pubkey !== identity.client.getPublicKey()) {
      logger.debug(`[${identity.name}] Response for report we didn't send: ${content.report_id}`);
      return;
    }

    const existingResponses = responsesRepo.findByReportId(content.report_id);
    const alreadyHasResponse = existingResponses.some(
      (r) => r.response_type === content.response_type,
    );
    if (alreadyHasResponse) {
      logger.debug(`[${identity.name}] Duplicate response ignored for: ${content.report_id}`);
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
        `[${identity.name}] Report ${content.report_id} ${content.response_type} by maintainer`,
      );
    }
  });
}
