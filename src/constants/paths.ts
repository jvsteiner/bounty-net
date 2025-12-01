import path from "path";
import os from "os";

const BASE_DIR = path.join(os.homedir(), ".bounty-net");

export const PATHS = {
  BASE_DIR,
  CONFIG: path.join(BASE_DIR, "config.json"),
  DATABASE: path.join(BASE_DIR, "bounty-net.db"),
  TOKENS: path.join(BASE_DIR, "tokens"),
  DAEMON_PID: path.join(BASE_DIR, "daemon.pid"),
  DAEMON_SOCKET: path.join(BASE_DIR, "daemon.sock"),
  DAEMON_LOG: path.join(BASE_DIR, "daemon.log"),
} as const;
