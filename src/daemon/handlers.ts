import { v4 as uuid } from "uuid";
import type { IpcRequest, IpcResponse, DaemonStatus } from "../types/ipc.js";
import { IdentityManager } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  ResponsesRepository,
  TransactionsRepository,
} from "../storage/repositories/index.js";
import { fetchBountyNetFile } from "../cli/commands/repo.js";
import type { Config } from "../types/config.js";
import { COINS } from "../constants/coins.js";
import { createLogger } from "../utils/logger.js";
import type { BugReportContent } from "../types/events.js";

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

      case "report_bug":
        return handleReportBug(request, identityManager, db, config);

      case "get_report_status":
        return handleGetReportStatus(request, db);

      case "list_my_reports":
        return handleListMyReports(request, identityManager, db, config);

      case "list_reports":
        return handleListReports(request, db);

      case "get_balance":
        return handleGetBalance(request, identityManager, config);

      case "resolve_maintainer":
        return handleResolveMaintainer(request, identityManager);

      case "get_my_identity":
        return handleGetMyIdentity(identityManager, config);

      case "search_known_issues":
        return handleSearchKnownIssues(request, db);

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

  logger.info(`Report ${request.reportId} rejected: ${request.reason}`);

  return {
    success: true,
    data: { depositKept: report.deposit_amount ?? 0 },
  };
}

