import express, { Express, Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import type { DatabaseWrapper } from "../storage/database.js";
import type { IdentityManager } from "../services/identity/manager.js";
import type { Config } from "../types/config.js";
import type { Report } from "../types/reports.js";
import { COINS } from "../constants/coins.js";
import { createLogger } from "../utils/logger.js";
import {
  ReportsRepository,
  ResponsesRepository,
} from "../storage/repositories/index.js";
import {
  renderDashboard,
  renderReportDetail,
  renderReportRow,
} from "./views/index.js";
import {
  fetchBountyNetFile,
  readLocalBountyNetFile,
} from "../cli/commands/repo.js";

type TabType = "outbound" | "inbound";

const logger = createLogger("ui-server");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build a map of pubkey -> nametag from known identities
function buildNametagMap(
  identityManager: IdentityManager,
  config: Config,
): Record<string, string> {
  const map: Record<string, string> = {};

  if (config.identities) {
    for (const [name, identity] of Object.entries(config.identities)) {
      if (identity.nametag) {
        const managed = identityManager.get(name);
        if (managed) {
          map[managed.client.getPublicKey()] = identity.nametag;
        }
      }
    }
  }

  return map;
}

// Get wallet balances for all identities
async function getWalletBalances(
  identityManager: IdentityManager,
): Promise<{ name: string; nametag?: string; balance: number }[]> {
  const balances: { name: string; nametag?: string; balance: number }[] = [];

  for (const identity of identityManager.getAllIdentities()) {
    // Reload wallet to get latest state (mutex ensures this waits for in-flight transactions)
    await identity.wallet.reload();
    const balance = await identity.wallet.getBalance(COINS.ALPHA);
    balances.push({
      name: identity.name,
      nametag: identity.nametag,
      balance: Number(balance),
    });
  }

  return balances;
}

// In dev, files are in src/ui/public. In dist, they're in dist/ui/public
const publicDir = path.join(__dirname, "ui", "public");

/**
 * Add UI routes to an Express app.
 * This runs in-process with the daemon - no IPC needed.
 */
export function createUiRoutes(
  app: Express,
  db: DatabaseWrapper,
  identityManager: IdentityManager,
  config: Config,
) {
  // Collect all identity pubkeys for queries
  // All identities can both send (reporter) and receive (maintainer) reports
  const allPubkeys: string[] = [];

  for (const identity of identityManager.getAllIdentities()) {
    allPubkeys.push(identity.client.getPublicKey());
  }

  // For outbound tab, show reports sent by ANY of our identities
  const reporterPubkeys = allPubkeys;

  // For inbound tab, show reports received by ANY of our identities
  const inboxPubkeys = allPubkeys;

  const reportsRepo = new ReportsRepository(db);
  const responsesRepo = new ResponsesRepository(db);

  app.use(express.urlencoded({ extended: true }));

  // Serve static files
  app.use("/public", express.static(publicDir));

  // Test endpoint
  app.get("/api/test", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Dashboard - redirects to default tab
  app.get("/", (req: Request, res: Response) => {
    // Default to inbound (received reports) view
    res.redirect("/inbound");
  });

  // Outbound tab (sent reports - reporter view)
  app.get("/outbound", async (req: Request, res: Response) => {
    const status = (req.query.status as string) || "active";
    const repo = req.query.repo as string | undefined;

    let reports: Report[] = [];
    for (const pubkey of reporterPubkeys) {
      reports.push(
        ...reportsRepo.listBySender(pubkey, {
          status: status === "active" ? undefined : (status as any),
          repo,
          limit: 100,
        }),
      );
    }

    if (status === "active") {
      reports = reports.filter((r) => r.status !== "completed");
    }

    const repos = getUniqueRepos(reportsRepo, "sent", reporterPubkeys);
    const counts = getStatusCounts(reportsRepo, "sent", reporterPubkeys);
    const nametagMap = buildNametagMap(identityManager, config);
    const balances = await getWalletBalances(identityManager);

    res.send(
      renderDashboard({
        reports,
        repos,
        counts,
        currentStatus: status,
        currentRepo: repo,
        tab: "outbound",
        nametagMap,
        balances,
      }),
    );
  });

  // Inbound tab (received reports - maintainer view)
  app.get("/inbound", async (req: Request, res: Response) => {
    const status = (req.query.status as string) || "active";
    const repo = req.query.repo as string | undefined;

    let reports: Report[] = [];
    for (const pubkey of inboxPubkeys) {
      reports.push(
        ...reportsRepo.listByRecipient(pubkey, {
          status: status === "active" ? undefined : (status as any),
          repo,
          limit: 100,
        }),
      );
    }

    if (status === "active") {
      reports = reports.filter((r) => r.status !== "completed");
    }

    const repos = getUniqueRepos(reportsRepo, "received", inboxPubkeys);
    const counts = getStatusCounts(reportsRepo, "received", inboxPubkeys);
    const nametagMap = buildNametagMap(identityManager, config);
    const balances = await getWalletBalances(identityManager);

    res.send(
      renderDashboard({
        reports,
        repos,
        counts,
        currentStatus: status,
        currentRepo: repo,
        tab: "inbound",
        nametagMap,
        balances,
      }),
    );
  });

  // Report list partial (for htmx)
  app.get("/reports", (req: Request, res: Response) => {
    const status = (req.query.status as string) || "all";
    const repo = req.query.repo as string | undefined;
    const direction = (req.query.direction as string) || "received";

    const pubkeys = direction === "sent" ? reporterPubkeys : inboxPubkeys;
    const reports: Report[] = [];
    for (const pubkey of pubkeys) {
      if (direction === "sent") {
        reports.push(
          ...reportsRepo.listBySender(pubkey, {
            status: status === "all" ? undefined : (status as any),
            repo,
            limit: 100,
          }),
        );
      } else {
        reports.push(
          ...reportsRepo.listByRecipient(pubkey, {
            status: status === "all" ? undefined : (status as any),
            repo,
            limit: 100,
          }),
        );
      }
    }

    const tab: TabType = direction === "sent" ? "outbound" : "inbound";
    const rows = reports.map((r) => renderReportRow(r, tab)).join("\n");
    res.send(rows);
  });

  // Report detail
  app.get("/reports/:id", (req: Request, res: Response) => {
    const reportId = req.params.id;

    const report = reportsRepo.findById(reportId);
    if (!report) {
      res.status(404).send("<p>Report not found</p>");
      return;
    }

    const responses = responsesRepo.findByReportId(reportId);
    const ideProtocol = config.ui?.ideProtocol || "zed";
    const isSent = reporterPubkeys.includes(report.sender_pubkey);
    const tab: TabType = isSent ? "outbound" : "inbound";

    res.send(renderReportDetail({ report, responses, ideProtocol, tab }));
  });

  // Accept report - DIRECT handler, no IPC
  app.post("/api/accept/:id", async (req: Request, res: Response) => {
    try {
      const reportId = req.params.id;
      const message = req.body.message as string | undefined;
      const rewardStr = req.body.reward as string | undefined;
      let reward = rewardStr ? parseInt(rewardStr, 10) : undefined;

      const report = reportsRepo.findById(reportId);
      if (!report) {
        res.status(404).send("Report not found");
        return;
      }

      const inboxName = findIdentityForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) {
        res.status(400).send("No inbox found for this report");
        return;
      }

      const inbox = identityManager.getInboxIdentity(inboxName);
      if (!inbox) {
        res.status(400).send("Inbox identity not found");
        return;
      }

      await inbox.wallet.reload();

      // Get reward from .bounty-net.yaml if not specified
      if (reward === undefined) {
        const localConfig = readLocalBountyNetFile();
        if (
          localConfig?.repo === report.repo_url &&
          localConfig?.reward !== undefined
        ) {
          reward = localConfig.reward;
        } else {
          try {
            const repoConfig = await fetchBountyNetFile(report.repo_url);
            if (repoConfig?.reward !== undefined) {
              reward = repoConfig.reward;
            }
          } catch {
            // Ignore fetch errors
          }
        }
      }

      reward = reward ?? 0;

      // Send reward payment
      let rewardPaid = 0;
      if (reward > 0) {
        // Use sender_wallet_pubkey for token transfer (33-byte compressed secp256k1)
        // Use sender_pubkey for NOSTR message (32-byte x-only schnorr)
        const recipientWalletPubkey = report.sender_wallet_pubkey;
        const recipientNostrPubkey = report.sender_pubkey;

        if (!recipientWalletPubkey) {
          res.status(500).send(`Cannot send payment: No wallet pubkey for sender. Reporter must include sender_wallet_pubkey in report.`);
          return;
        }

        const paymentResult = await inbox.wallet.sendBounty(
          recipientWalletPubkey,
          recipientNostrPubkey,
          BigInt(reward),
          reportId,
        );
        if (!paymentResult.success) {
          res.status(500).send(`Failed to send payment: ${paymentResult.error}`);
          return;
        }
        rewardPaid = reward;
      }

      // Update status
      reportsRepo.updateStatus(reportId, "accepted");

      // Publish response to NOSTR
      const responseMessage = message
        ? message
        : rewardPaid > 0
          ? `Accepted! Reward paid: ${rewardPaid} ALPHA`
          : "Accepted!";

      await inbox.client.publishBugResponse(
        {
          report_id: reportId,
          response_type: "accepted",
          message: responseMessage,
        },
        report.sender_pubkey,
        report.nostr_event_id!,
      );

      // Store response
      responsesRepo.create({
        id: uuid(),
        report_id: reportId,
        response_type: "accepted",
        message: responseMessage,
        responder_pubkey: inbox.client.getPublicKey(),
        created_at: Date.now(),
      });

      logger.info(`Report ${reportId} accepted. Reward: ${rewardPaid}`);

      // Return updated row for htmx swap
      const updatedReport = reportsRepo.findById(reportId);
      if (updatedReport) {
        res.send(renderReportRow(updatedReport));
      } else {
        res.send("");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Accept route error: ${errorMessage}`);
      res.status(500).send(`Failed: ${errorMessage}`);
    }
  });

  // Reject report - DIRECT handler, no IPC
  app.post("/api/reject/:id", async (req: Request, res: Response) => {
    try {
      const reportId = req.params.id;
      const reason = (req.body.reason as string) || "Rejected via UI";

      const report = reportsRepo.findById(reportId);
      if (!report) {
        res.status(404).send("Report not found");
        return;
      }

      const inboxName = findIdentityForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) {
        res.status(400).send("No inbox found for this report");
        return;
      }

      const inbox = identityManager.getInboxIdentity(inboxName);
      if (!inbox) {
        res.status(400).send("Inbox identity not found");
        return;
      }

      // Update status
      reportsRepo.updateStatus(reportId, "rejected");

      // Publish response
      await inbox.client.publishBugResponse(
        {
          report_id: reportId,
          response_type: "rejected",
          message: reason,
        },
        report.sender_pubkey,
        report.nostr_event_id!,
      );

      // Store response
      responsesRepo.create({
        id: uuid(),
        report_id: reportId,
        response_type: "rejected",
        message: reason,
        responder_pubkey: inbox.client.getPublicKey(),
        created_at: Date.now(),
      });

      logger.info(`Report ${reportId} rejected: ${reason}`);

      const updatedReport = reportsRepo.findById(reportId);
      if (updatedReport) {
        res.send(renderReportRow(updatedReport));
      } else {
        res.send("");
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Reject route error: ${errorMessage}`);
      res.status(500).send(`Failed: ${errorMessage}`);
    }
  });

  // Archive report
  app.post("/api/archive/:id", async (req: Request, res: Response) => {
    const reportId = req.params.id;

    const report = reportsRepo.findById(reportId);
    if (!report) {
      res.status(404).send("Report not found");
      return;
    }

    if (report.status !== "accepted" && report.status !== "rejected") {
      res.status(400).send("Can only archive accepted or rejected reports");
      return;
    }

    reportsRepo.updateStatus(reportId, "completed");
    res.send("OK");
  });

  // Batch accept
  app.post("/api/batch/accept", async (req: Request, res: Response) => {
    const ids = req.body.ids as string[];
    if (!ids || !Array.isArray(ids)) {
      res.status(400).send("Missing ids array");
      return;
    }

    const results: string[] = [];
    for (const id of ids) {
      const report = reportsRepo.findById(id);
      if (!report) continue;

      const inboxName = findIdentityForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) continue;

      const inbox = identityManager.getInboxIdentity(inboxName);
      if (!inbox) continue;

      await inbox.wallet.reload();

      // Get reward from config
      let reward = 0;
      try {
        const repoConfig = await fetchBountyNetFile(report.repo_url);
        reward = repoConfig?.reward ?? 0;
      } catch {
        // Ignore
      }

      if (reward > 0) {
        // Use sender_wallet_pubkey for token transfer, sender_pubkey for NOSTR message
        const recipientWalletPubkey = report.sender_wallet_pubkey;
        const recipientNostrPubkey = report.sender_pubkey;

        if (!recipientWalletPubkey) continue; // Skip if no wallet pubkey

        const paymentResult = await inbox.wallet.sendBounty(
          recipientWalletPubkey,
          recipientNostrPubkey,
          BigInt(reward),
          id,
        );
        if (!paymentResult.success) continue;
      }

      reportsRepo.updateStatus(id, "accepted");

      await inbox.client.publishBugResponse(
        {
          report_id: id,
          response_type: "accepted",
          message: reward > 0 ? `Accepted! Reward: ${reward} ALPHA` : "Accepted!",
        },
        report.sender_pubkey,
        report.nostr_event_id!,
      );

      responsesRepo.create({
        id: uuid(),
        report_id: id,
        response_type: "accepted",
        message: reward > 0 ? `Accepted! Reward: ${reward} ALPHA` : "Accepted!",
        responder_pubkey: inbox.client.getPublicKey(),
        created_at: Date.now(),
      });

      const updated = reportsRepo.findById(id);
      if (updated) {
        results.push(renderReportRow(updated));
      }
    }

    res.send(results.join("\n"));
  });

  // Batch reject
  app.post("/api/batch/reject", async (req: Request, res: Response) => {
    const ids = req.body.ids as string[];
    const reason = (req.body.reason as string) || "Batch rejected via UI";

    if (!ids || !Array.isArray(ids)) {
      res.status(400).send("Missing ids array");
      return;
    }

    const results: string[] = [];
    for (const id of ids) {
      const report = reportsRepo.findById(id);
      if (!report) continue;

      const inboxName = findIdentityForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) continue;

      const inbox = identityManager.getInboxIdentity(inboxName);
      if (!inbox) continue;

      reportsRepo.updateStatus(id, "rejected");

      await inbox.client.publishBugResponse(
        {
          report_id: id,
          response_type: "rejected",
          message: reason,
        },
        report.sender_pubkey,
        report.nostr_event_id!,
      );

      responsesRepo.create({
        id: uuid(),
        report_id: id,
        response_type: "rejected",
        message: reason,
        responder_pubkey: inbox.client.getPublicKey(),
        created_at: Date.now(),
      });

      const updated = reportsRepo.findById(id);
      if (updated) {
        results.push(renderReportRow(updated));
      }
    }

    res.send(results.join("\n"));
  });

  // Batch archive
  app.post("/api/batch/archive", async (req: Request, res: Response) => {
    const ids = req.body.ids as string[];

    if (!ids || !Array.isArray(ids)) {
      res.status(400).send("Missing ids array");
      return;
    }

    const results: string[] = [];

    for (const id of ids) {
      const report = reportsRepo.findById(id);
      if (!report) continue;

      reportsRepo.updateStatus(id, "completed");

      const updated = reportsRepo.findById(id);
      if (updated) {
        results.push(renderReportRow(updated));
      }
    }

    res.send(results.join("\n"));
  });

  return app;
}

