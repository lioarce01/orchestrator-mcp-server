import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  InitializedNotificationSchema,
  InitializeRequestSchema,
  InitializeResult,
} from "@modelcontextprotocol/sdk/types.js";

export function initializeHandshake(server: Server) {
  server.setRequestHandler(
    InitializeRequestSchema,
    async (params): Promise<InitializeResult> => {
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "docker-mcp-orchestrator",
          version: "1.0.0",
        },
      };
    }
  );

  server.setNotificationHandler(InitializedNotificationSchema, async () => {
    // Just acknowledge, no response needed
  });
}
