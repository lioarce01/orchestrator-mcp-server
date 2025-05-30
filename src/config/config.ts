import { readFileSync } from "fs";
import { MCPConfig } from "../types/mcp";
import { resolve } from "path";

export function loadConfig(path = "./mcp-config.json"): MCPConfig[] {
  const absPath = resolve(process.cwd(), path);
  const data = readFileSync(absPath, "utf8");
  const { mcps } = JSON.parse(data);
  return mcps;
}
