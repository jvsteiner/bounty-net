import { v4 as uuid } from "uuid";
import type { ManagedIdentity } from "../../services/identity/manager.js";
import type { DatabaseWrapper } from "../../storage/database.js";
import {
  ReportsRepository,
  TransactionsRepository,
} from "../../storage/repositories/index.js";
import { BugReportContentSchema, type Severity } from "../../types/events.js";
import { COINS } from "../../constants/coins.js";
import type { Tool, ToolHandler } from "../shared/index.js";
import { readLocalBountyNetFile } from "../../cli/commands/repo.js";

interface ReporterConfig {
  enabled: boolean;
  identity: string;
  defaultDeposit: number;
  maxReportsPerHour: number;
}

export function createReporterTools(
  identity: ManagedIdentity,
  db: DatabaseWrapper,
  config: ReporterConfig
) {
  const definitions: Tool[] = [
    {
      name: "report_bug",
      description:
        "Submit a bug report to a library maintainer with a deposit stake. If maintainer and repo_url are not provided, they will be auto-detected from .bounty-net.yaml in the current directory.",
      inputSchema: {
        type: "object",
        properties: {
          maintainer: {
            type: "string",
            description:
              "Maintainer's npub, nametag, or pubkey hex (auto-detected from .bounty-net.yaml if not provided)",
          },
          repo_url: {
            type: "string",
            description: "Repository URL (auto-detected from .bounty-net.yaml if not provided)",
          },
          file_path: {
            type: "string",
            description:
              "File path with optional line numbers (e.g., src/main.rs:123-145)",
          },
          description: {
            type: "string",
            description: "Detailed bug description",
          },
          suggested_fix: {
            type: "string",
            description: "Suggested code fix (optional)",
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Bug severity level",
          },
          category: {
            type: "string",
            description: "Bug category (e.g., memory-leak, race-condition)",
          },
          deposit_amount: {
            type: "number",
            description: `Deposit amount in ALPHA tokens (default: ${config.defaultDeposit})`,
          },
        },
        required: ["description", "severity"],
      },
    },
    {
      name: "get_report_status",
      description: "Check the status of a submitted bug report",
      inputSchema: {
        type: "object",
        properties: {
          report_id: {
            type: "string",
            description: "The bug report ID",
          },
        },
        required: ["report_id"],
      },
    },
    {
      name: "list_my_reports",
      description: "List all bug reports submitted by this agent",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pending", "acknowledged", "accepted", "rejected", "all"],
            description: "Filter by status",
          },
          limit: {
            type: "number",
            description: "Maximum number of reports to return",
          },
        },
      },
    },
    {
      name: "search_known_issues",
      description: "Search for existing bug reports on a library",
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Repository URL to search",
          },
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["repo_url"],
      },
    },
  ];

  const handlers = new Map<string, ToolHandler>();

  handlers.set("report_bug", async (args) => {
    let maintainerInput = args.maintainer as string | undefined;
    let repoUrl = args.repo_url as string | undefined;
    const description = args.description as string;
    const severity = args.severity as Severity;
    const suggestedFix = args.suggested_fix as string | undefined;
    const category = args.category as string | undefined;
    const depositAmount = (args.deposit_amount as number) ?? config.defaultDeposit;

    // Auto-detect from .bounty-net.yaml if not provided
    if (!maintainerInput || !repoUrl) {
      const localConfig = readLocalBountyNetFile();
      if (localConfig) {
        if (!maintainerInput) {
          maintainerInput = localConfig.maintainer;
        }
        if (!repoUrl && localConfig.repo) {
          repoUrl = localConfig.repo;
        }
      }
    }

    // Validate we have required fields
    if (!maintainerInput) {
      return {
        content: [
          {
            type: "text",
            text: "No maintainer specified and no .bounty-net.yaml found in current directory. Please provide a maintainer nametag or pubkey.",
          },
        ],
        isError: true,
      };
    }

    if (!repoUrl) {
      return {
        content: [
          {
            type: "text",
            text: "No repo_url specified and no .bounty-net.yaml found with repo field. Please provide a repository URL.",
          },
        ],
        isError: true,
      };
    }

    // Parse file path for line numbers
    let filePath = args.file_path as string | undefined;
    let lineStart: number | undefined;
    let lineEnd: number | undefined;

    if (filePath) {
      const match = filePath.match(/^(.+):(\d+)(?:-(\d+))?$/);
      if (match) {
        filePath = match[1];
        lineStart = parseInt(match[2], 10);
        lineEnd = match[3] ? parseInt(match[3], 10) : lineStart;
      }
    }

    // Resolve maintainer pubkey
    let recipientPubkey: string;

    if (maintainerInput.length === 64 && /^[a-f0-9]+$/i.test(maintainerInput)) {
      // Already a hex pubkey
      recipientPubkey = maintainerInput;
    } else {
      // Try to resolve as nametag
      const resolved = await identity.client.resolveNametag(maintainerInput);
      if (!resolved) {
        return {
          content: [
            {
              type: "text",
              text: `Could not resolve maintainer: ${maintainerInput}. Please provide a hex pubkey or valid nametag.`,
            },
          ],
          isError: true,
        };
      }
      recipientPubkey = resolved;
    }

    // Generate report ID
    const reportId = uuid();

    // Send deposit
    const depositResult = await identity.wallet.sendDeposit(
      recipientPubkey,
      BigInt(depositAmount),
      reportId
    );

    if (!depositResult.success) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to send deposit: ${depositResult.error}`,
          },
        ],
        isError: true,
      };
    }

    // Build report content
    const content = {
      bug_id: reportId,
      repo: repoUrl,
      file: filePath,
      line_start: lineStart,
      line_end: lineEnd,
      description,
      suggested_fix: suggestedFix,
      severity,
      category,
      agent_model: process.env.AGENT_MODEL,
      agent_version: process.env.AGENT_VERSION,
      deposit_tx: depositResult.txHash,
      deposit_amount: depositAmount.toString(),
    };

    // Publish to NOSTR
    const eventId = await identity.client.publishBugReport(
      content,
      recipientPubkey
    );

    // Store locally
    const reportsRepo = new ReportsRepository(db);
    reportsRepo.create({
      id: reportId,
      repo_url: repoUrl,
      file_path: filePath,
      line_start: lineStart,
      line_end: lineEnd,
      description,
      suggested_fix: suggestedFix,
      severity,
      category,
      agent_model: content.agent_model,
      agent_version: content.agent_version,
      sender_pubkey: identity.client.getPublicKey(),
      recipient_pubkey: recipientPubkey,
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
      recipient_pubkey: recipientPubkey,
      related_report_id: reportId,
      status: "confirmed",
      created_at: Date.now(),
      confirmed_at: Date.now(),
    });

    db.save();

    return {
      content: [
        {
          type: "text",
          text: `Bug report submitted successfully!

Report ID: ${reportId}
Event ID: ${eventId}
Deposit: ${depositAmount} ALPHA (tx: ${depositResult.txHash})

The maintainer will be notified. Use get_report_status to check for responses.`,
        },
      ],
    };
  });

  handlers.set("get_report_status", async (args) => {
    const reportId = args.report_id as string;

    const reportsRepo = new ReportsRepository(db);
    const report = reportsRepo.findById(reportId);

    if (!report) {
      return {
        content: [{ type: "text", text: `Report not found: ${reportId}` }],
        isError: true,
      };
    }

    if (report.direction !== "sent") {
      return {
        content: [{ type: "text", text: "This is not a report you submitted" }],
        isError: true,
      };
    }

    let text = `Report: ${report.id}
Status: ${report.status}
Repository: ${report.repo_url}
Severity: ${report.severity}
Submitted: ${new Date(report.created_at).toISOString()}`;

    if (report.deposit_amount) {
      text += `\nDeposit: ${report.deposit_amount} ALPHA`;
    }

    return {
      content: [{ type: "text", text }],
    };
  });

  handlers.set("list_my_reports", async (args) => {
    const status = args.status as string | undefined;
    const limit = (args.limit as number) ?? 20;

    const reportsRepo = new ReportsRepository(db);
    const reports = reportsRepo.listSent({
      status: status as "pending" | "acknowledged" | "accepted" | "rejected" | "all",
      limit,
    });

    if (reports.length === 0) {
      return {
        content: [{ type: "text", text: "No reports found" }],
      };
    }

    let text = `Found ${reports.length} reports:\n`;
    for (const report of reports) {
      text += `\n- ${report.id.slice(0, 8)}... [${report.status}] ${report.severity}: ${report.repo_url}`;
    }

    return {
      content: [{ type: "text", text }],
    };
  });

  handlers.set("search_known_issues", async (args) => {
    const repoUrl = args.repo_url as string;
    const query = args.query as string | undefined;

    const reportsRepo = new ReportsRepository(db);
    const reports = query
      ? reportsRepo.search(query, { repo: repoUrl, limit: 20 })
      : reportsRepo.listReceived({ repo: repoUrl, limit: 20 });

    if (reports.length === 0) {
      return {
        content: [{ type: "text", text: `No known issues for ${repoUrl}` }],
      };
    }

    let text = `Found ${reports.length} known issues for ${repoUrl}:\n`;
    for (const report of reports) {
      text += `\n- [${report.severity}] ${report.description.slice(0, 100)}...`;
    }

    return {
      content: [{ type: "text", text }],
    };
  });

  return { definitions, handlers };
}
