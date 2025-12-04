import { v4 as uuid } from "uuid";
import type { ManagedIdentity } from "../../services/identity/manager.js";
import type { DatabaseWrapper } from "../../storage/database.js";
import { ReportsRepository } from "../../storage/repositories/index.js";
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
  config: ReporterConfig,
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
            description:
              "Repository URL (auto-detected from .bounty-net.yaml if not provided)",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "File paths with optional line numbers (e.g., ['src/main.rs:123-145', 'src/lib.rs:10-20'])",
          },
          description: {
            type: "string",
            description: "Detailed bug description",
          },
          suggested_fix: {
            type: "string",
            description: "Suggested code fix (optional)",
          },
        },
        required: ["description"],
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
  ];

  const handlers = new Map<string, ToolHandler>();

  handlers.set("report_bug", async (args) => {
    let maintainerInput = args.maintainer as string | undefined;
    let repoUrl = args.repo_url as string | undefined;
    const description = args.description as string;
    const suggestedFix = args.suggested_fix as string | undefined;
    const files = args.files as string[] | undefined;
    let depositAmount: number | undefined;

    // Auto-detect from .bounty-net.yaml if not provided
    const localConfig = readLocalBountyNetFile();
    if (localConfig) {
      if (!maintainerInput) {
        maintainerInput = localConfig.maintainer;
      }
      if (!repoUrl && localConfig.repo) {
        repoUrl = localConfig.repo;
      }
      if (depositAmount === undefined && localConfig.deposit !== undefined) {
        depositAmount = localConfig.deposit;
      }
    }

    // Fall back to config default if still not set
    if (depositAmount === undefined) {
      depositAmount = config.defaultDeposit;
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

    // Parse file paths - join as comma-separated for storage
    const filesStr = files?.join(", ");

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
      reportId,
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

    // Build report content (deposit is in the token transfer, not duplicated here)
    const content = {
      bug_id: reportId,
      repo: repoUrl,
      files,
      description,
      suggested_fix: suggestedFix,
      agent_model: process.env.AGENT_MODEL,
      agent_version: process.env.AGENT_VERSION,
    };

    // Publish to NOSTR
    const eventId = await identity.client.publishBugReport(
      content,
      recipientPubkey,
    );

    // Store report locally (tokens on disk are source of truth for payments)
    const reportsRepo = new ReportsRepository(db);
    reportsRepo.create({
      id: reportId,
      repo_url: repoUrl,
      file_path: filesStr,
      description,
      suggested_fix: suggestedFix,
      agent_model: content.agent_model,
      agent_version: content.agent_version,
      sender_pubkey: identity.client.getPublicKey(),
      recipient_pubkey: recipientPubkey,
      status: "pending",
      created_at: Date.now(),
      updated_at: Date.now(),
      nostr_event_id: eventId,
    });

    return {
      content: [
        {
          type: "text",
          text: `Bug report submitted successfully!

Report ID: ${reportId}
Event ID: ${eventId}
Deposit: ${depositAmount} ALPHA (tx: ${depositResult.txHash})

The maintainer will be notified.`,
        },
      ],
    };
  });

  handlers.set("list_my_reports", async (args) => {
    const status = args.status as string | undefined;
    const limit = (args.limit as number) ?? 20;

    const reportsRepo = new ReportsRepository(db);
    const reports = reportsRepo.listBySender(identity.client.getPublicKey(), {
      status: status as
        | "pending"
        | "acknowledged"
        | "accepted"
        | "rejected"
        | "all",
      limit,
    });

    if (reports.length === 0) {
      return {
        content: [{ type: "text", text: "No reports found" }],
      };
    }

    let text = `Found ${reports.length} reports:\n`;
    for (const report of reports) {
      text += `\n- ${report.id.slice(0, 8)}... [${report.status}] ${report.repo_url}`;
    }

    return {
      content: [{ type: "text", text }],
    };
  });

  return { definitions, handlers };
}
