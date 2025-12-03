import { v4 as uuid } from "uuid";
import type { IpcRequest, IpcResponse, DaemonStatus } from "../types/ipc.js";
import { IdentityManager } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  ResponsesRepository,
} from "../storage/repositories/index.js";
import { fetchBountyNetFile } from "../cli/commands/repo.js";
import type { Config } from "../types/config.js";
import { COINS } from "../constants/coins.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("daemon-handlers");

const startTime = Date.now();

export function createCommandHandler(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
) {
  return async (request: IpcRequest): Promise<IpcResponse> => {
    logger.debug(`Handling command: ${request.type}`);

    switch (request.type) {
      case "ping":
        return { success: true, data: "pong" };

      case "status":
        return {
          success: true,
          data: getDaemonStatus(identityManager, db, config),
        };

      case "accept_report":
        return handleAcceptReport(request, identityManager, db, config);

      case "reject_report":
        return handleRejectReport(request, identityManager, db, config);

      default:
        return {
          success: false,
          error: `Unknown command: ${(request as { type: string }).type}`,
        };
    }
  };
}

function getDaemonStatus(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
): DaemonStatus {
  const reportsRepo = new ReportsRepository(db);

  return {
    running: true,
    pid: process.pid,
    uptime: Date.now() - startTime,
    connectedRelays: config.relays,
    inboxes: config.maintainer.inboxes.map((inbox) => {
      const identity = identityManager.get(inbox.identity);
      const pendingCount = identity
        ? reportsRepo.countByStatus(identity.client.getPublicKey(), "pending")
        : 0;
      return {
        identity: inbox.identity,
        nametag: identity?.nametag,
        repositories: inbox.repositories,
        pendingReports: pendingCount,
      };
    }),
    lastSync: Date.now(),
  };
}

async function handleAcceptReport(
  request: Extract<IpcRequest, { type: "accept_report" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  _config: Config,
): Promise<IpcResponse> {
  const inbox = identityManager.getInboxIdentity(request.inbox);
  if (!inbox) {
    return { success: false, error: `Inbox not found: ${request.inbox}` };
  }

  const reportsRepo = new ReportsRepository(db);
  const report = reportsRepo.findById(request.reportId);

  if (!report) {
    return { success: false, error: `Report not found: ${request.reportId}` };
  }

  if (report.status !== "pending" && report.status !== "acknowledged") {
    return { success: false, error: `Report already ${report.status}` };
  }

  // Determine reward amount
  let rewardAmount = request.reward;

  // If no custom reward specified, fetch from repo's .bounty-net.yaml
  if (rewardAmount === undefined) {
    try {
      const repoConfig = await fetchBountyNetFile(report.repo_url);
      if (repoConfig?.reward !== undefined) {
        rewardAmount = repoConfig.reward;
      }
    } catch (error) {
      logger.warn(`Could not fetch repo config for reward: ${error}`);
    }
  }

  // Default to 0 if still not set
  rewardAmount = rewardAmount ?? 0;

  // Calculate total payout: deposit refund + reward
  const depositAmount = report.deposit_amount ?? 0;
  const totalPayout = depositAmount + rewardAmount;

  // Send combined payment (deposit refund + reward)
  let depositRefunded = 0;
  let rewardPaid = 0;

  if (totalPayout > 0) {
    // Use sendBounty for the combined payment (semantically it's a reward)
    const paymentResult = await inbox.wallet.sendBounty(
      report.sender_pubkey,
      BigInt(totalPayout),
      request.reportId,
    );
    if (!paymentResult.success) {
      return {
        success: false,
        error: `Failed to send payment: ${paymentResult.error}`,
      };
    }
    depositRefunded = depositAmount;
    rewardPaid = rewardAmount;
  }

  // Update report status
  reportsRepo.updateStatus(request.reportId, "accepted");

  // Publish response to NOSTR
  // Use original report ID (strip -received suffix for self-reports)
  const originalReportId = request.reportId.replace(/-received$/, "");
  const originalEventId = report.nostr_event_id!.replace(/-received$/, "");

  const responseMessage = request.message
    ? request.message
    : rewardPaid > 0
      ? `Accepted! Deposit refunded (${depositRefunded} ALPHA) + reward (${rewardPaid} ALPHA)`
      : undefined;

  await inbox.client.publishBugResponse(
    {
      report_id: originalReportId,
      response_type: "accepted",
      message: responseMessage,
    },
    report.sender_pubkey,
    originalEventId,
  );

  // Store response
  const responsesRepo = new ResponsesRepository(db);
  responsesRepo.create({
    id: uuid(),
    report_id: request.reportId,
    response_type: "accepted",
    message: responseMessage,
    responder_pubkey: inbox.client.getPublicKey(),
    created_at: Date.now(),
  });

  db.save();

  logger.info(
    `Report ${request.reportId} accepted. Deposit: ${depositRefunded}, Reward: ${rewardPaid}`,
  );

  return {
    success: true,
    data: { depositRefunded, rewardPaid },
  };
}

async function handleRejectReport(
  request: Extract<IpcRequest, { type: "reject_report" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  _config: Config,
): Promise<IpcResponse> {
  const inbox = identityManager.getInboxIdentity(request.inbox);
  if (!inbox) {
    return { success: false, error: `Inbox not found: ${request.inbox}` };
  }

  const reportsRepo = new ReportsRepository(db);
  const report = reportsRepo.findById(request.reportId);

  if (!report) {
    return { success: false, error: `Report not found: ${request.reportId}` };
  }

  if (report.status !== "pending" && report.status !== "acknowledged") {
    return { success: false, error: `Report already ${report.status}` };
  }

  // Update report status (deposit is NOT refunded for rejections)
  reportsRepo.updateStatus(request.reportId, "rejected");

  // Publish response to NOSTR
  // Use original report ID (strip -received suffix for self-reports)
  const originalReportId = request.reportId.replace(/-received$/, "");
  const originalEventId = report.nostr_event_id!.replace(/-received$/, "");

  await inbox.client.publishBugResponse(
    {
      report_id: originalReportId,
      response_type: "rejected",
      message: request.reason,
    },
    report.sender_pubkey,
    originalEventId,
  );

  // Store response
  const responsesRepo = new ResponsesRepository(db);
  responsesRepo.create({
    id: uuid(),
    report_id: request.reportId,
    response_type: "rejected",
    message: request.reason,
    responder_pubkey: inbox.client.getPublicKey(),
    created_at: Date.now(),
  });

  db.save();

  logger.info(`Report ${request.reportId} rejected: ${request.reason}`);

  return {
    success: true,
    data: { depositKept: report.deposit_amount ?? 0 },
  };
}
