import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { spawn, ChildProcess } from "child_process";

interface MCPConfig {
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

interface MCPClient {
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

interface ExecutionResult {
  stepId: string;
  mcp: string;
  tool: string;
  status: "success" | "error";
  result?: any;
  error?: string;
  duration: number;
}

class DockerMCPOrchestrator {
  private server: Server;
  private mcpClients: Map<string, MCPClient> = new Map();
  private config: { mcps: MCPConfig[] };
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts: Map<string, number> = new Map();
  private readonly maxReconnectAttempts = 5;

  constructor(configPath: string = "./mcp-config.json") {
    this.config = JSON.parse(readFileSync(configPath, "utf8"));

    this.server = new Server({
      name: "docker-mcp-orchestrator",
      version: "1.0.0",
    });

    this.setupTools();
    this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.initializeMCPs();
    this.startHealthChecks();
    console.error("🚀 Docker MCP Orchestrator initialized");
  }

  // === MCP Connection Management ===
  private async initializeMCPs(): Promise<void> {
    console.error("🔌 Connecting to dockerized MCPs...");

    const initPromises = this.config.mcps.map(async (mcpConfig) => {
      try {
        await this.connectToDockerMCP(mcpConfig);
        console.error(`✅ ${mcpConfig.name} connected`);
        this.reconnectAttempts.set(mcpConfig.name, 0);
      } catch (error) {
        console.error(`❌ Failed to connect ${mcpConfig.name}:`, error);
        this.reconnectAttempts.set(mcpConfig.name, 1);
      }
    });

    await Promise.allSettled(initPromises);
    console.error(
      `🎯 ${this.mcpClients.size}/${this.config.mcps.length} MCPs connected`
    );
  }

  private async connectToDockerMCP(config: MCPConfig): Promise<void> {
    const client: MCPClient = {
      config,
      process: null,
      isReady: false,
      requestId: 0,
      pendingRequests: new Map(),
      messageBuffer: "",
    };

    // Ensure container is running
    await this.ensureContainerRunning(config.container.name);

    // Setup docker exec command
    const command = config.container.command || ["node", "index.js"];
    const dockerArgs = ["exec", "-i"];

    if (config.container.workdir) {
      dockerArgs.push("-w", config.container.workdir);
    }

    dockerArgs.push(config.container.name, ...command);

    const dockerProcess = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    client.process = dockerProcess;
    this.setupProcessHandlers(client);

    await this.waitForProcessReady(client);
    await this.initializeMCPClient(client);

    this.mcpClients.set(config.name, client);
  }

  private async ensureContainerRunning(containerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkProcess = spawn("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        containerName,
      ]);

      let output = "";
      checkProcess.stdout.on("data", (data) => (output += data.toString()));

