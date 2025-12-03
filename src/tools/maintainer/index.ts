import type { IpcClient } from "../../server/ipc-client.js";
import type { IdentityManager } from "../../services/identity/manager.js";
import type { DatabaseWrapper } from "../../storage/database.js";
import type { Inbox } from "../../types/config.js";
import {
  ReportsRepository,
  ResponsesRepository,
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
  daemonClient: IpcClient | null,
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

    const identity = inboxName
      ? identityManager.getInboxIdentity(inboxName)
      : null;
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
            {
              type: "text",
              text: `Failed to accept report: ${response.error}`,
            },
          ],
          isError: true,
        };
      }

      const data = response.data as {
        depositRefunded: number;
        bountyPaid: number;
      };
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
          {
            type: "text",
            text: "Multiple inboxes configured. Specify which inbox.",
          },
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

  return { definitions, handlers };
}
