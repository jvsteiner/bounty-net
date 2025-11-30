import net from "net";
import fs from "fs";
import { PATHS } from "../constants/paths.js";
import { createLogger } from "../utils/logger.js";
import type { IpcRequest, IpcResponse } from "../types/ipc.js";

const logger = createLogger("ipc-server");

export type CommandHandler = (request: IpcRequest) => Promise<IpcResponse>;

export class IpcServer {
  private server: net.Server | null = null;
  private handler: CommandHandler;

  constructor(handler: CommandHandler) {
    this.handler = handler;
  }

  start(): void {
    // Remove stale socket file
    if (fs.existsSync(PATHS.DAEMON_SOCKET)) {
      logger.warn("Removing stale socket file");
      fs.unlinkSync(PATHS.DAEMON_SOCKET);
    }

    this.server = net.createServer((socket) => {
      logger.debug("Client connected");
      let buffer = "";

      socket.on("data", async (data) => {
        buffer += data.toString();

        // Simple newline-delimited JSON protocol
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const request = JSON.parse(line) as IpcRequest;
            logger.debug(`Received request: ${request.type}`);

            const response = await this.handler(request);
            socket.write(JSON.stringify(response) + "\n");
          } catch (error) {
            const errorResponse: IpcResponse = {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
            socket.write(JSON.stringify(errorResponse) + "\n");
          }
        }
      });

      socket.on("error", (err) => {
        logger.error(`Socket error: ${err.message}`);
      });

      socket.on("close", () => {
        logger.debug("Client disconnected");
      });
    });

    this.server.on("error", (err) => {
      logger.error(`Server error: ${err.message}`);
    });

    this.server.listen(PATHS.DAEMON_SOCKET, () => {
      logger.info(`IPC server listening on ${PATHS.DAEMON_SOCKET}`);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      logger.info("IPC server stopped");
    }
    if (fs.existsSync(PATHS.DAEMON_SOCKET)) {
      fs.unlinkSync(PATHS.DAEMON_SOCKET);
    }
  }
}