function getUniqueRepos(
  reportsRepo: ReportsRepository,
  direction: "sent" | "received",
  pubkeys: string[],
): string[] {
  const reports: Report[] = [];
  for (const pubkey of pubkeys) {
    if (direction === "sent") {
      reports.push(...reportsRepo.listBySender(pubkey, { limit: 1000 }));
    } else {
      reports.push(...reportsRepo.listByRecipient(pubkey, { limit: 1000 }));
    }
  }
  const repos = new Set<string>();
  for (const r of reports) {
    repos.add(r.repo_url);
  }
  return Array.from(repos).sort();
}

function getStatusCounts(
  reportsRepo: ReportsRepository,
  direction: "sent" | "received",
  pubkeys: string[],
): Record<string, number> {
  const reports: Report[] = [];
  for (const pubkey of pubkeys) {
    if (direction === "sent") {
      reports.push(...reportsRepo.listBySender(pubkey, { limit: 1000 }));
    } else {
      reports.push(...reportsRepo.listByRecipient(pubkey, { limit: 1000 }));
    }
  }
  const counts: Record<string, number> = {
    active: 0,
    pending: 0,
    accepted: 0,
    rejected: 0,
    completed: 0,
  };
  for (const r of reports) {
    if (counts[r.status] !== undefined) {
      counts[r.status]++;
    }
    if (r.status !== "completed") {
      counts.active++;
    }
  }
  return counts;
}

function findIdentityForReport(
  recipientPubkey: string,
  identityManager: IdentityManager,
  config: Config,
): string | null {
  // Find which identity matches the recipient pubkey
  for (const identity of identityManager.getAllIdentities()) {
    if (identity.client.getPublicKey() === recipientPubkey) {
      return identity.name;
    }
  }
  // Fall back to default identity if only one exists
  const identityNames = Object.keys(config.identities);
  if (identityNames.length === 1) {
    return identityNames[0];
  }
  return config.defaultIdentity ?? null;
}