      checkProcess.on("close", (code) => {
        if (code === 0 && output.trim() === "true") {
          resolve();
        } else {
          reject(new Error(`Container ${containerName} is not running`));
        }
      });
    });
  }

  private setupProcessHandlers(client: MCPClient): void {
    if (!client.process) return;

    client.process.stdout?.on("data", (data: Buffer) => {
      client.messageBuffer += data.toString();
      this.processMessages(client);
    });

    client.process.stderr?.on("data", (data: Buffer) => {
      const message = data.toString().trim();
      if (message) console.error(`[${client.config.name}] ${message}`);
    });

    client.process.on("error", (error) => {
      console.error(`❌ Process error for ${client.config.name}:`, error);
      client.isReady = false;
      this.scheduleReconnect(client);
    });

    client.process.on("exit", (code) => {
      console.error(
        `⚠️ Process exited for ${client.config.name} (code: ${code})`
      );
      client.isReady = false;
      client.process = null;
      this.scheduleReconnect(client);
    });
  }

  private processMessages(client: MCPClient): void {
    const lines = client.messageBuffer.split("\n");
    client.messageBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      try {
        const message = JSON.parse(trimmedLine);
        this.handleMCPResponse(client, message);
      } catch (error) {
        console.error(`Parse error for ${client.config.name}:`, error);
      }
    }
  }

  private handleMCPResponse(client: MCPClient, response: any): void {
    if (response.id && client.pendingRequests.has(response.id)) {
      const request = client.pendingRequests.get(response.id)!;
      client.pendingRequests.delete(response.id);
      clearTimeout(request.timeout);

      if (response.error) {
        request.reject(new Error(response.error.message || "MCP Error"));
      } else {
        request.resolve(response.result);
      }
    }
  }

  private async waitForProcessReady(
    client: MCPClient,
    timeout: number = 10000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${client.config.name}`));
      }, timeout);

      const onData = (data: Buffer) => {
        if (data.toString().includes('"jsonrpc"')) {
          clearTimeout(timeoutId);
          client.process?.stdout?.off("data", onData);
          resolve();
        }
      };

      client.process?.stdout?.on("data", onData);
    });
  }

  private async initializeMCPClient(client: MCPClient): Promise<void> {
    await this.sendMCPRequest(client, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: {
        name: "docker-mcp-orchestrator",
        version: "1.0.0",
      },
    });

    await this.sendMCPRequest(client, "initialized", {});
    client.isReady = true;
  }

  private async sendMCPRequest(
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

  // === Health Check System ===
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      const healthPromises = Array.from(this.mcpClients.entries()).map(
        async ([name, client]) => {
          try {
            if (!client.isReady) throw new Error("Client not ready");
            await this.sendMCPRequest(client, "ping", {});
            client.lastHealthCheck = Date.now();
          } catch (error) {
            console.error(`❌ Health check failed for ${name}`);
            client.isReady = false;
            this.scheduleReconnect(client);
          }
        }
      );

      const results = await Promise.allSettled(healthPromises);
      const healthy = results.filter((r) => r.status === "fulfilled").length;
      console.error(`💚 ${healthy}/${this.mcpClients.size} MCPs healthy`);
    }, 30000);
  }

  private scheduleReconnect(client: MCPClient): void {
    if (client.process) return; // Already reconnecting

    const attempts = this.reconnectAttempts.get(client.config.name) || 0;
    if (attempts >= this.maxReconnectAttempts) {
      console.error(
        `❌ Max reconnect attempts reached for ${client.config.name}`
      );
      return;
    }

    const delay = Math.min(5000 * Math.pow(2, attempts), 60000);
    console.error(
      `🔄 Reconnecting ${client.config.name} in ${delay / 1000}s...`
    );

    setTimeout(async () => {
      try {
        await this.connectToDockerMCP(client.config);
        console.error(`✅ ${client.config.name} reconnected`);
        this.reconnectAttempts.set(client.config.name, 0);
      } catch (error) {
        console.error(`❌ Reconnection failed for ${client.config.name}`);
        this.reconnectAttempts.set(client.config.name, attempts + 1);
        this.scheduleReconnect(client);
      }
    }, delay);
  }

  // === Task Analysis and Execution ===
  private analyzeTask(task: string): string[] {
    const taskLower = task.toLowerCase();
    const requiredMCPs: string[] = [];

    for (const [mcpName, client] of this.mcpClients) {
      if (!client.isReady) continue;

      let score = 0;

      // Direct name match
      if (taskLower.includes(mcpName.toLowerCase())) score += 10;

      // Capability match
      for (const capability of client.config.capabilities) {
        if (taskLower.includes(capability.toLowerCase())) score += 5;
      }

      // Keyword analysis
      const keywords = {
        github: [
          "github",
          "repo",
          "repository",
          "branch",
          "commit",
          "pull request",
        ],
        trello: ["trello", "board", "card", "list", "kanban"],
        database: ["database", "db", "sql", "query"],
        email: ["email", "mail", "send", "notification"],
        file: ["file", "document", "upload", "download"],
      };

      for (const [service, serviceKeywords] of Object.entries(keywords)) {
        if (mcpName.toLowerCase().includes(service)) {
          for (const keyword of serviceKeywords) {
            if (taskLower.includes(keyword)) score += 3;
          }
        }
      }

      if (score > 0) requiredMCPs.push(mcpName);
    }

    return requiredMCPs;
  }

  private async getAvailableTools(
    mcpNames: string[]
  ): Promise<{ [key: string]: any[] }> {
    const tools: { [key: string]: any[] } = {};

    const toolPromises = mcpNames.map(async (mcpName) => {
      const client = this.mcpClients.get(mcpName);
      if (!client?.isReady) {
        tools[mcpName] = [];
        return;
      }

      try {
        const response = await this.sendMCPRequest(client, "tools/list", {});
        tools[mcpName] = response.tools || [];
      } catch (error) {
        console.error(`Error getting tools from ${mcpName}:`, error);
        tools[mcpName] = [];
      }
    });

    await Promise.all(toolPromises);
    return tools;
  }

  private selectBestTools(tools: any[], task: string): any[] {
    const taskLower = task.toLowerCase();

    return tools
      .map((tool) => {
        let score = 0;
        const toolName = tool.name.toLowerCase();
        const toolDesc = (tool.description || "").toLowerCase();

        if (taskLower.includes(toolName)) score += 10;

        const actionWords = [
          "create",
          "add",
          "update",
          "delete",
          "send",
          "get",
          "list",
        ];
        for (const action of actionWords) {
          if (
            taskLower.includes(action) &&
            (toolName.includes(action) || toolDesc.includes(action))
          ) {
            score += 5;
          }
        }

        return { ...tool, score };
      })
      .filter((tool) => tool.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private generateSmartParams(tool: any, task: string): any {
    const params: any = {};
    if (!tool.inputSchema?.properties) return params;

    for (const [paramName, paramSchema] of Object.entries(
      tool.inputSchema.properties
    )) {
      const schema = paramSchema as any;
      const paramLower = paramName.toLowerCase();

      if (paramLower.includes("title") || paramLower.includes("name")) {
        params[paramName] = this.extractTitle(task);
      } else if (
        paramLower.includes("description") ||
        paramLower.includes("body")
      ) {
        params[paramName] = `Generated from task: ${task}`;
      } else if (paramLower.includes("branch")) {
        params[paramName] = this.generateBranchName(task);
      } else if (
        paramLower.includes("list") &&
        task.toLowerCase().includes("backlog")
      ) {
        params[paramName] = "backlog";
      } else if (schema.default) {
        params[paramName] = schema.default;
      } else if (schema.type === "boolean") {
        params[paramName] = true;
      } else if (schema.type === "string") {
        params[paramName] = `Auto: ${task.substring(0, 30)}...`;
      }
    }

    return params;
  }

  private extractTitle(task: string): string {
    const words = task
      .split(" ")
      .filter(
        (word) =>
          ![
            "quiero",
            "crear",
            "make",
            "create",
            "una",
            "un",
            "el",
            "la",
          ].includes(word.toLowerCase())
      );
    return words.slice(0, 4).join(" ").substring(0, 50);
  }

  private generateBranchName(task: string): string {
    const clean = task
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 30);
    return `feature/${clean}`;
  }

  private async executeTask(
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
      const result = await this.sendMCPRequest(client, "tools/call", {
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

  // === Tool Setup ===
  private setupTools(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "orchestrate_task",
          description:
            "Orchestrate complex tasks across multiple dockerized MCPs",
          inputSchema: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Detailed description of the task to perform",
              },
              parallel: {
                type: "boolean",
                description: "Execute subtasks in parallel when possible",
                default: true,
              },
            },
            required: ["task"],
          },
        },
        {
          name: "list_mcps",
          description: "List all available MCPs and their status",
          inputSchema: {
            type: "object",
            properties: {
              include_tools: {
                type: "boolean",
                description: "Include available tools for each MCP",
                default: false,
              },
            },
          },
        },
        {
          name: "check_health",
          description: "Check health status of MCPs",
          inputSchema: {
            type: "object",
            properties: {
              mcp_name: {
                type: "string",
                description: "Specific MCP to check (optional)",
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "orchestrate_task":
            return await this.orchestrateTask(args);
          case "list_mcps":
            return await this.listMCPs(args);
          case "check_health":
            return await this.checkHealth(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
        throw error;
      }
    });
  }

  // === Main Orchestration Method ===
  private async orchestrateTask(args: any) {
    const { task, parallel = true } = args;
    const startTime = Date.now();

    console.error(`🎯 Orchestrating task: ${task}`);

    // 1. Analyze task requirements
    const requiredMCPs = this.analyzeTask(task);
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
    const availableTools = await this.getAvailableTools(requiredMCPs);

    // 3. Create execution plan
    const executionPlan = [];
    for (const [mcpName, tools] of Object.entries(availableTools)) {
      const selectedTools = this.selectBestTools(tools, task);

      for (const tool of selectedTools.slice(0, 2)) {
        // Limit to 2 best tools per MCP
        executionPlan.push({
          mcp: mcpName,
          tool: tool.name,
          params: this.generateSmartParams(tool, task),
        });
      }
    }

    // 4. Execute plan
    const results: ExecutionResult[] = [];

    if (parallel) {
      const executePromises = executionPlan.map((step) =>
        this.executeTask(step.mcp, step.tool, step.params)
      );
      results.push(...(await Promise.all(executePromises)));
    } else {
      for (const step of executionPlan) {
        const result = await this.executeTask(step.mcp, step.tool, step.params);
        results.push(result);
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

  private async listMCPs(args: any) {
    const { include_tools = false } = args;
    const mcpList = [];

    for (const [name, client] of this.mcpClients) {
      const mcpInfo: any = {
        name,
        status: client.isReady ? "ready" : "not_ready",
        capabilities: client.config.capabilities,
        container: client.config.container.name,
        last_health_check: client.lastHealthCheck
          ? new Date(client.lastHealthCheck).toISOString()
          : null,
      };

      if (include_tools && client.isReady) {
        try {
          const toolsResponse = await this.sendMCPRequest(
            client,
            "tools/list",
            {}
          );
          mcpInfo.tools = toolsResponse.tools || [];
        } catch (error) {
          mcpInfo.tools = [];
        }
      }

      mcpList.push(mcpInfo);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total_mcps: mcpList.length,
              ready_mcps: mcpList.filter((m) => m.status === "ready").length,
              mcps: mcpList,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async checkHealth(args: any) {
    const { mcp_name } = args;
    const healthResults = [];

    const mcpsToCheck = mcp_name
      ? [this.mcpClients.get(mcp_name)].filter(Boolean)
      : Array.from(this.mcpClients.values());

    for (const client of mcpsToCheck) {
      try {
        if (!client) throw new Error("Client not found");
        if (!client.isReady) throw new Error("Client not ready");

        const start = Date.now();
        await this.sendMCPRequest(client, "ping", {});
        const responseTime = Date.now() - start;

        healthResults.push({
          name: client.config.name,
          status: "healthy",
          response_time_ms: responseTime,
          container: client.config.container.name,
        });
      } catch (error) {
        healthResults.push({
          name: client?.config.name,
          status: "unhealthy",
          error: error instanceof Error ? error.message : "Unknown error",
          container: client?.config.container.name,
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              results: healthResults,
              summary: {
                total: healthResults.length,
                healthy: healthResults.filter((r) => r.status === "healthy")
                  .length,
                unhealthy: healthResults.filter((r) => r.status === "unhealthy")
                  .length,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // === Public API ===
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("🎉 Docker MCP Orchestrator started");
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    for (const client of this.mcpClients.values()) {
      if (client.process) {
        client.process.kill();
      }
    }

    console.error("🛑 Docker MCP Orchestrator stopped");
  }
}

// === Execution ===
if (import.meta.url === `file://${process.argv[1]}`) {
  const orchestrator = new DockerMCPOrchestrator();

  process.on("SIGINT", async () => {
    await orchestrator.stop();
    process.exit(0);
  });

  orchestrator.start().catch(console.error);
}
