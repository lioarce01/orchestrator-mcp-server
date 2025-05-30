export function analyzeTask(task: string, clients: Map<string, any>): string[] {
  const taskLower = task.toLowerCase();
  const requiredMCPs: string[] = [];

  for (const [mcpName, client] of clients) {
    if (!client.isReady) continue;

    let score = 0;
    // Direct name match
    if (taskLower.includes(mcpName.toLowerCase())) score += 10;
    // Capability match
    for (const capability of client.config.capabilities) {
      if (taskLower.includes(capability.toLowerCase())) score += 5;
    }
    // Keyword analysis
    const keywords: Record<string, string[]> = {
      github: [
        "github",
        "repo",
        "repository",
        "branch",
        "commit",
        "pull request",
      ],
      trello: ["trello", "board", "card", "list", "kanban"],
    };
    for (const [service, kws] of Object.entries(keywords)) {
      if (mcpName.toLowerCase().includes(service)) {
        for (const kw of kws) {
          if (taskLower.includes(kw)) score += 3;
        }
      }
    }
    if (score > 0) requiredMCPs.push(mcpName);
  }

  return requiredMCPs;
}

export function generateSmartParams(tool: any, task: string): any {
  const params: any = {};
  const props = tool.inputSchema?.properties;
  if (!props) return params;

  for (const [paramName, paramSchema] of Object.entries(props)) {
    const schema: any = paramSchema;
    const lower = paramName.toLowerCase();

    if (lower.includes("title") || lower.includes("name")) {
      params[paramName] = extractTitle(task);
    } else if (lower.includes("description") || lower.includes("body")) {
      params[paramName] = `Generated from task: ${task}`;
    } else if (lower.includes("branch")) {
      params[paramName] = generateBranchName(task);
    } else if (
      lower.includes("list") &&
      task.toLowerCase().includes("backlog")
    ) {
      params[paramName] = "backlog";
    } else if (schema.default !== undefined) {
      params[paramName] = schema.default;
    } else if (schema.type === "boolean") {
      params[paramName] = true;
    } else if (schema.type === "string") {
      params[paramName] = `Auto: ${task.substring(0, 30)}...`;
    }
  }

  return params;
}

function extractTitle(task: string): string {
  const words = task
    .split(" ")
    .filter(
      (w) =>
        ![
          "quiero",
          "crear",
          "make",
          "create",
          "una",
          "un",
          "el",
          "la",
        ].includes(w.toLowerCase())
    );
  return words.slice(0, 4).join(" ").substring(0, 50);
}

function generateBranchName(task: string): string {
  const clean = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 30);
  return `feature/${clean}`;
}
