import type { IpcClient } from "../../server/ipc-client.js";
import type { IdentityManager } from "../../services/identity/manager.js";
import type { DatabaseWrapper } from "../../storage/database.js";
import type { Inbox } from "../../types/config.js";
import {
  ReportsRepository,
  BountiesRepository,
  ResponsesRepository,
  BlockedRepository,
} from "../../storage/repositories/index.js";
import type { Tool, ToolHandler } from "../shared/index.js";

interface MaintainerConfig {
  enabled: boolean;
  inboxes: Inbox[];
}

export function createMaintainerTools(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: MaintainerConfig,
  daemonClient: IpcClient | null
) {
  const definitions: Tool[] = [
    {
      name: "list_reports",
      description: "List incoming bug reports for an inbox",
      inputSchema: {
        type: "object",
        properties: {
          inbox: {
            type: "string",
            description:
              "Which inbox to list reports for. Required if multiple inboxes configured.",
          },
          status: {
            type: "string",
            enum: ["pending", "acknowledged", "accepted", "rejected", "all"],
            default: "pending",
          },
          limit: {
            type: "number",
            default: 50,
          },
        },
      },
    },
    {
      name: "get_report_details",
      description: "Get full details of a bug report",
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
      name: "accept_report",
      description:
        "Accept a bug report as valid, refunding the deposit and optionally paying bounty",
      inputSchema: {
        type: "object",
        properties: {
          inbox: {
            type: "string",
            description:
              "Which inbox identity to use. Required if multiple inboxes configured.",
          },
          report_id: {
            type: "string",
            description: "The bug report ID to accept",
          },
          message: {
            type: "string",
            description: "Optional message to the reporter",
          },
          pay_bounty: {
            type: "boolean",
            description: "Whether to pay the bounty if available",
            default: true,
          },
        },
        required: ["report_id"],
      },
    },
    {
      name: "reject_report",
      description: "Reject a bug report as invalid or spam (keeps the deposit)",
      inputSchema: {
        type: "object",
        properties: {
          inbox: {
            type: "string",
            description: "Which inbox identity to use",
          },
          report_id: {
            type: "string",
            description: "The bug report ID to reject",
          },
          reason: {
            type: "string",
            description: "Reason for rejection",
          },
        },
        required: ["report_id", "reason"],
      },
    },
    {
      name: "publish_fix",
      description: "Announce that a fix has been published for a bug report",
      inputSchema: {
        type: "object",
        properties: {
          inbox: {
            type: "string",
            description: "Which inbox identity to use",
          },
          report_id: {
            type: "string",
            description: "The bug report ID",
          },
          commit_hash: {
            type: "string",
            description: "Git commit hash of the fix",
          },
          message: {
            type: "string",
            description: "Optional message about the fix",
          },
        },
        required: ["report_id", "commit_hash"],
      },
    },
    {
      name: "set_bounty",
      description: "Set or update bounty amount for a repository",
      inputSchema: {
        type: "object",
        properties: {
          inbox: {
            type: "string",
            description: "Which inbox identity to use",
          },
          repo: {
            type: "string",
            description: "Repository URL",
          },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Severity level for the bounty",
          },
          amount: {
            type: "number",
            description: "Bounty amount in ALPHA tokens",
          },
        },
        required: ["repo", "severity", "amount"],
      },
    },
    {
      name: "list_bounties",
      description: "List configured bounties",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Filter by repository URL",
          },
        },
      },
    },
    {
      name: "block_sender",
      description: "Block a sender from submitting future reports",
      inputSchema: {
        type: "object",
        properties: {
          pubkey: {
            type: "string",
            description: "Sender's pubkey to block",
          },
          reason: {
            type: "string",
            description: "Reason for blocking",
          },
        },
        required: ["pubkey"],
      },
    },
    {
      name: "unblock_sender",
      description: "Remove a sender from the blocklist",
      inputSchema: {
        type: "object",
        properties: {
          pubkey: {
            type: "string",
            description: "Sender's pubkey to unblock",
          },
        },
        required: ["pubkey"],
      },
    },
  ];

  const handlers = new Map<string, ToolHandler>();

  // Helper to resolve inbox name
  function resolveInboxName(inboxArg?: string): string | null {
    if (inboxArg) return inboxArg;
    if (config.inboxes.length === 1) return config.inboxes[0].identity;
    return null;
  }

  // Read-only: list_reports
  handlers.set("list_reports", async (args) => {
    const inboxName = resolveInboxName(args.inbox as string | undefined);
    if (!inboxName && config.inboxes.length > 1) {
      return {
        content: [
          {
            type: "text",
            text: "Multiple inboxes configured. Specify which inbox to use.",
          },
        ],
        isError: true,
      };
    }

    const identity = inboxName ? identityManager.getInboxIdentity(inboxName) : null;
    const recipientPubkey = identity?.client.getPublicKey();

    const reportsRepo = new ReportsRepository(db);
    const reports = reportsRepo.listReceived({
      status: args.status as any,
      limit: args.limit as number,
    });

    // Filter by recipient if we have a specific inbox
    const filteredReports = recipientPubkey
      ? reports.filter((r) => r.recipient_pubkey === recipientPubkey)
      : reports;

    if (filteredReports.length === 0) {
      return {
        content: [{ type: "text", text: "No reports found" }],
      };
    }

    let text = `Found ${filteredReports.length} reports:\n`;
    for (const report of filteredReports) {
      text += `\n- ${report.id.slice(0, 8)}... [${report.status}]`;
      text += `\n  ${report.repo_url}`;
      text += `\n  ${report.description.slice(0, 80)}...`;
      if (report.deposit_amount) {
        text += `\n  Deposit: ${report.deposit_amount} ALPHA`;
      }
    }

    return { content: [{ type: "text", text }] };
  });

  // Read-only: get_report_details
  handlers.set("get_report_details", async (args) => {
    const reportId = args.report_id as string;

    const reportsRepo = new ReportsRepository(db);
    const report = reportsRepo.findById(reportId);

    if (!report) {
      return {
        content: [{ type: "text", text: `Report not found: ${reportId}` }],
        isError: true,
      };
    }

    let text = `Report: ${report.id}
Status: ${report.status}
Direction: ${report.direction}
Repository: ${report.repo_url}`;

    if (report.file_path) {
      text += `\nFiles: ${report.file_path}`;
    }

    text += `\n\nDescription:\n${report.description}`;

    if (report.suggested_fix) {
      text += `\n\nSuggested Fix:\n${report.suggested_fix}`;
    }

    text += `\n\nSender: ${report.sender_pubkey.slice(0, 32)}...`;
    text += `\nSubmitted: ${new Date(report.created_at).toISOString()}`;

    if (report.deposit_amount) {
      text += `\nDeposit: ${report.deposit_amount} ALPHA`;
    }

    // Get responses
    const responsesRepo = new ResponsesRepository(db);
    const responses = responsesRepo.findByReportId(reportId);
    if (responses.length > 0) {
      text += "\n\nResponses:";
      for (const resp of responses) {
        text += `\n- [${resp.response_type}] ${resp.message ?? "(no message)"}`;
      }
    }

    return { content: [{ type: "text", text }] };
  });

  // Write: accept_report (routes through daemon)
  handlers.set("accept_report", async (args) => {
    const inboxName = resolveInboxName(args.inbox as string | undefined);
    if (!inboxName) {
      return {
        content: [
          {
            type: "text",
            text: "Multiple inboxes configured. Specify which inbox to use.",
          },
        ],
        isError: true,
      };
    }

    const reportId = args.report_id as string;
    const message = args.message as string | undefined;
    const payBounty = args.pay_bounty !== false;

    // Route through daemon if available
    if (daemonClient) {
      const response = await daemonClient.send({
        type: "accept_report",
        inbox: inboxName,
        reportId,
        message,
        payBounty,
      });

      if (!response.success) {
        return {
          content: [
            { type: "text", text: `Failed to accept report: ${response.error}` },
          ],
          isError: true,
        };
      }

      const data = response.data as { depositRefunded: number; bountyPaid: number };
      let text = `Report ${reportId} accepted.`;
      if (data.depositRefunded > 0) {
        text += `\nDeposit refunded: ${data.depositRefunded} ALPHA`;
      }
      if (data.bountyPaid > 0) {
        text += `\nBounty paid: ${data.bountyPaid} ALPHA`;
      }

      return { content: [{ type: "text", text }] };
    }

    // No daemon - return error for maintainer write operations
    return {
      content: [
        {
          type: "text",
          text: "Daemon not running. Start the daemon to accept reports: bounty-net daemon start",
        },
      ],
      isError: true,
    };
  });

  // Write: reject_report
  handlers.set("reject_report", async (args) => {
    const inboxName = resolveInboxName(args.inbox as string | undefined);
    if (!inboxName) {
      return {
        content: [
          { type: "text", text: "Multiple inboxes configured. Specify which inbox." },
        ],
        isError: true,
      };
    }

    if (daemonClient) {
      const response = await daemonClient.send({
        type: "reject_report",
        inbox: inboxName,
        reportId: args.report_id as string,
        reason: args.reason as string,
      });

      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Report ${args.report_id} rejected. Deposit kept.`,
          },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: "Daemon not running. Start daemon first." },
      ],
      isError: true,
    };
  });

  // Write: publish_fix
  handlers.set("publish_fix", async (args) => {
    const inboxName = resolveInboxName(args.inbox as string | undefined);
    if (!inboxName) {
      return {
        content: [{ type: "text", text: "Specify inbox." }],
        isError: true,
      };
    }

    if (daemonClient) {
      const response = await daemonClient.send({
        type: "publish_fix",
        inbox: inboxName,
        reportId: args.report_id as string,
        commitHash: args.commit_hash as string,
        message: args.message as string | undefined,
      });

      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Fix published for ${args.report_id}: ${args.commit_hash}`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: "Daemon not running." }],
      isError: true,
    };
  });

  // Write: set_bounty
  handlers.set("set_bounty", async (args) => {
    const inboxName = resolveInboxName(args.inbox as string | undefined);
    if (!inboxName) {
      return {
        content: [{ type: "text", text: "Specify inbox." }],
        isError: true,
      };
    }

    if (daemonClient) {
      const response = await daemonClient.send({
        type: "set_bounty",
        inbox: inboxName,
        repo: args.repo as string,
        severity: args.severity as string,
        amount: args.amount as number,
      });

      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Bounty set: ${args.amount} ALPHA for ${args.severity} bugs on ${args.repo}`,
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: "Daemon not running." }],
      isError: true,
    };
  });

  // Read-only: list_bounties
  handlers.set("list_bounties", async (args) => {
    const repo = args.repo as string | undefined;

    const bountiesRepo = new BountiesRepository(db);
    const bounties = repo
      ? bountiesRepo.listByRepo(repo)
      : [];

    // Also list from config
    let text = "Configured bounties:\n";
    for (const inbox of config.inboxes) {
      if (Object.keys(inbox.bounties).length > 0) {
        text += `\n${inbox.identity}:`;
        for (const [severity, amount] of Object.entries(inbox.bounties)) {
          text += `\n  ${severity}: ${amount} ALPHA`;
        }
      }
    }

    if (bounties.length > 0) {
      text += "\n\nActive bounties in database:";
      for (const bounty of bounties) {
        text += `\n- ${bounty.repo_url} [${bounty.severity ?? "any"}]: ${bounty.amount} ALPHA (${bounty.status})`;
      }
    }

    return { content: [{ type: "text", text }] };
  });

  // Write: block_sender
  handlers.set("block_sender", async (args) => {
    if (daemonClient) {
      const response = await daemonClient.send({
        type: "block_sender",
        inbox: resolveInboxName() ?? "",
        pubkey: args.pubkey as string,
        reason: args.reason as string | undefined,
      });

      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: `Blocked sender: ${(args.pubkey as string).slice(0, 16)}...` },
        ],
      };
    }

    // Direct database write as fallback
    const blockedRepo = new BlockedRepository(db);
    blockedRepo.block(args.pubkey as string, args.reason as string | undefined);
    db.save();

    return {
      content: [
        { type: "text", text: `Blocked sender: ${(args.pubkey as string).slice(0, 16)}...` },
      ],
    };
  });

  // Write: unblock_sender
  handlers.set("unblock_sender", async (args) => {
    if (daemonClient) {
      const response = await daemonClient.send({
        type: "unblock_sender",
        inbox: resolveInboxName() ?? "",
        pubkey: args.pubkey as string,
      });

      if (!response.success) {
        return {
          content: [{ type: "text", text: `Failed: ${response.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: `Unblocked sender: ${(args.pubkey as string).slice(0, 16)}...` },
        ],
      };
    }

    const blockedRepo = new BlockedRepository(db);
    blockedRepo.unblock(args.pubkey as string);
    db.save();

    return {
      content: [
        { type: "text", text: `Unblocked sender: ${(args.pubkey as string).slice(0, 16)}...` },
      ],
    };
  });

  return { definitions, handlers };
}
