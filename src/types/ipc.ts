// Commands from MCP server to daemon
export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  | {
      type: "accept_report";
      inbox: string;
      reportId: string;
      message?: string;
      payBounty?: boolean;
    }
  | {
      type: "reject_report";
      inbox: string;
      reportId: string;
      reason: string;
    }
  | {
      type: "publish_fix";
      inbox: string;
      reportId: string;
      commitHash: string;
      message?: string;
    }
  | {
      type: "set_bounty";
      inbox: string;
      repo: string;
      severity: string;
      amount: number;
    }
  | {
      type: "block_sender";
      inbox: string;
      pubkey: string;
      reason?: string;
    }
  | {
      type: "unblock_sender";
      inbox: string;
      pubkey: string;
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
