import { v4 as uuid } from "uuid";
import type { IpcRequest, IpcResponse, DaemonStatus } from "../types/ipc.js";
import { IdentityManager } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  BountiesRepository,
  ResponsesRepository,
  ReputationRepository,
  BlockedRepository,
} from "../storage/repositories/index.js";
import type { Config } from "../types/config.js";
import { COINS } from "../constants/coins.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("daemon-handlers");

const startTime = Date.now();

export function createCommandHandler(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config
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

      case "publish_fix":
        return handlePublishFix(request, identityManager, db, config);

      case "set_bounty":
        return handleSetBounty(request, identityManager, db, config);

      case "block_sender":
        return handleBlockSender(request, db);

      case "unblock_sender":
        return handleUnblockSender(request, db);

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
  config: Config
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
  config: Config
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

  // Refund deposit
  let depositRefunded = 0;
  if (report.deposit_amount && report.deposit_amount > 0) {
    const refundResult = await inbox.wallet.sendRefund(
      report.sender_pubkey,
      BigInt(report.deposit_amount),
      request.reportId
    );
    if (!refundResult.success) {
      return {
        success: false,
        error: `Failed to refund deposit: ${refundResult.error}`,
      };
    }
    depositRefunded = report.deposit_amount;
  }

  // Pay bounty if requested
  let bountyPaid = 0;
  if (request.payBounty !== false) {
    const bountiesRepo = new BountiesRepository(db);
    const bounty = bountiesRepo.findAvailable(report.repo_url, report.severity);
    if (bounty) {
      const bountyResult = await inbox.wallet.sendBounty(
        report.sender_pubkey,
        BigInt(bounty.amount),
        request.reportId
      );
      if (bountyResult.success) {
        bountyPaid = bounty.amount;
        bountiesRepo.markClaimed(
          bounty.id,
          report.sender_pubkey,
          request.reportId
        );
      }
    }
  }

  // Update report status
  reportsRepo.updateStatus(request.reportId, "accepted");

  // Update reputation
  const repRepo = new ReputationRepository(db);
  repRepo.incrementAccepted(report.sender_pubkey);

  // Publish response to NOSTR
  await inbox.client.publishBugResponse(
    {
      report_id: request.reportId,
      response_type: "accept",
      message: request.message,
      bounty_paid: bountyPaid > 0 ? bountyPaid.toString() : undefined,
    },
    report.sender_pubkey,
    report.nostr_event_id!
  );

  // Store response
  const responsesRepo = new ResponsesRepository(db);
  responsesRepo.create({
    id: uuid(),
    report_id: request.reportId,
    response_type: "accept",
    message: request.message,
    bounty_paid: bountyPaid,
    bounty_coin: bountyPaid > 0 ? COINS.ALPHA : undefined,
    responder_pubkey: inbox.client.getPublicKey(),
    created_at: Date.now(),
  });

  db.save();

  logger.info(`Report ${request.reportId} accepted`);

  return {
    success: true,
    data: { depositRefunded, bountyPaid },
  };
}

async function handleRejectReport(
  request: Extract<IpcRequest, { type: "reject_report" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  _config: Config
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

  // Update reputation
  const repRepo = new ReputationRepository(db);
  repRepo.incrementRejected(report.sender_pubkey);

  // Publish response to NOSTR
  await inbox.client.publishBugResponse(
    {
      report_id: request.reportId,
      response_type: "reject",
      message: request.reason,
    },
    report.sender_pubkey,
    report.nostr_event_id!
  );

  // Store response
  const responsesRepo = new ResponsesRepository(db);
  responsesRepo.create({
    id: uuid(),
    report_id: request.reportId,
    response_type: "reject",
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

async function handlePublishFix(
  request: Extract<IpcRequest, { type: "publish_fix" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  _config: Config
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

  // Update report status
  reportsRepo.updateStatus(request.reportId, "fix_published");

  // Publish response to NOSTR
  await inbox.client.publishBugResponse(
    {
      report_id: request.reportId,
      response_type: "fix_published",
      message: request.message,
      commit_hash: request.commitHash,
    },
    report.sender_pubkey,
    report.nostr_event_id!
  );

  // Store response
  const responsesRepo = new ResponsesRepository(db);
  responsesRepo.create({
    id: uuid(),
    report_id: request.reportId,
    response_type: "fix_published",
    message: request.message,
    commit_hash: request.commitHash,
    responder_pubkey: inbox.client.getPublicKey(),
    created_at: Date.now(),
  });

  db.save();

  logger.info(`Fix published for report ${request.reportId}: ${request.commitHash}`);

  return { success: true };
}

async function handleSetBounty(
  request: Extract<IpcRequest, { type: "set_bounty" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  _config: Config
): Promise<IpcResponse> {
  const inbox = identityManager.getInboxIdentity(request.inbox);
  if (!inbox) {
    return { success: false, error: `Inbox not found: ${request.inbox}` };
  }

  const bountiesRepo = new BountiesRepository(db);
  const bountyId = uuid();

  bountiesRepo.create({
    id: bountyId,
    repo_url: request.repo,
    severity: request.severity as "critical" | "high" | "medium" | "low",
    amount: request.amount,
    coin_id: COINS.ALPHA,
    status: "available",
    created_by: inbox.client.getPublicKey(),
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  db.save();

  logger.info(
    `Bounty set for ${request.repo} [${request.severity}]: ${request.amount} ALPHA`
  );

  return {
    success: true,
    data: { bountyId },
  };
}

function handleBlockSender(
  request: Extract<IpcRequest, { type: "block_sender" }>,
  db: DatabaseWrapper
): IpcResponse {
  const blockedRepo = new BlockedRepository(db);
  blockedRepo.block(request.pubkey, request.reason);
  db.save();

  logger.info(`Blocked sender: ${request.pubkey.slice(0, 16)}...`);

  return { success: true };
}

function handleUnblockSender(
  request: Extract<IpcRequest, { type: "unblock_sender" }>,
  db: DatabaseWrapper
): IpcResponse {
  const blockedRepo = new BlockedRepository(db);
  blockedRepo.unblock(request.pubkey);
  db.save();

  logger.info(`Unblocked sender: ${request.pubkey.slice(0, 16)}...`);

  return { success: true };
}
