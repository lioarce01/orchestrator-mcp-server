import { MCPClient } from "../types/mcp";

export function setupProcessHandlers(
  client: MCPClient,
  handleResponse: (client: MCPClient, message: any) => void
) {
  if (!client.process) return;
  if (client.process.stdout) {
    client.process.stdout.on("data", (data: Buffer) => {
      client.messageBuffer += data.toString();
      const lines = client.messageBuffer.split("\n");
      client.messageBuffer = lines.pop() || "";
      for (const line of lines.filter((l) => l.trim())) {
        try {
          handleResponse(client, JSON.parse(line));
        } catch (error) {
          console.error(`Parse error(${client.config.name}):`, error);
        }
      }
    });
  }
  if (client.process.stderr) {
    client.process.stderr.on("data", (data) =>
      console.error(`[${client.config.name}]`, data.toString().trim())
    );
  }
}
