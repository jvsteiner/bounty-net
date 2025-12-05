import { v4 as uuid } from "uuid";
import type { IpcRequest, IpcResponse, DaemonStatus } from "../types/ipc.js";
import { IdentityManager } from "../services/identity/manager.js";
import { DatabaseWrapper } from "../storage/database.js";
import {
  ReportsRepository,
  ResponsesRepository,
} from "../storage/repositories/index.js";
import {
  fetchBountyNetFile,
  readLocalBountyNetFile,
} from "../cli/commands/repo.js";
import type { Config } from "../types/config.js";
import { createLogger } from "../utils/logger.js";
import { COINS } from "../constants/coins.js";

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
  logger.info(`handleAcceptReport called for report ${request.reportId}`);
  try {
    const inbox = identityManager.getInboxIdentity(request.inbox);
    logger.info(`Inbox identity: ${inbox ? inbox.name : "not found"}`);
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
    logger.info(`Initial reward amount: ${rewardAmount}`);

    // If no custom reward specified, get from .bounty-net.yaml
    // Try local file first (daemon runs in repo dir), then remote fetch for GitHub URLs
    if (rewardAmount === undefined) {
      logger.info(`Checking local .bounty-net.yaml`);
      const localConfig = readLocalBountyNetFile();
      logger.info(`Local config: ${JSON.stringify(localConfig)}`);
      logger.info(`Report repo_url: ${report.repo_url}`);
      if (
        localConfig?.repo === report.repo_url &&
        localConfig?.reward !== undefined
      ) {
        rewardAmount = localConfig.reward;
        logger.info(
          `Using reward from local .bounty-net.yaml: ${rewardAmount}`,
        );
      } else {
        // Fall back to remote fetch for GitHub URLs
        logger.info(`Falling back to remote fetch for: ${report.repo_url}`);
        try {
          const repoConfig = await fetchBountyNetFile(report.repo_url);
          logger.info(`Remote config: ${JSON.stringify(repoConfig)}`);
          if (repoConfig?.reward !== undefined) {
            rewardAmount = repoConfig.reward;
          }
        } catch (error) {
          logger.warn(`Could not fetch repo config for reward: ${error}`);
        }
      }
    }
    logger.info(`Final reward amount: ${rewardAmount}`);

    // Default to 0 if still not set
    rewardAmount = rewardAmount ?? 0;

    // Send reward payment if any (tokens are source of truth, not database)
    let rewardPaid = 0;

    if (rewardAmount > 0) {
      const paymentResult = await inbox.wallet.sendBounty(
        report.sender_pubkey,
        BigInt(rewardAmount),
        request.reportId,
      );
      if (!paymentResult.success) {
        return {
          success: false,
          error: `Failed to send payment: ${paymentResult.error}`,
        };
      }
      rewardPaid = rewardAmount;
    }

    // Update report status
    reportsRepo.updateStatus(request.reportId, "accepted");

    // Publish response to NOSTR
    const originalEventId = report.nostr_event_id!;

    const responseMessage = request.message
      ? request.message
      : rewardPaid > 0
        ? `Accepted! Reward paid: ${rewardPaid} ALPHA`
        : "Accepted!";

    await inbox.client.publishBugResponse(
      {
        report_id: request.reportId,
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

    logger.info(`Report ${request.reportId} accepted. Reward: ${rewardPaid}`);

    return {
      success: true,
      data: { rewardPaid },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `Failed to accept report ${request.reportId}: ${errorMessage}`,
    );
    return { success: false, error: errorMessage };
  }
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
  await inbox.client.publishBugResponse(
    {
      report_id: request.reportId,
      response_type: "rejected",
      message: request.reason,
    },
    report.sender_pubkey,
    report.nostr_event_id!,
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
    data: {},
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

  // Build report content (tokens are source of truth, not duplicated here)
  const content = {
    bug_id: reportId,
    repo: repoUrl,
    files,
    description,
    suggested_fix: suggestedFix,
    agent_model: process.env.AGENT_MODEL,
    agent_version: process.env.AGENT_VERSION,
    sender_nametag: identity.nametag, // Include sender's nametag for verification
  };

  // Publish to NOSTR
  const eventId = await identity.client.publishBugReport(
    content,
    maintainerPubkey,
  );

  // Store report locally (tokens on disk are source of truth for payments)
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
    status: "pending",
    created_at: Date.now(),
    updated_at: Date.now(),
    nostr_event_id: eventId,
  });

  logger.info(`Bug report submitted: ${reportId}`);

  return {
    success: true,
    data: {
      reportId,
      eventId,
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
      createdAt: report.created_at,
      updatedAt: report.updated_at,
    },
  };
}

function handleListMyReports(
  request: Extract<IpcRequest, { type: "list_my_reports" }>,
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
): IpcResponse {
  // Get reporter identity to find sent reports
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

  const reportsRepo = new ReportsRepository(db);
  const reports = reportsRepo.listBySender(identity.client.getPublicKey(), {
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
      createdAt: r.created_at,
    })),
  };
}

function handleListReports(
  request: Extract<IpcRequest, { type: "list_reports" }>,
  db: DatabaseWrapper,
): IpcResponse {
  const reportsRepo = new ReportsRepository(db);
  const filters = {
    status: request.status as
      | "pending"
      | "acknowledged"
      | "accepted"
      | "rejected"
      | "all",
    limit: request.limit ?? 50,
  };
  const reports =
    request.direction === "sent"
      ? reportsRepo.listBySender(request.pubkey, filters)
      : reportsRepo.listByRecipient(request.pubkey, filters);

  return {
    success: true,
    data: reports.map((r) => ({
      id: r.id,
      status: r.status,
      repoUrl: r.repo_url,
      description: r.description?.slice(0, 100),
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

  // Alphalite uses hex-encoded coin IDs
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
