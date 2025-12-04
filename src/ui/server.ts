import express, { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
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
import type { IpcClient } from "../server/ipc-client.js";

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

  // Add all known identities from config
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
  config: Config,
): Promise<{ name: string; nametag?: string; balance: number }[]> {
  const balances: { name: string; nametag?: string; balance: number }[] = [];

  // Get reporter balance
  if (config.reporter?.identity) {
    const reporter = identityManager.get(config.reporter.identity);
    if (reporter) {
      const balance = await reporter.wallet.getBalance(COINS.ALPHA);
      balances.push({
        name: reporter.name,
        nametag: reporter.nametag,
        balance: Number(balance),
      });
    }
  }

  // Get inbox balances (avoid duplicates if same identity)
  const seenNames = new Set(balances.map((b) => b.name));
  for (const inbox of config.maintainer.inboxes) {
    if (seenNames.has(inbox.identity)) continue;
    const identity = identityManager.get(inbox.identity);
    if (identity) {
      const balance = await identity.wallet.getBalance(COINS.ALPHA);
      balances.push({
        name: identity.name,
        nametag: identity.nametag,
        balance: Number(balance),
      });
      seenNames.add(inbox.identity);
    }
  }

  return balances;
}

// In dev, files are in src/ui/public. In dist, they're in dist/ui/public
// __dirname will be dist/ when running from built code, so we go to dist/ui/public
const publicDir = path.join(__dirname, "ui", "public");

export const UI_PORT = 1976;

