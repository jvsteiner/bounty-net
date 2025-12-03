// Commands from MCP server to daemon
export type IpcRequest =
  | { type: "ping" }
  | { type: "status" }
  // Maintainer commands
  | {
      type: "accept_report";
      inbox: string;
      reportId: string;
      message?: string;
      reward?: number;
    }
  | {
      type: "reject_report";
      inbox: string;
      reportId: string;
      reason: string;
    }
  // Reporter commands
  | {
      type: "report_bug";
      description: string;
      repoUrl: string;
      maintainerPubkey: string;
      files?: string[];
      suggestedFix?: string;
    }
  | {
      type: "get_report_status";
      reportId: string;
    }
  | {
      type: "list_my_reports";
      status?: string;
      limit?: number;
    }
  // Shared commands
  | {
      type: "get_balance";
      identity?: string;
      coinId?: string;
    }
  | {
      type: "resolve_maintainer";
      nametag?: string;
      repoUrl?: string;
    }
  | {
      type: "get_my_identity";
    }
  | {
      type: "search_known_issues";
      repoUrl: string;
      query?: string;
    }
  | {
      type: "list_reports";
      direction: "sent" | "received";
      pubkey: string;
      status?: string;
      limit?: number;
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
  reporter?: {
    identity: string;
    nametag?: string;
  };
  lastSync: number;
}
