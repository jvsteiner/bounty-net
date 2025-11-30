import net from "net";
import fs from "fs";
import { PATHS } from "../constants/paths.js";
import { createLogger } from "../utils/logger.js";
import type { IpcRequest, IpcResponse } from "../types/ipc.js";

const logger = createLogger("ipc-client");

export class IpcClient {
  private socket: net.Socket | null = null;

  isDaemonRunning(): boolean {
    return fs.existsSync(PATHS.DAEMON_SOCKET);
  }

  async connect(): Promise<void> {
    if (!this.isDaemonRunning()) {
      throw new Error("Daemon is not running");
    }

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(PATHS.DAEMON_SOCKET);
      this.socket.once("connect", () => {
        logger.debug("Connected to daemon");
        resolve();
      });
      this.socket.once("error", (err) => {
        logger.error(`Connection error: ${err.message}`);
        reject(err);
      });
    });
  }

  async send(request: IpcRequest): Promise<IpcResponse> {
    if (!this.socket) {
      throw new Error("Not connected");
    }

    return new Promise((resolve, reject) => {
      let buffer = "";

      const onData = (data: Buffer) => {
        buffer += data.toString();
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          this.socket!.off("data", onData);
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("Invalid response from daemon"));
          }
        }
      };

      this.socket!.on("data", onData);
      this.socket!.write(JSON.stringify(request) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        this.socket!.off("data", onData);
        reject(new Error("Timeout waiting for daemon response"));
      }, 30000);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
      logger.debug("Disconnected from daemon");
    }
  }
}

// Singleton instance for MCP server
let client: IpcClient | null = null;

export async function getDaemonClient(): Promise<IpcClient | null> {
  if (!fs.existsSync(PATHS.DAEMON_SOCKET)) {
    return null; // Daemon not running
  }

  if (!client) {
    client = new IpcClient();
    try {
      await client.connect();
    } catch {
      client = null;
      return null;
    }
  }

  return client;
}

export function disconnectDaemonClient(): void {
  if (client) {
    client.disconnect();
    client = null;
  }
}