async function handleReportBug(
  request: Extract<IpcRequest, { type: "report_bug" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
): Promise<IpcResponse> {
  // Get reporter identity
  const reporterIdentityName = config.reporter?.identity;
  if (!reporterIdentityName) {
    return { success: false, error: "No reporter identity configured" };
  }

  const identity = identityManager.get(reporterIdentityName);
  if (!identity) {
    return {
      success: false,
      error: `Reporter identity not found: ${reporterIdentityName}`,
    };
  }

  const { description, repoUrl, maintainerPubkey, files, suggestedFix } =
    request;

  // Get deposit amount from config
  const depositAmount = config.reporter?.defaultDeposit ?? 100;

  // Generate report ID
  const reportId = uuid();

  // Send deposit
  const depositResult = await identity.wallet.sendDeposit(
    maintainerPubkey,
    BigInt(depositAmount),
    reportId,
  );

  if (!depositResult.success) {
    return {
      success: false,
      error: `Failed to send deposit: ${depositResult.error}`,
    };
  }

  // Build report content
  const content = {
    bug_id: reportId,
    repo: repoUrl,
    files,
    description,
    suggested_fix: suggestedFix,
    agent_model: process.env.AGENT_MODEL,
    agent_version: process.env.AGENT_VERSION,
    deposit_tx: depositResult.txHash,
    deposit_amount: depositAmount.toString(),
  };

  // Publish to NOSTR
  const eventId = await identity.client.publishBugReport(
    content,
    maintainerPubkey,
  );

  // Store locally
  const reportsRepo = new ReportsRepository(db);
  reportsRepo.create({
    id: reportId,
    repo_url: repoUrl,
    file_path: files?.join(", "),
    description,
    suggested_fix: suggestedFix,
    agent_model: content.agent_model,
    agent_version: content.agent_version,
    sender_pubkey: identity.client.getPublicKey(),
    recipient_pubkey: maintainerPubkey,
    deposit_tx: depositResult.txHash,
    deposit_amount: depositAmount,
    deposit_coin: COINS.ALPHA,
    status: "pending",
    direction: "sent",
    created_at: Date.now(),
    updated_at: Date.now(),
    nostr_event_id: eventId,
  });

  // Record transaction
  const txRepo = new TransactionsRepository(db);
  txRepo.create({
    id: uuid(),
    tx_hash: depositResult.txHash,
    type: "deposit",
    amount: depositAmount,
    coin_id: COINS.ALPHA,
    sender_pubkey: identity.client.getPublicKey(),
    recipient_pubkey: maintainerPubkey,
    related_report_id: reportId,
    status: "confirmed",
    created_at: Date.now(),
    confirmed_at: Date.now(),
  });

  // For self-reports (recipient is one of our inbox identities), create received copy locally
  // NOSTR relays don't echo back your own events
  const senderPubkey = identity.client.getPublicKey();
  const isOurInbox = identityManager
    .getAllInboxIdentities()
    .some((inbox) => inbox.client.getPublicKey() === maintainerPubkey);
  if (isOurInbox) {
    const receivedReportId = `${reportId}-received`;
    reportsRepo.create({
      id: receivedReportId,
      repo_url: repoUrl,
      file_path: files?.join(", "),
      description,
      suggested_fix: suggestedFix,
      agent_model: content.agent_model,
      agent_version: content.agent_version,
      sender_pubkey: senderPubkey,
      recipient_pubkey: maintainerPubkey,
      deposit_tx: depositResult.txHash,
      deposit_amount: depositAmount,
      deposit_coin: COINS.ALPHA,
      status: "pending",
      direction: "received",
      created_at: Date.now(),
      updated_at: Date.now(),
      nostr_event_id: `${eventId}-received`,
    });
    logger.info(`Self-report: also created received copy ${receivedReportId}`);
  }

  logger.info(`Bug report submitted: ${reportId}`);

  return {
    success: true,
    data: {
      reportId,
      eventId,
      depositTx: depositResult.txHash,
      depositAmount,
    },
  };
}

function handleGetReportStatus(
  request: Extract<IpcRequest, { type: "get_report_status" }>,
  db: DatabaseWrapper,
): IpcResponse {
  const reportsRepo = new ReportsRepository(db);
  const report = reportsRepo.findById(request.reportId);

  if (!report) {
    return { success: false, error: `Report not found: ${request.reportId}` };
  }

  return {
    success: true,
    data: {
      id: report.id,
      status: report.status,
      repoUrl: report.repo_url,
      description: report.description,
      depositAmount: report.deposit_amount,
      createdAt: report.created_at,
      updatedAt: report.updated_at,
    },
  };
}

function handleListMyReports(
  request: Extract<IpcRequest, { type: "list_my_reports" }>,
  _identityManager: IdentityManager,
  db: DatabaseWrapper,
  _config: Config,
): IpcResponse {
  const reportsRepo = new ReportsRepository(db);
  const reports = reportsRepo.listSent({
    status: request.status as
      | "pending"
      | "acknowledged"
      | "accepted"
      | "rejected"
      | "all",
    limit: request.limit ?? 50,
  });

  return {
    success: true,
    data: reports.map((r) => ({
      id: r.id,
      status: r.status,
      repoUrl: r.repo_url,
      description: r.description?.slice(0, 100),
      depositAmount: r.deposit_amount,
      createdAt: r.created_at,
    })),
  };
}

function handleListReports(
  request: Extract<IpcRequest, { type: "list_reports" }>,
  db: DatabaseWrapper,
): IpcResponse {
  const reportsRepo = new ReportsRepository(db);
  const reports =
    request.direction === "sent"
      ? reportsRepo.listSent({
          status: request.status as
            | "pending"
            | "acknowledged"
            | "accepted"
            | "rejected"
            | "all",
          limit: request.limit ?? 50,
        })
      : reportsRepo.listReceived({
          status: request.status as
            | "pending"
            | "acknowledged"
            | "accepted"
            | "rejected"
            | "all",
          limit: request.limit ?? 50,
        });

  return {
    success: true,
    data: reports.map((r) => ({
      id: r.id,
      status: r.status,
      repoUrl: r.repo_url,
      description: r.description?.slice(0, 100),
      depositAmount: r.deposit_amount,
      senderPubkey: r.sender_pubkey,
      recipientPubkey: r.recipient_pubkey,
      createdAt: r.created_at,
    })),
  };
}

async function handleGetBalance(
  request: Extract<IpcRequest, { type: "get_balance" }>,
  identityManager: IdentityManager,
  config: Config,
): Promise<IpcResponse> {
  const identityName = request.identity ?? config.reporter?.identity;
  if (!identityName) {
    return { success: false, error: "No identity specified" };
  }

  const identity = identityManager.get(identityName);
  if (!identity) {
    return { success: false, error: `Identity not found: ${identityName}` };
  }

  const coinId = request.coinId ?? COINS.ALPHA;
  const balance = await identity.wallet.getBalance(coinId);

  return {
    success: true,
    data: {
      identity: identityName,
      coinId,
      balance: Number(balance),
    },
  };
}

async function handleResolveMaintainer(
  request: Extract<IpcRequest, { type: "resolve_maintainer" }>,
  identityManager: IdentityManager,
): Promise<IpcResponse> {
  // If repoUrl provided, fetch .bounty-net.yaml from it
  if (request.repoUrl) {
    try {
      const repoConfig = await fetchBountyNetFile(request.repoUrl);
      if (!repoConfig) {
        return {
          success: false,
          error: "No .bounty-net.yaml found in repository",
        };
      }

      // Resolve the maintainer nametag
      const firstIdentity = identityManager.getFirst();
      if (!firstIdentity) {
        return {
          success: true,
          data: { nametag: repoConfig.maintainer, pubkey: null },
        };
      }

      const pubkey = await firstIdentity.client.resolveNametag(
        repoConfig.maintainer,
      );
      return {
        success: true,
        data: {
          nametag: repoConfig.maintainer,
          pubkey,
          deposit: repoConfig.deposit,
          reward: repoConfig.reward,
        },
      };
    } catch (error) {
      return { success: false, error: `Failed to fetch repo config: ${error}` };
    }
  }

  // If nametag provided directly, resolve it
  if (request.nametag) {
    const firstIdentity = identityManager.getFirst();
    if (!firstIdentity) {
      return {
        success: false,
        error: "No identity available to resolve nametag",
      };
    }

    const pubkey = await firstIdentity.client.resolveNametag(request.nametag);
    if (!pubkey) {
      return {
        success: false,
        error: `Could not resolve nametag: ${request.nametag}`,
      };
    }

    return {
      success: true,
      data: { nametag: request.nametag, pubkey },
    };
  }

  return { success: false, error: "Must provide either repoUrl or nametag" };
}

function handleGetMyIdentity(
  identityManager: IdentityManager,
  config: Config,
): IpcResponse {
  const reporterIdentityName = config.reporter?.identity;
  if (!reporterIdentityName) {
    return { success: false, error: "No reporter identity configured" };
  }

  const identity = identityManager.get(reporterIdentityName);
  if (!identity) {
    return {
      success: false,
      error: `Reporter identity not found: ${reporterIdentityName}`,
    };
  }

  return {
    success: true,
    data: {
      name: reporterIdentityName,
      pubkey: identity.client.getPublicKey(),
      nametag: identity.nametag,
    },
  };
}

function handleSearchKnownIssues(
  request: Extract<IpcRequest, { type: "search_known_issues" }>,
  db: DatabaseWrapper,
): IpcResponse {
  const reportsRepo = new ReportsRepository(db);

  // Search in reports for this repo
  const reports = reportsRepo.search(request.query ?? "", {
    repo: request.repoUrl,
    limit: 20,
  });

  return {
    success: true,
    data: reports.map((r) => ({
      id: r.id,
      status: r.status,
      description: r.description?.slice(0, 200),
      filePath: r.file_path,
      createdAt: r.created_at,
    })),
  };
}