export function createUiServer(
  db: DatabaseWrapper,
  identityManager: IdentityManager,
  config: Config,
  daemonClient: IpcClient | null,
) {
  const app = express();

  // Collect all identity pubkeys for queries
  const allPubkeys: string[] = [];
  const reporterPubkeys: string[] = [];
  const inboxPubkeys: string[] = [];

  // Reporter identity
  if (config.reporter?.identity) {
    const reporter = identityManager.get(config.reporter.identity);
    if (reporter) {
      const pk = reporter.client.getPublicKey();
      allPubkeys.push(pk);
      reporterPubkeys.push(pk);
    }
  }

  // Inbox identities
  for (const inbox of config.maintainer.inboxes) {
    const identity = identityManager.get(inbox.identity);
    if (identity) {
      const pk = identity.client.getPublicKey();
      if (!allPubkeys.includes(pk)) {
        allPubkeys.push(pk);
      }
      inboxPubkeys.push(pk);
    }
  }

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files
  app.use("/public", express.static(publicDir));

  // Test endpoint
  app.get("/api/test", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Dashboard - redirects to default tab
  app.get("/", (req: Request, res: Response) => {
    // Default to inbound if maintainer is enabled, otherwise outbound
    const defaultTab = config.maintainer?.enabled ? "inbound" : "outbound";
    res.redirect(`/${defaultTab}`);
  });

  // Outbound tab (sent reports - reporter view)
  app.get("/outbound", async (req: Request, res: Response) => {
    const status = (req.query.status as string) || "active";
    const repo = req.query.repo as string | undefined;

    const reportsRepo = new ReportsRepository(db);
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

    // "active" filter excludes completed reports
    if (status === "active") {
      reports = reports.filter((r) => r.status !== "completed");
    }

    const repos = getUniqueRepos(reportsRepo, "sent", reporterPubkeys);
    const counts = getStatusCounts(reportsRepo, "sent", reporterPubkeys);

    const nametagMap = buildNametagMap(identityManager, config);
    const balances = await getWalletBalances(identityManager, config);

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

    const reportsRepo = new ReportsRepository(db);
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

    // "active" filter excludes completed reports
    if (status === "active") {
      reports = reports.filter((r) => r.status !== "completed");
    }

    const repos = getUniqueRepos(reportsRepo, "received", inboxPubkeys);
    const counts = getStatusCounts(reportsRepo, "received", inboxPubkeys);
    const nametagMap = buildNametagMap(identityManager, config);
    const balances = await getWalletBalances(identityManager, config);

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

    const reportsRepo = new ReportsRepository(db);
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
    const reportsRepo = new ReportsRepository(db);
    const responsesRepo = new ResponsesRepository(db);

    const report = reportsRepo.findById(reportId);
    if (!report) {
      res.status(404).send("<p>Report not found</p>");
      return;
    }

    const responses = responsesRepo.findByReportId(reportId);
    const ideProtocol = config.ui?.ideProtocol || "zed";
    // Determine direction based on whether we sent it
    const isSent = reporterPubkeys.includes(report.sender_pubkey);
    const tab: TabType = isSent ? "outbound" : "inbound";

    res.send(renderReportDetail({ report, responses, ideProtocol, tab }));
  });

  // Accept report
  app.post("/api/accept/:id", async (req: Request, res: Response) => {
    try {
      const reportId = req.params.id;
      const message = req.body.message as string | undefined;
      const rewardStr = req.body.reward as string | undefined;
      const reward = rewardStr ? parseInt(rewardStr, 10) : undefined;

      if (!daemonClient) {
        logger.warn("Daemon client not available");
        res.status(503).send("Daemon not available");
        return;
      }

      // Find inbox for this report
      const reportsRepo = new ReportsRepository(db);
      const report = reportsRepo.findById(reportId);
      if (!report) {
        logger.warn(`Report not found: ${reportId}`);
        res.status(404).send("Report not found");
        return;
      }

      const inboxName = findInboxForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) {
        logger.warn(`No inbox found for report: ${reportId}`);
        res.status(400).send("No inbox found for this report");
        return;
      }

      logger.info(`Sending accept_report to daemon for inbox: ${inboxName}`);
      const response = await daemonClient.send({
        type: "accept_report",
        inbox: inboxName,
        reportId,
        message,
        reward,
      });

      if (!response.success) {
        logger.error(`Accept failed: ${response.error}`);
        res.status(500).send(`Failed: ${response.error}`);
        return;
      }

      logger.info(`Report ${reportId} accepted successfully`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Accept route error: ${errorMessage}`);
      res.status(500).send(`Failed: ${errorMessage}`);
      return;
    }

    // Return updated row for htmx swap
    const updatedReport = reportsRepo.findById(reportId);
    if (updatedReport) {
      res.send(renderReportRow(updatedReport));
    } else {
      res.send("");
    }
  });

  // Reject report
  app.post("/api/reject/:id", async (req: Request, res: Response) => {
    const reportId = req.params.id;
    const reason = (req.body.reason as string) || "Rejected via UI";

    if (!daemonClient) {
      res.status(503).send("Daemon not available");
      return;
    }

    const reportsRepo = new ReportsRepository(db);
    const report = reportsRepo.findById(reportId);
    if (!report) {
      res.status(404).send("Report not found");
      return;
    }

    const inboxName = findInboxForReport(
      report.recipient_pubkey,
      identityManager,
      config,
    );
    if (!inboxName) {
      res.status(400).send("No inbox found for this report");
      return;
    }

    const response = await daemonClient.send({
      type: "reject_report",
      inbox: inboxName,
      reportId,
      reason,
    });

    if (!response.success) {
      res.status(500).send(`Failed: ${response.error}`);
      return;
    }

    const updatedReport = reportsRepo.findById(reportId);
    if (updatedReport) {
      res.send(renderReportRow(updatedReport));
    } else {
      res.send("");
    }
  });

  // Archive report (mark as completed)
  app.post("/api/archive/:id", async (req: Request, res: Response) => {
    const reportId = req.params.id;

    const reportsRepo = new ReportsRepository(db);
    const report = reportsRepo.findById(reportId);
    if (!report) {
      res.status(404).send("Report not found");
      return;
    }

    // Only allow archiving accepted or rejected reports
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

    if (!daemonClient) {
      res.status(503).send("Daemon not available");
      return;
    }

    const results: string[] = [];
    for (const id of ids) {
      const reportsRepo = new ReportsRepository(db);
      const report = reportsRepo.findById(id);
      if (!report) continue;

      const inboxName = findInboxForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) continue;

      // No custom reward for batch - uses repo default
      await daemonClient.send({
        type: "accept_report",
        inbox: inboxName,
        reportId: id,
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

    if (!daemonClient) {
      res.status(503).send("Daemon not available");
      return;
    }

    const results: string[] = [];
    for (const id of ids) {
      const reportsRepo = new ReportsRepository(db);
      const report = reportsRepo.findById(id);
      if (!report) continue;

      const inboxName = findInboxForReport(
        report.recipient_pubkey,
        identityManager,
        config,
      );
      if (!inboxName) continue;

      await daemonClient.send({
        type: "reject_report",
        inbox: inboxName,
        reportId: id,
        reason,
      });

      const updated = reportsRepo.findById(id);
      if (updated) {
        results.push(renderReportRow(updated));
      }
    }

    res.send(results.join("\n"));
  });

  // Archive reports (set status to "completed" to hide from default view)
  app.post("/api/batch/archive", async (req: Request, res: Response) => {
    const ids = req.body.ids as string[];

    if (!ids || !Array.isArray(ids)) {
      res.status(400).send("Missing ids array");
      return;
    }

    const reportsRepo = new ReportsRepository(db);
    const results: string[] = [];

    for (const id of ids) {
      const report = reportsRepo.findById(id);
      if (!report) continue;

      // Archive by setting status to "completed"
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
    // "active" = everything except completed
    if (r.status !== "completed") {
      counts.active++;
    }
  }
  return counts;
}

function findInboxForReport(
  recipientPubkey: string,
  identityManager: IdentityManager,
  config: Config,
): string | null {
  for (const inbox of config.maintainer.inboxes) {
    const identity = identityManager.get(inbox.identity);
    if (identity && identity.client.getPublicKey() === recipientPubkey) {
      return inbox.identity;
    }
  }
  // Fallback to first inbox if only one
  if (config.maintainer.inboxes.length === 1) {
    return config.maintainer.inboxes[0].identity;
  }
  return null;
}

export function startUiServer(
  db: DatabaseWrapper,
  identityManager: IdentityManager,
  config: Config,
  daemonClient: IpcClient | null,
): void {
  const app = createUiServer(db, identityManager, config, daemonClient);

  app.listen(UI_PORT, "127.0.0.1", () => {
    logger.info(`UI server listening on http://localhost:${UI_PORT}`);
  });
}
