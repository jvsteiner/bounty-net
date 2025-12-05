/**
 * MCP Tools for the unified daemon.
 * All tools run in-process with direct database access.
 */

import { v4 as uuid } from "uuid";
import type { IdentityManager } from "../services/identity/manager.js";
import type { DatabaseWrapper } from "../storage/database.js";
import type { Config } from "../types/config.js";
import {
  ReportsRepository,
  ResponsesRepository,
} from "../storage/repositories/index.js";
import {
  fetchBountyNetFile,
  readLocalBountyNetFile,
} from "../cli/commands/repo.js";
import { COINS } from "../constants/coins.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("mcp-tools");

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export function createMcpTools(
  identityManager: IdentityManager,
  db: DatabaseWrapper,
  config: Config,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // Helper to resolve inbox name
  function resolveInboxName(inboxArg?: string): string | null {
    if (inboxArg) return inboxArg;
    if (config.maintainer.inboxes.length === 1) {
      return config.maintainer.inboxes[0].identity;
    }
    return null;
  }

  // ========== SHARED TOOLS ==========

  tools.push({
    name: "get_balance",
    description: "Get wallet balance for an identity",
    inputSchema: {
      type: "object",
      properties: {
        identity: {
          type: "string",
          description: "Identity name. Defaults to reporter identity.",
        },
      },
    },
    handler: async (args) => {
      const identityName =
        (args.identity as string) ?? config.reporter?.identity;
      if (!identityName) {
        return {
          content: [{ type: "text", text: "No identity specified" }],
          isError: true,
        };
      }

      const identity = identityManager.get(identityName);
      if (!identity) {
        return {
          content: [{ type: "text", text: `Identity not found: ${identityName}` }],
          isError: true,
        };
      }

      await identity.wallet.reload();
      const balance = await identity.wallet.getBalance(COINS.ALPHA);

      return {
        content: [
          {
            type: "text",
            text: `Balance for ${identityName}: ${balance} ALPHA`,
          },
        ],
      };
    },
  });

  // ========== REPORTER TOOLS ==========

  if (config.reporter?.enabled) {
    const reporterIdentity = identityManager.getReporterIdentity();

    if (reporterIdentity) {
      tools.push({
        name: "report_bug",
        description:
          "Submit a bug report to a project maintainer with a deposit",
        inputSchema: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Description of the bug",
            },
            repo_url: {
              type: "string",
              description: "Repository URL (e.g., https://github.com/org/repo)",
            },
            maintainer: {
              type: "string",
              description:
                "Maintainer's nametag (e.g., name@unicity). Get from repo's .bounty-net.yaml",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "List of affected file paths",
            },
            suggested_fix: {
              type: "string",
              description: "Optional suggested fix",
            },
          },
          required: ["description", "repo_url", "maintainer"],
        },
        handler: async (args) => {
          const description = args.description as string;
          const repoUrl = args.repo_url as string;
          const maintainerNametag = args.maintainer as string;
          const files = args.files as string[] | undefined;
          const suggestedFix = args.suggested_fix as string | undefined;

          // Resolve nametag to pubkey
          const maintainerPubkey = await reporterIdentity.client.resolveNametag(maintainerNametag);
          if (!maintainerPubkey) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to resolve maintainer: ${maintainerNametag}`,
                },
              ],
              isError: true,
            };
          }

          // Reload wallet
          await reporterIdentity.wallet.reload();

          // Get deposit amount
          const depositAmount = config.reporter?.defaultDeposit ?? 100;

          // Generate report ID
          const reportId = uuid();

          // Send deposit
          const depositResult = await reporterIdentity.wallet.sendDeposit(
            maintainerPubkey,
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

          // Build report content
          const content = {
            bug_id: reportId,
            repo: repoUrl,
            files,
            description,
            suggested_fix: suggestedFix,
            agent_model: process.env.AGENT_MODEL,
            agent_version: process.env.AGENT_VERSION,
            sender_nametag: reporterIdentity.nametag,
          };

          // Publish to NOSTR
          const eventId = await reporterIdentity.client.publishBugReport(
            content,
            maintainerPubkey,
          );

          // Store report locally
          const reportsRepo = new ReportsRepository(db);
          reportsRepo.create({
            id: reportId,
            repo_url: repoUrl,
            file_path: files?.join(", "),
            description,
            suggested_fix: suggestedFix,
            agent_model: content.agent_model,
            agent_version: content.agent_version,
            sender_pubkey: reporterIdentity.client.getPublicKey(),
            recipient_pubkey: maintainerPubkey,
            status: "pending",
            created_at: Date.now(),
            updated_at: Date.now(),
            nostr_event_id: eventId,
          });

          logger.info(`Bug report submitted: ${reportId}`);

          return {
            content: [
              {
                type: "text",
                text: `Bug report submitted successfully!

Report ID: ${reportId}
Event ID: ${eventId}
Deposit: ${depositAmount} ALPHA

The maintainer will be notified.`,
              },
            ],
          };
        },
      });

      tools.push({
        name: "list_my_reports",
        description: "List bug reports you have submitted",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "acknowledged", "accepted", "rejected", "all"],
              default: "all",
            },
            limit: {
              type: "number",
              default: 50,
            },
          },
        },
        handler: async (args) => {
          const reportsRepo = new ReportsRepository(db);
          const reports = reportsRepo.listBySender(
            reporterIdentity.client.getPublicKey(),
            {
              status: args.status as
                | "pending"
                | "acknowledged"
                | "accepted"
                | "rejected"
                | "all",
              limit: (args.limit as number) ?? 50,
            },
          );

          if (reports.length === 0) {
            return {
              content: [{ type: "text", text: "No reports found" }],
            };
          }

          let text = `Found ${reports.length} reports:\n`;
          for (const report of reports) {
            text += `\n- ${report.id.slice(0, 8)}... [${report.status}]`;
            text += `\n  ${report.repo_url}`;
            text += `\n  ${report.description.slice(0, 80)}...`;
          }

          return { content: [{ type: "text", text }] };
        },
      });
    }
  }

  // ========== MAINTAINER TOOLS ==========

  if (config.maintainer?.enabled && config.maintainer.inboxes.length > 0) {
    tools.push({
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
      handler: async (args) => {
        const inboxName = resolveInboxName(args.inbox as string | undefined);
        if (!inboxName && config.maintainer.inboxes.length > 1) {
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

        if (!recipientPubkey) {
          return {
            content: [{ type: "text", text: "No inbox identity found" }],
            isError: true,
          };
        }

        const reportsRepo = new ReportsRepository(db);
        const filteredReports = reportsRepo.listByRecipient(recipientPubkey, {
          status: args.status as
            | "pending"
            | "acknowledged"
            | "accepted"
            | "rejected"
            | "all",
          limit: args.limit as number,
        });

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
        }

        return { content: [{ type: "text", text }] };
      },
    });

    tools.push({
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
      handler: async (args) => {
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

        const responsesRepo = new ResponsesRepository(db);
        const responses = responsesRepo.findByReportId(reportId);
        if (responses.length > 0) {
          text += "\n\nResponses:";
          for (const resp of responses) {
            text += `\n- [${resp.response_type}] ${resp.message ?? "(no message)"}`;
          }
        }

        return { content: [{ type: "text", text }] };
      },
    });

    tools.push({
      name: "accept_report",
      description:
        "Accept a bug report as valid. Pays the reward from repo's .bounty-net.yaml.",
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
          reward: {
            type: "number",
            description:
              "Custom reward amount in ALPHA tokens. If not specified, uses the reward from repo's .bounty-net.yaml.",
          },
        },
        required: ["report_id"],
      },
      handler: async (args) => {
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

        const inbox = identityManager.getInboxIdentity(inboxName);
        if (!inbox) {
          return {
            content: [{ type: "text", text: `Inbox not found: ${inboxName}` }],
            isError: true,
          };
        }

        await inbox.wallet.reload();

        const reportId = args.report_id as string;
        const message = args.message as string | undefined;
        let rewardAmount = args.reward as number | undefined;

        const reportsRepo = new ReportsRepository(db);
        const report = reportsRepo.findById(reportId);

        if (!report) {
          return {
            content: [{ type: "text", text: `Report not found: ${reportId}` }],
            isError: true,
          };
        }

        if (report.status !== "pending" && report.status !== "acknowledged") {
          return {
            content: [
              { type: "text", text: `Report already ${report.status}` },
            ],
            isError: true,
          };
        }

        // Get reward from .bounty-net.yaml if not specified
        if (rewardAmount === undefined) {
          const localConfig = readLocalBountyNetFile();
          if (
            localConfig?.repo === report.repo_url &&
            localConfig?.reward !== undefined
          ) {
            rewardAmount = localConfig.reward;
          } else {
            try {
              const repoConfig = await fetchBountyNetFile(report.repo_url);
              if (repoConfig?.reward !== undefined) {
                rewardAmount = repoConfig.reward;
              }
            } catch {
              // Ignore fetch errors
            }
          }
        }

        rewardAmount = rewardAmount ?? 0;

        // Send reward payment
        let rewardPaid = 0;
        if (rewardAmount > 0) {
          const paymentResult = await inbox.wallet.sendBounty(
            report.sender_pubkey,
            BigInt(rewardAmount),
            reportId,
          );
          if (!paymentResult.success) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to send payment: ${paymentResult.error}`,
                },
              ],
              isError: true,
            };
          }
          rewardPaid = rewardAmount;
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
        const responsesRepo = new ResponsesRepository(db);
        responsesRepo.create({
          id: uuid(),
          report_id: reportId,
          response_type: "accepted",
          message: responseMessage,
          responder_pubkey: inbox.client.getPublicKey(),
          created_at: Date.now(),
        });

        logger.info(`Report ${reportId} accepted. Reward: ${rewardPaid}`);

        let text = `Report ${reportId} accepted.`;
        if (rewardPaid > 0) {
          text += `\nReward paid: ${rewardPaid} ALPHA`;
        }

        return { content: [{ type: "text", text }] };
      },
    });

    tools.push({
      name: "reject_report",
      description:
        "Reject a bug report as invalid or spam (keeps the deposit)",
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
      handler: async (args) => {
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

        const inbox = identityManager.getInboxIdentity(inboxName);
        if (!inbox) {
          return {
            content: [{ type: "text", text: `Inbox not found: ${inboxName}` }],
            isError: true,
          };
        }

        const reportId = args.report_id as string;
        const reason = args.reason as string;

        const reportsRepo = new ReportsRepository(db);
        const report = reportsRepo.findById(reportId);

        if (!report) {
          return {
            content: [{ type: "text", text: `Report not found: ${reportId}` }],
            isError: true,
          };
        }

        if (report.status !== "pending" && report.status !== "acknowledged") {
          return {
            content: [
              { type: "text", text: `Report already ${report.status}` },
            ],
            isError: true,
          };
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
        const responsesRepo = new ResponsesRepository(db);
        responsesRepo.create({
          id: uuid(),
          report_id: reportId,
          response_type: "rejected",
          message: reason,
          responder_pubkey: inbox.client.getPublicKey(),
          created_at: Date.now(),
        });

        logger.info(`Report ${reportId} rejected: ${reason}`);

        return {
          content: [
            {
              type: "text",
              text: `Report ${reportId} rejected. Deposit kept.`,
            },
          ],
        };
      },
    });

    tools.push({
      name: "resolve_maintainer",
      description: "Resolve a maintainer's public key from a repository URL or nametag",
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Repository URL to fetch .bounty-net.yaml from",
          },
          nametag: {
            type: "string",
            description: "Nametag to resolve directly (e.g., name@unicity)",
          },
        },
      },
      handler: async (args) => {
        const repoUrl = args.repo_url as string | undefined;
        const nametag = args.nametag as string | undefined;

        if (repoUrl) {
          try {
            const repoConfig = await fetchBountyNetFile(repoUrl);
            if (!repoConfig) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No .bounty-net.yaml found in repository",
                  },
                ],
                isError: true,
              };
            }

            const firstIdentity = identityManager.getFirst();
            if (!firstIdentity) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Maintainer nametag: ${repoConfig.maintainer}\nCould not resolve pubkey (no identity available)`,
                  },
                ],
              };
            }

            const pubkey = await firstIdentity.client.resolveNametag(
              repoConfig.maintainer,
            );

            return {
              content: [
                {
                  type: "text",
                  text: `Maintainer: ${repoConfig.maintainer}
