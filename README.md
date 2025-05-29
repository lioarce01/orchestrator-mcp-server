# MCP Orchestrator Server

A MCP server that acts as the central orchestrator to coordinate tasks between multiple specialized MCP services (Trello, GitHub, etc.).

## 🚀 Installation and Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure MCP services

Make sure your Trello and GitHub MCP servers are running:

```bash
# Terminal 1 - Trello MCP Server (port 3001)
docker run -p 3001:3001 trello-mcp-server

# Terminal 2 - GitHub MCP Server (port 3002)
docker run -p 3002:3002 github-mcp-server
```

### 3. Run the orchestrator

```bash
# Development mode
npm run dev

# Production mode
npm run build && npm start
```

## 🎯 Available Tools

### `planDevelopmentFeature`

Automatically creates necessary resources for a new feature:

- "Backlog" list in Trello (if it doesn't exist)
- Card with the feature name
- `feature/feature-name` branch in GitHub

**Parameters:**

- `featureName`: Name of the feature
- `trelloBoard`: Trello board ID or name
- `githubRepo`: GitHub repository (`owner/repo` format)
- `baseBranch`: Base branch (default: `main`)
- `description`: Optional description

### `executeMultiServiceTask`

Executes custom tasks across multiple MCP services.

**Parameters:**

- `tasks`: Array of tasks in the following format:

  ```json
  {
    "service": "trello|github",
    "method": "createList|createCard|createBranch|etc",
    "params": {
      /* method-specific parameters */
    }
  }
  ```

## 📋 Usage Examples

### Example 1: Full feature planning

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "planDevelopmentFeature",
    "arguments": {
      "featureName": "Google Login",
      "trelloBoard": "my-project-board-id",
      "githubRepo": "myuser/myproject",
      "baseBranch": "main",
      "description": "Implement OAuth2 authentication with Google"
    }
  }
}
```

**Expected result:**

- ✅ "Backlog" list created in Trello
- ✅ "Google Login" card added to the list
- ✅ Branch `feature/google-login` created from `main`

### Example 2: Custom multi-service tasks

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "executeMultiServiceTask",
    "arguments": {
      "tasks": [
        {
          "service": "trello",
          "method": "createList",
          "params": {
            "boardId": "board123",
            "name": "Sprint 1"
          }
        },
        {
          "service": "github",
          "method": "createBranch",
          "params": {
            "repo": "myuser/myproject",
            "branchName": "hotfix/critical-bug",
            "baseBranch": "main"
          }
        }
      ]
    }
  }
}
```

## 🔧 Architecture

```
[AI Agent / User]
       ↓
[MCP Orchestrator] ← Central coordination
       ↓
┌──────────────────────────────────────────────┐
│  Trello MCP        │   GitHub MCP       │ (GitHub MCP not implemented yet)
│  (port 3001)       │   (port 3002)      │
└──────────────────────────────────────────────┘
```

### Workflow:

1. **Reception**: The orchestrator receives a high-level instruction
2. **Analysis**: It determines which services and methods to invoke
3. **Delegation**: Sends JSON-RPC requests to the respective MCP servers
4. **Coordination**: Collects results and handles errors
5. **Response**: Returns a unified summary of all operations

## 🛠️ Extensibility

To add new MCP services, modify the `registerDefaultServers()` method:

```typescript
this.registeredServers.set("slack", {
  name: "slack",
  baseUrl: "http://localhost:3003",
  endpoints: {
    sendMessage: "/mcp",
    createChannel: "/mcp",
  },
});
```

## 🐛 Error Handling

The orchestrator includes robust error handling:

- **Network failures**: Automatic timeouts and retries
- **Unavailable services**: Continues with available services
- **Validation errors**: Reports which parameter failed
- **Partial responses**: Indicates which operations succeeded

## 📝 Logs and Debugging

Results include detailed debugging info:

```json
{
  "summary": "Development feature planning completed: 3/3 tasks successful",
  "results": [
    {
      "service": "trello",
      "method": "createList",
      "success": true,
      "result": { "id": "list123", "name": "Backlog" }
    }
  ],
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

## 🤝 Integration with AI Agents

This orchestrator is designed to work with AI agents like Claude. The agent can:

1. Interpret natural language instructions
2. Translate them into structured JSON-RPC calls
3. Send them to the orchestrator
4. Interpret and present results to the user

**Example agent prompt:**

> "Create a task to implement Google login. I want it added to Trello in the 'MyProject' board and also create the branch in GitHub under 'user/myapp'"

The agent would translate this into a `planDevelopmentFeature` call with the appropriate parameters.
