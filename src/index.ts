import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";

const server = new Server(
    {
        name: "MCP Orchestrator",
        version: "1.0.0",
        description: "A server that orchestrates multiple MCP clients",
    },
    {
        capabilities: {
            resources: {},
            tools: {}
        }
    }
)

const runServer = async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Orchestrator MCP server connected and ready.");
}

runServer().catch(console.error)