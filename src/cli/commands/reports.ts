import { openDatabase, DatabaseWrapper } from "../../storage/database.js";
import { ReportsRepository } from "../../storage/repositories/reports.js";
import { ResponsesRepository } from "../../storage/repositories/responses.js";
import { loadConfig } from "../../config/loader.js";
import { PATHS } from "../../constants/paths.js";
import type { Report, ReportStatus } from "../../types/reports.js";
import { BountyNetNostrClient } from "../../services/nostr/client.js";

export async function listReports(options: {
  status?: string;
  direction?: string;
  repo?: string;
  limit?: string;
}): Promise<void> {
  try {
    const config = await loadConfig();
    const rawDb = openDatabase(config.database ?? PATHS.DATABASE);
    const db = new DatabaseWrapper(rawDb);
    const reportsRepo = new ReportsRepository(db);

    const filters = {
      status: options.status as ReportStatus | "all" | undefined,
      repo: options.repo,
      limit: options.limit ? parseInt(options.limit, 10) : 50,
      offset: 0,
    };

    // Get all identity pubkeys to determine direction
    const myPubkeys = new Set<string>();
    for (const [_, identity] of Object.entries(config.identities)) {
      const client = new BountyNetNostrClient(identity.privateKey);
      myPubkeys.add(client.getPublicKey());
    }

    const direction = options.direction ?? "all";
    let reports: Report[] = [];

    if (direction === "sent" || direction === "all") {
      // Get reports where we are the sender
      for (const pubkey of myPubkeys) {
        reports.push(...reportsRepo.listBySender(pubkey, filters));
      }
    }

    if (direction === "received" || direction === "all") {
      // Get reports where we are the recipient
      for (const pubkey of myPubkeys) {
        const received = reportsRepo.listByRecipient(pubkey, filters);
        // Avoid duplicates (self-reports)
        for (const r of received) {
          if (!reports.find((existing) => existing.id === r.id)) {
            reports.push(r);
          }
        }
      }
    }

    // Sort by created_at descending
    reports.sort((a, b) => b.created_at - a.created_at);

    if (reports.length === 0) {
      console.log("No reports found.");
      db.close();
      return;
    }

    console.log(`Found ${reports.length} report(s):\n`);

    for (const report of reports) {
      const date = new Date(report.created_at).toISOString().split("T")[0];
      const isSent = myPubkeys.has(report.sender_pubkey);
      const dirIcon = isSent ? "→" : "←";
      console.log(
        `  ${dirIcon} [${report.status}] ${report.id.slice(0, 8)}...`,
      );
      console.log(
        `    ${report.description.slice(0, 60)}${report.description.length > 60 ? "..." : ""}`,
      );
      console.log(`    Repo: ${report.repo_url}`);
      console.log(`    Date: ${date}`);
      console.log("");
    }

    db.close();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export async function showReport(id: string): Promise<void> {
  try {
    const config = await loadConfig();
    const rawDb = openDatabase(config.database ?? PATHS.DATABASE);
    const db = new DatabaseWrapper(rawDb);
    const reportsRepo = new ReportsRepository(db);
    const responsesRepo = new ResponsesRepository(db);

    // Get all identity pubkeys to determine direction
    const myPubkeys = new Set<string>();
    for (const [_, identity] of Object.entries(config.identities)) {
      const client = new BountyNetNostrClient(identity.privateKey);
      myPubkeys.add(client.getPublicKey());
    }

    // Try to find by full ID or partial match
    let report = reportsRepo.findById(id);

    if (!report) {
      // Try partial match - search all reports we're involved in
      const allReports: Report[] = [];
      for (const pubkey of myPubkeys) {
        allReports.push(...reportsRepo.listBySender(pubkey, { limit: 1000 }));
        allReports.push(
          ...reportsRepo.listByRecipient(pubkey, { limit: 1000 }),
        );
      }
      report = allReports.find((r) => r.id.startsWith(id));
    }

    if (!report) {
      console.error(`Report not found: ${id}`);
      db.close();
      process.exit(1);
    }

    const isSent = myPubkeys.has(report.sender_pubkey);
    const direction = isSent ? "sent" : "received";

    console.log("Bug Report");
    console.log("==========");
    console.log("");
    console.log(`  ID:          ${report.id}`);
    console.log(`  Status:      ${report.status}`);
    console.log(`  Direction:   ${direction}`);
    console.log(`  Repository:  ${report.repo_url}`);

    if (report.file_path) {
      console.log(`  Files:       ${report.file_path}`);
    }

    console.log(`  Created:     ${new Date(report.created_at).toISOString()}`);
    console.log(`  Updated:     ${new Date(report.updated_at).toISOString()}`);
    console.log("");
    console.log("Description:");
    console.log(`  ${report.description}`);

    if (report.suggested_fix) {
      console.log("");
      console.log("Suggested Fix:");
      console.log(`  ${report.suggested_fix}`);
    }

    console.log("");
    console.log(`  Sender:      ${report.sender_pubkey.slice(0, 16)}...`);
    console.log(`  Recipient:   ${report.recipient_pubkey.slice(0, 16)}...`);



    // Show responses
    const responses = responsesRepo.listForReport(report.id);
    if (responses.length > 0) {
      console.log("");
      console.log("Responses:");
      for (const response of responses) {
        const date = new Date(response.created_at).toISOString();
        console.log(`  - [${response.response_type}] ${date}`);
        if (response.message) {
          console.log(`    ${response.message}`);
        }
      }
    }

    db.close();
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exit(1);
  }
}

export const reportsCommands = {
  list: listReports,
  show: showReport,
};
