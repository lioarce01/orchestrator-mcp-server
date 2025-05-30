import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCPClient, MCPConfig, ExecutionResult } from "../types/mcp";
import { loadConfig } from "../config/config";
import { connectToMCP, sendMCPRequest } from "../mcpClient/mcp_client";
import { setupProcessHandlers } from "../handlers/process_handler";
import { analyzeTask, generateSmartParams } from "../tasks/tasks";
import { registerTools, selectBestTools } from "../tools/tools";
import { initializeHandshake } from "../handlers/MCPHandlers";

export class DockerMCPOrchestrator {
  private server: Server;
  private mcpClients = new Map<string, MCPClient>();
  private configs: MCPConfig[];
  private healthInterval: NodeJS.Timeout | null = null;
  constructor(configPath?: string) {
    this.configs = loadConfig(configPath);
    this.server = new Server({
      name: "docker-mcp-orchestrator",
      version: "1.0.0",
    });
    registerTools(this.server);
    initializeHandshake(this.server);
  }

  public getMCPClient(name: string) {
    return this.mcpClients.get(name);
  }
  async initialize(): Promise<void> {
    console.error("Initializing Docker MCP Orchestrator...");
    for (const cfg of this.configs) {
      try {
        const client = await connectToMCP(cfg);
        setupProcessHandlers(client, this.handleResponse.bind(this));
        // await this.waitForReady(client);

        // Perform MCP handshake
        const initResult = await sendMCPRequest(client, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: {
            name: "docker-mcp-orchestrator",
            version: "1.0.0",
          },
        });

        if (initResult) {
          // Send initialized notification after successful initialize
          await sendMCPRequest(client, "initialized", {});
          client.isReady = true;
          this.mcpClients.set(cfg.name, client);
          console.error(`Connected to MCP: ${cfg.name}`);
        } else {
          throw new Error("Initialize request failed");
        }
      } catch (err) {
        console.error(`Failed to connect ${cfg.name}:`, err);
      }
    }
    this.startHealthChecks();
  }

  private handleResponse(client: MCPClient, message: any) {
    // handle JSON-RPC responses
    const { id, result, error } = message;
    const pending = client.pendingRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    client.pendingRequests.delete(id);
    if (error) pending.reject(new Error(error.message));
    else pending.resolve(result);
  }
  private waitForReady(client: MCPClient, timeout = 10000): Promise<void> {
    return new Promise((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error("Timeout waiting for MCP")),
        timeout
      );

      // Check initial buffer for ready message
      if (client.messageBuffer.includes("MCP Server connected and ready")) {
        clearTimeout(timer);
        res();
        return;
      }

      // If not found in buffer, wait for it
      const onData = (data: Buffer) => {
        const message = data.toString();
        if (message.includes("MCP Server connected and ready")) {
          clearTimeout(timer);
          client.process?.stdout?.off("data", onData);
          res();
        }

        if (message.includes("ready") || message.includes('"jsonrpc"')) {
          clearTimeout(timer);
          client.process?.stdout?.off("data", onData);
          res();
        }
      };

      client.process?.stdout?.on("data", onData);

      // Also handle case where process fails
      client.process?.on("error", (err) => {
        clearTimeout(timer);
        rej(err);
      });

      client.process?.on("exit", (code) => {
        clearTimeout(timer);
        rej(new Error(`Process exited with code ${code}`));
      });
    });
  }

  private sendRequest(
    client: MCPClient,
    method: string,
    params: any = {}
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++client.requestId;
      const payload =
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "";
      const timeout = setTimeout(() => {
        client.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, client.config.healthCheck?.timeout || 30000);
      client.pendingRequests.set(id, { resolve, reject, timeout });
      client.process?.stdin?.write(payload, (err) => err && reject(err));
    });
  }

  private startHealthChecks(): void {
    this.healthInterval = setInterval(async () => {
      for (const [name, client] of this.mcpClients) {
        try {
          await this.sendRequest(client, "ping");
          console.error(`💚 ${name} is healthy`);
        } catch {
          console.error(`❌ ${name} health check failed`);
        }
      }
    }, 30000);
  }

  async orchestrateTask(args: {
    task: string;
    parallel?: boolean;
  }): Promise<any> {
    const { task, parallel = true } = args;
    const startTime = Date.now();

    // 1. Analyze task requirements
    const requiredMCPs = analyzeTask(task, this.mcpClients);
    if (requiredMCPs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "no_mcps_found",
                message: "No suitable MCPs found for this task",
                task,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // 2. Get available tools
    const availableTools: { [key: string]: any[] } = {};
    await Promise.all(
      requiredMCPs.map(async (mcpName) => {
        try {
          const tools = await this.sendRequest(
            this.mcpClients.get(mcpName)!,
            "tools/list",
            {}
          );
          availableTools[mcpName] = tools.tools || [];
        } catch {
          availableTools[mcpName] = [];
        }
      })
    );

    // 3. Create execution plan
    const executionPlan: Array<{ mcp: string; tool: string; params: any }> = [];
    for (const [mcpName, tools] of Object.entries(availableTools)) {
      const selectedTools = selectBestTools(tools, task).slice(0, 2);
      for (const tool of selectedTools) {
        executionPlan.push({
          mcp: mcpName,
          tool: tool.name,
          params: generateSmartParams(tool, task),
        });
      }
    }

    // 4. Execute plan
    const results: ExecutionResult[] = [];
    if (parallel) {
      const execs = executionPlan.map((step) =>
        this.executeTask(step.mcp, step.tool, step.params)
      );
      results.push(...(await Promise.all(execs)));
    } else {
      for (const step of executionPlan) {
        const res = await this.executeTask(step.mcp, step.tool, step.params);
        results.push(res);
      }
    }

    const totalTime = Date.now() - startTime;
    const successCount = results.filter((r) => r.status === "success").length;

    console.error(
      `✅ Task completed in ${totalTime}ms (${successCount}/${results.length} successful)`
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              task,
              status: "completed",
              execution_time_ms: totalTime,
              required_mcps: requiredMCPs,
              execution_plan: executionPlan,
              results,
              summary: {
                total_steps: results.length,
                successful_steps: successCount,
                failed_steps: results.length - successCount,
                execution_mode: parallel ? "parallel" : "sequential",
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  async listMCPs(args: { include_tools?: boolean }): Promise<any> {
    const include = args.include_tools || false;
    const summary = [];
    for (const [name, client] of this.mcpClients) {
      const entry: any = { name, status: client.isReady ? "ready" : "down" };
      if (include && client.isReady) {
        entry.tools = await this.sendRequest(client, "tools/list");
      }
      summary.push(entry);
    }
    return { total: summary.length, mcps: summary };
  }

  async checkHealth(args: { mcp_name?: string }): Promise<any> {
    const targets = args.mcp_name
      ? [args.mcp_name]
      : Array.from(this.mcpClients.keys());
    const results = [];
    for (const name of targets) {
      const client = this.mcpClients.get(name)!;
      try {
        await this.sendRequest(client, "ping");
        results.push({ name, status: "healthy" });
      } catch (err: any) {
        results.push({ name, status: "unhealthy", error: err.message });
      }
    }
    return {
      content: [],
    };
  }

  async executeTask(
    mcpName: string,
    toolName: string,
    params: any
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const client = this.mcpClients.get(mcpName);

    if (!client?.isReady) {
      return {
        stepId: `${mcpName}_${toolName}`,
        mcp: mcpName,
        tool: toolName,
        status: "error",
        error: "MCP not available",
        duration: Date.now() - startTime,
      };
    }

    try {
      const result = await sendMCPRequest(client, "tools/call", {
        name: toolName,
        arguments: params,
      });

      return {
        stepId: `${mcpName}_${toolName}`,
        mcp: mcpName,
        tool: toolName,
        status: "success",
        result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        stepId: `${mcpName}_${toolName}`,
        mcp: mcpName,
        tool: toolName,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        duration: Date.now() - startTime,
      };
    }
  }

  async stop(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval);
    for (const client of this.mcpClients.values()) {
      client.process?.kill();
    }
    console.error("Orchestrator stopped");
  }

  async start(): Promise<void> {
    await this.initialize();
    await this.server.connect(new StdioServerTransport());
    console.error("Orchestrator started");
  }
}

export const orchestrator = new DockerMCPOrchestrator();
export async function orchestrateTask(args: any) {
  return orchestrator.orchestrateTask(args);
}

export async function listMCPs(args: any) {
  return orchestrator.listMCPs(args);
}

export async function checkHealth(args: any) {
  return orchestrator.checkHealth(args);
}
