// Commands from MCP server to daemon
export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  | {
      type: "accept_report";
      inbox: string;
      reportId: string;
      message?: string;
      reward?: number; // Custom reward amount (uses repo default if not specified)
    }
  | {
      type: "reject_report";
      inbox: string;
      reportId: string;
      reason: string;
    };

export interface IpcResponse {
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptime: number;
  connectedRelays: string[];
  inboxes: {
    identity: string;
    nametag?: string;
    repositories: string[];
    pendingReports: number;
  }[];
  lastSync: number;
}
