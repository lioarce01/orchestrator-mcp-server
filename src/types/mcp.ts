import { ChildProcess } from "child_process";

export interface MCPConfig {
  name: string;
  capabilities: string[];
  container: {
    name: string;
    command?: string[];
    workdir?: string;
  };
  healthCheck?: {
    interval?: number;
    timeout?: number;
  };
}

export interface MCPClient {
  config: MCPConfig;
  process: ChildProcess | null;
  isReady: boolean;
  requestId: number;
  pendingRequests: Map<
    number,
    { resolve: Function; reject: Function; timeout: NodeJS.Timeout }
  >;
  lastHealthCheck?: number;
  messageBuffer: string;
}

export interface ExecutionResult {
  stepId: string;
  mcp: string;
  tool: string;
  status: "success" | "error";
  result?: any;
  error?: string;
  duration: number;
}
