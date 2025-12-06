import express from "express";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "../config/loader.js";
import { initializeDatabase, DatabaseWrapper } from "../storage/database.js";
import { IdentityManager } from "../services/identity/manager.js";
import { startSync } from "./sync.js";
import { checkSingleton, writePidFile, setupCleanup } from "./process.js";
import { createLogger } from "../utils/logger.js";
import { PATHS } from "../constants/paths.js";
import { createUiRoutes } from "../ui/server.js";
import { createMcpTools } from "./mcp-tools.js";
import type { Config } from "../types/config.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

export const DAEMON_PORT = 1976;

export async function runDaemon(): Promise<void> {
  // Enable logging for daemon
  if (process.env.LOG_LEVEL === "silent") {
    process.env.LOG_LEVEL = "info";
  }
  const logger = createLogger("daemon");

  // Check singleton
  const status = checkSingleton();
  if (status.running) {
    logger.error(`Daemon already running (PID ${status.pid})`);
    process.exit(1);
  }

  // Write PID file and setup cleanup handlers
  writePidFile();
  setupCleanup();

  logger.info(`Daemon starting (PID ${process.pid})`);

  // Load config
  const config = await loadConfig();

  // Check if any identities are configured
  const identityCount = Object.keys(config.identities).length;
  if (identityCount === 0) {
    logger.error(
      "No identities configured. Create an identity first: bounty-net identity create <name>",
    );
    process.exit(1);
  }

  // Initialize database - EXCLUSIVE access, only this process touches it
  const rawDb = initializeDatabase(config.database ?? PATHS.DATABASE);
  const db = new DatabaseWrapper(rawDb);

  // Initialize identity manager
  const identityManager = new IdentityManager(config);
  await identityManager.initialize();

  logger.info(`Loaded ${identityManager.listIdentities().length} identities`);

  // Start NOSTR sync for all identities
  await startSync(identityManager, db);

  // Create Express app for both UI and MCP
  const app = express();
  app.use(express.json());

  // Session management for MCP (supports both new Streamable HTTP and legacy SSE)
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const sseTransports: Record<string, SSEServerTransport> = {};

  // Helper to create MCP server with tools (using low-level API for JSON Schema support)
  function createMcpServer(): Server {
    const tools = createMcpTools(identityManager, db, config);

    const server = new Server(
      { name: "bounty-net", version: VERSION },
      { capabilities: { tools: { listChanged: true } } },
    );

    // Handle tool listing
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return tool.handler(args);
    });

    return server;
  }

  // Legacy SSE transport endpoints (protocol version 2024-11-05)
  // GET /sse - Establish SSE stream
  app.get("/sse", async (req, res) => {
    logger.info("Legacy SSE connection request");

    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    sseTransports[sessionId] = transport;

    transport.onclose = () => {
      delete sseTransports[sessionId];
      logger.info(`Legacy SSE session closed: ${sessionId}`);
    };

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    logger.info(`Legacy SSE session started: ${sessionId}`);
  });

  // POST /messages - Handle messages for legacy SSE transport
  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports[sessionId];

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid session" },
        id: null,
      });
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing session
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New session initialization
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          logger.info(`MCP session initialized: ${id}`);
        },
        onsessionclosed: (id) => {
          delete transports[id];
          logger.info(`MCP session closed: ${id}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid session" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // MCP GET for SSE streams
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).send("Invalid session");
    }
  });

  // MCP DELETE for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports[sessionId];
    if (transport) {
      await transport.handleRequest(req, res);
    } else {
      res.status(400).send("Invalid session");
    }
  });

  // Add UI routes
  createUiRoutes(app, db, identityManager, config);

  // Start HTTP server
  app.listen(DAEMON_PORT, "127.0.0.1", () => {
    logger.info(`Daemon listening on http://localhost:${DAEMON_PORT}`);
    logger.info(`  - UI: http://localhost:${DAEMON_PORT}/`);
    logger.info(`  - MCP (Streamable HTTP): http://localhost:${DAEMON_PORT}/mcp`);
    logger.info(`  - MCP (Legacy SSE): http://localhost:${DAEMON_PORT}/sse`);
  });

  // Keep process alive
  logger.info("Daemon running. Press Ctrl+C to stop.");
}

export * from "./process.js";
export * from "./sync.js";
