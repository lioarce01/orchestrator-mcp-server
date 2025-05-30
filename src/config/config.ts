import { readFileSync } from "fs";
import { MCPConfig } from "../types/mcp";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(path = "../../mcp-config.json"): MCPConfig[] {
  const absPath = resolve(__dirname, path);
  const data = readFileSync(absPath, "utf8");
  const { mcps } = JSON.parse(data);
  return mcps;
}