Public Key: ${pubkey ?? "(could not resolve)"}
Deposit: ${repoConfig.deposit ?? "(not set)"}
Reward: ${repoConfig.reward ?? "(not set)"}`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to fetch repo config: ${error}`,
                },
              ],
              isError: true,
            };
          }
        }

        if (nametag) {
          const firstIdentity = identityManager.getFirst();
          if (!firstIdentity) {
            return {
              content: [
                {
                  type: "text",
                  text: "No identity available to resolve nametag",
                },
              ],
              isError: true,
            };
          }

          const pubkey = await firstIdentity.client.resolveNametag(nametag);
          if (!pubkey) {
            return {
              content: [
                { type: "text", text: `Could not resolve nametag: ${nametag}` },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Nametag: ${nametag}\nPublic Key: ${pubkey}`,
              },
            ],
          };
        }

        return {
          content: [
            { type: "text", text: "Must provide either repo_url or nametag" },
          ],
          isError: true,
        };
      },
    });

    tools.push({
      name: "search_known_issues",
      description: "Search for existing bug reports in a repository",
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
      handler: async (args) => {
        const repoUrl = args.repo_url as string;
        const query = (args.query as string) ?? "";

        const reportsRepo = new ReportsRepository(db);
        const reports = reportsRepo.search(query, {
          repo: repoUrl,
          limit: 20,
        });

        if (reports.length === 0) {
          return {
            content: [
              { type: "text", text: "No matching reports found" },
            ],
          };
        }

        let text = `Found ${reports.length} reports:\n`;
        for (const report of reports) {
          text += `\n- ${report.id.slice(0, 8)}... [${report.status}]`;
          if (report.file_path) {
            text += `\n  Files: ${report.file_path}`;
          }
          text += `\n  ${report.description?.slice(0, 80)}...`;
        }

        return { content: [{ type: "text", text }] };
      },
    });
  }

  return tools;
}
