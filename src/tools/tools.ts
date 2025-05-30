import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { sendMCPRequest } from "../mcpClient/mcp_client";
import {
  checkHealth,
  listMCPs,
  orchestrateTask,
  orchestrator,
} from "../orchestrator/orchestrator";

export function registerTools(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
      case "orchestrate_task":
        return orchestrateTask(args);
      case "list_mcps":
        return listMCPs(args);
      case "check_health":
        return checkHealth(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}

export function selectBestTools(tools: any[], task: string): any[] {
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

export async function getAvailableTools(
  mcpNames: string[]
): Promise<{ [key: string]: any[] }> {
  const tools: { [key: string]: any[] } = {};

  await Promise.all(
    mcpNames.map(async (mcpName) => {
      const client = orchestrator.getMCPClient(mcpName);
      if (!client?.isReady) {
        tools[mcpName] = [];
        return;
      }

      try {
        const response = await sendMCPRequest(client, "tools/list", {});
        tools[mcpName] = response.tools || [];
      } catch (error) {
        console.error(`Error getting tools from ${mcpName}:`, error);
        tools[mcpName] = [];
      }
    })
  );

  return tools;
}
