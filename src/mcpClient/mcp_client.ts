import { spawn, ChildProcess } from "child_process";
import { MCPClient, MCPConfig } from "../types/mcp";
import { ensureContainerRunning } from "../infrastructure/docker";

export async function connectToMCP(config: MCPConfig): Promise<MCPClient> {
  await ensureContainerRunning(config.container.name);
  const args = [
    "exec",
    "-i",
    ...(config.container.workdir ? ["-w", config.container.workdir] : []),
    config.container.name,
    ...(config.container.command || ["node", "index.js"]),
  ];
  const process = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  const client: MCPClient = {
    config,
    process,
    isReady: false,
    requestId: 0,
    pendingRequests: new Map(),
    messageBuffer: "",
  };
  return client;
}

export async function sendMCPRequest(
  client: MCPClient,
  method: string,
  params: any = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!client.process?.stdin) {
      reject(new Error(`MCP ${client.config.name} not connected`));
      return;
    }

    const requestId = ++client.requestId;
    const request = { jsonrpc: "2.0", id: requestId, method, params };

    const timeoutMs = client.config.healthCheck?.timeout || 30000;
    const timeoutId = setTimeout(() => {
      client.pendingRequests.delete(requestId);
      reject(new Error(`Timeout for ${method} in ${client.config.name}`));
    }, timeoutMs);

    client.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout: timeoutId,
    });

    client.process.stdin.write(JSON.stringify(request) + "\n", (error) => {
      if (error) {
        client.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  });
}
