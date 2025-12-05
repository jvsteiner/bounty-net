import { Command } from "commander";
import { exec } from "child_process";
import fs from "fs";
import net from "net";
import { PATHS } from "../../constants/paths.js";
import { DAEMON_PORT } from "../../daemon/index.js";

export function createUiCommand(): Command {
  const cmd = new Command("ui")
    .description("Open the Bounty-Net UI in your browser")
    .option("--url", "Just print the URL, don't open browser")
    .option("--status", "Check if UI is available")
    .action(async (options) => {
      const url = `http://localhost:${DAEMON_PORT}`;

      if (options.status) {
        const available = await checkUiAvailable();
        if (available) {
          console.log(`UI available at ${url} (daemon running)`);
        } else {
          console.log("UI not available (daemon not running)");
          console.log("Start the daemon with: bounty-net daemon start");
          process.exit(1);
        }
        return;
      }

      if (options.url) {
        console.log(url);
        return;
      }

      // Check if daemon is running
      const available = await checkUiAvailable();
      if (!available) {
        console.error("Daemon not running. Start it with: bounty-net daemon start");
        process.exit(1);
      }

      // Open browser
      console.log(`Opening ${url}...`);
      openBrowser(url);
    });

  return cmd;
}

async function checkUiAvailable(): Promise<boolean> {
  // First check if daemon PID file exists
  if (!fs.existsSync(PATHS.DAEMON_PID)) {
    return false;
  }

  // Try to connect to the UI port
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(DAEMON_PORT, "127.0.0.1");
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;

  switch (platform) {
    case "darwin":
      cmd = `open "${url}"`;
      break;
    case "win32":
      cmd = `start "" "${url}"`;
      break;
    default:
      cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (error) => {
    if (error) {
      console.error("Failed to open browser. Visit manually:", url);
    }
  });
}
