import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../config/loader.js";
import { openDatabase, DatabaseWrapper } from "../storage/database.js";
import { IdentityManager } from "../services/identity/manager.js";
import {
  createSharedTools,
  type Tool,
  type ToolHandler,
} from "../tools/shared/index.js";
import { createReporterTools } from "../tools/reporter/index.js";
import { createMaintainerTools } from "../tools/maintainer/index.js";
import { getDaemonClient, disconnectDaemonClient } from "./ipc-client.js";
import { backfillResponses } from "./backfill.js";
import { PATHS } from "../constants/paths.js";
import { createLogger } from "../utils/logger.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

export async function runServer(): Promise<void> {
  // Enable logging for MCP server
  if (process.env.LOG_LEVEL === "silent") {
    process.env.LOG_LEVEL = "info";
  }
  const logger = createLogger("mcp-server");

  logger.info("Starting MCP server");

  // Load configuration
  const config = await loadConfig();

  // Open database (daemon must create it first)
  const rawDb = openDatabase(config.database ?? PATHS.DATABASE);
  const db = new DatabaseWrapper(rawDb);

  // Check if daemon is running
  const daemonClient = await getDaemonClient();
  const daemonRunning = daemonClient !== null;

  logger.info(
    `MCP server starting (daemon: ${daemonRunning ? "connected" : "not running"})`,
  );

  // Initialize identity manager
  const identityManager = new IdentityManager(config);
  await identityManager.initialize();

  // For reporter-only mode without daemon: backfill responses on startup
  if (config.reporter?.enabled && !daemonRunning) {
    const reporterIdentity = identityManager.getReporterIdentity();
    if (reporterIdentity) {
      await backfillResponses(reporterIdentity, db);
    }
  }

  // Create MCP server
  const server = new Server(
    { name: "bounty-net", version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Collect tools based on enabled roles
  const tools: Tool[] = [];
  const handlers: Map<string, ToolHandler> = new Map();

  // Always include shared tools
  const sharedTools = createSharedTools(identityManager, db, config);
  tools.push(...sharedTools.definitions);
  sharedTools.handlers.forEach((h, name) => handlers.set(name, h));

  // Reporter tools if enabled
  if (config.reporter?.enabled) {
    const reporterIdentity = identityManager.getReporterIdentity();
    if (!reporterIdentity) {
      throw new Error(
        `Reporter identity "${config.reporter.identity}" not found in identities`,
      );
    }

    const reporterTools = createReporterTools(
      reporterIdentity,
      db,
      config.reporter,
    );
    tools.push(...reporterTools.definitions);
    reporterTools.handlers.forEach((h, name) => handlers.set(name, h));
  }

  // Maintainer tools if enabled
  if (config.maintainer?.enabled && config.maintainer.inboxes.length > 0) {
    const maintainerTools = createMaintainerTools(
      identityManager,
      db,
      config.maintainer,
      daemonClient,
    );
    tools.push(...maintainerTools.definitions);
    maintainerTools.handlers.forEach((h, name) => handlers.set(name, h));
  }

  logger.info(`Registered ${tools.length} tools`);

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers.get(name);

    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }

    logger.debug(`Calling tool: ${name}`);
    return handler(args ?? {});
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server running");

  // Graceful shutdown
  process.on("SIGINT", () => {
    logger.info("Shutting down...");
    disconnectDaemonClient();
    identityManager.disconnect();
    db.close();
    process.exit(0);
  });
}
