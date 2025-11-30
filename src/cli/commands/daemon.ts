import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import { checkSingleton, isProcessRunning } from "../../daemon/process.js";
import { PATHS } from "../../constants/paths.js";
import type { IpcRequest, IpcResponse, DaemonStatus } from "../../types/ipc.js";

async function sendIpcRequest(request: IpcRequest): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PATHS.DAEMON_SOCKET)) {
      reject(new Error("Daemon socket not found"));
      return;
    }

    const socket = net.createConnection(PATHS.DAEMON_SOCKET);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("Invalid response from daemon"));
        }
      }
    });

    socket.on("error", (err) => {
      reject(err);
    });

    setTimeout(() => {
      socket.destroy();
      reject(new Error("Timeout waiting for daemon response"));
    }, 5000);
  });
}

export async function startDaemon(): Promise<void> {
  const status = checkSingleton();
  if (status.running) {
    console.log(`Daemon already running (PID ${status.pid})`);
    return;
  }

  // Ensure base directory exists
  fs.mkdirSync(PATHS.BASE_DIR, { recursive: true });

  // Spawn daemon in background
  const logFile = fs.openSync(PATHS.DAEMON_LOG, "a");
  const child = spawn(process.execPath, [process.argv[1], "daemon", "run"], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
  });

  child.unref();

  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${PATHS.DAEMON_LOG}`);
}

export async function stopDaemon(): Promise<void> {
  const status = checkSingleton();
  if (!status.running) {
    console.log("Daemon is not running");
    return;
  }

  try {
    process.kill(status.pid!, "SIGTERM");
    console.log(`Daemon stopped (PID ${status.pid})`);

    // Wait a moment for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Check if it actually stopped
    if (isProcessRunning(status.pid!)) {
      console.log("Daemon still running, sending SIGKILL...");
      process.kill(status.pid!, "SIGKILL");
    }
  } catch (error) {
    console.error(
      `Failed to stop daemon: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

export async function daemonStatus(): Promise<void> {
  const processStatus = checkSingleton();

  if (!processStatus.running) {
    console.log("Daemon is not running");
    return;
  }

  console.log(`Daemon running (PID ${processStatus.pid})`);

  // Try to get detailed status via IPC
  try {
    const response = await sendIpcRequest({ type: "status" });

    if (response.success && response.data) {
      const data = response.data as DaemonStatus;
      console.log(`Uptime: ${Math.floor(data.uptime / 1000)}s`);
      console.log(`Connected relays: ${data.connectedRelays.join(", ")}`);
      console.log("Inboxes:");
      for (const inbox of data.inboxes) {
        console.log(
          `  - ${inbox.identity} (${inbox.nametag ?? "no nametag"}): ${inbox.pendingReports} pending`
        );
        console.log(`    repos: ${inbox.repositories.join(", ")}`);
      }
    }
  } catch {
    console.log("(Could not connect to daemon for detailed status)");
  }
}

export async function daemonLogs(options: {
  follow?: boolean;
  lines?: string;
}): Promise<void> {
  if (!fs.existsSync(PATHS.DAEMON_LOG)) {
    console.log("No log file found");
    return;
  }

  if (options.follow) {
    // Use tail -f
    const tail = spawn("tail", ["-f", "-n", options.lines ?? "50", PATHS.DAEMON_LOG], {
      stdio: "inherit",
    });
    tail.on("error", () => {
      // Fallback: just read the file
      console.log(fs.readFileSync(PATHS.DAEMON_LOG, "utf-8"));
    });
  } else {
    // Read last N lines
    const content = fs.readFileSync(PATHS.DAEMON_LOG, "utf-8");
    const lines = content.split("\n");
    const n = parseInt(options.lines ?? "50", 10);
    console.log(lines.slice(-n).join("\n"));
  }
}

export const daemonCommands = {
  start: startDaemon,
  stop: stopDaemon,
  status: daemonStatus,
  logs: daemonLogs,
};
