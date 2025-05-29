// MCP Orchestrator Server - Fixed Version
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

// Interfaces for MCP communication
interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface TaskResult {
  service: string;
  method: string;
  success: boolean;
  result?: any;
  error?: string;
}

// Configuration for registered MCP servers
interface MCPServerConfig {
  name: string;
  baseUrl: string;
  endpoints: {
    [method: string]: string;
  };
}

class MCPOrchestrator {
  private server: Server;
  private registeredServers: Map<string, MCPServerConfig> = new Map();

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-orchestrator',
        version: '1.0.0',
      },
    );

    this.setupHandlers();
    this.registerDefaultServers();
  }

  private registerDefaultServers() {
    // Register Trello MCP Server
    this.registeredServers.set('trello', {
      name: 'trello',
      baseUrl: 'http://localhost:3001',
      endpoints: {
        createList: '/mcp',
        createCard: '/mcp',
        listBoards: '/mcp',
        listLists: '/mcp',
        readBoard: '/mcp'
      }
    });

    // Register GitHub MCP Server (commented out until implemented)
    /*
    this.registeredServers.set('github', {
      name: 'github', 
      baseUrl: 'http://localhost:3002',
      endpoints: {
        createBranch: '/mcp',
        listRepos: '/mcp',
        createPullRequest: '/mcp',
        listBranches: '/mcp'
      }
    });
    */
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.error('ListTools request received');
      return {
        tools: [
          {
            name: 'planDevelopmentFeature',
            description: 'Plan and execute development feature creation across multiple platforms (Trello + GitHub)',
            inputSchema: {
              type: 'object',
              properties: {
                featureName: {
                  type: 'string',
                  description: 'Name of the feature to develop'
                },
                trelloBoard: {
                  type: 'string',
                  description: 'Trello board ID or name'
                },
                githubRepo: {
                  type: 'string',
                  description: 'GitHub repository name (owner/repo)'
                },
                baseBranch: {
                  type: 'string',
                  description: 'Base branch for the new feature branch',
                  default: 'main'
                },
                description: {
                  type: 'string',
                  description: 'Description for the feature card and branch'
                }
              },
              required: ['featureName', 'trelloBoard']
            }
          },
          {
            name: 'executeMultiServiceTask',
            description: 'Execute custom tasks across multiple MCP services',
            inputSchema: {
              type: 'object',
              properties: {
                tasks: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      service: { type: 'string' },
                      method: { type: 'string' },
                      params: { type: 'object' }
                    },
                    required: ['service', 'method', 'params']
                  }
                }
              },
              required: ['tasks']
            }
          },
          {
            name: 'listTrelloBoards',
            description: 'List all available Trello boards',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error(`CallTool request received: ${request.params.name}`);
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'planDevelopmentFeature':
            return await this.handlePlanDevelopmentFeature(args);
          case 'executeMultiServiceTask':
            return await this.handleExecuteMultiServiceTask(args);
          case 'listTrelloBoards':
            return await this.handleListTrelloBoards();
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        console.error(`Error executing ${name}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private async handleListTrelloBoards() {
    try {
      const result = await this.callMCPService('trello', 'listBoards', {});
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: 'Trello boards retrieved successfully',
              boards: result.result?.content?.[0]?.text ? JSON.parse(result.result.content[0].text) : result.result,
              timestamp: new Date().toISOString()
            }, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to list Trello boards: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date().toISOString()
            }, null, 2)
          }
        ]
      };
    }
  }

  private async handlePlanDevelopmentFeature(args: any) {
    const { featureName, trelloBoard, githubRepo, baseBranch = 'main', description } = args;
    
    const results: TaskResult[] = [];
    const listName = `Feature: ${featureName}`;
    const branchName = `feature/${featureName.toLowerCase().replace(/\s+/g, '-')}`;

    console.error(`Planning feature: ${featureName} for board: ${trelloBoard}`);

    // Task 1: Create Trello List and Card
    try {
      // First, let's list boards to get the board ID if needed
      const boardsResult = await this.callMCPService('trello', 'listBoards', {});
      console.error('Boards result:', JSON.stringify(boardsResult, null, 2));
      
      // Create List
      const listResult = await this.callMCPService('trello', 'createList', {
        boardId: trelloBoard,
        name: listName
      });
      
      console.error('List creation result:', JSON.stringify(listResult, null, 2));
      
      results.push({
        service: 'trello',
        method: 'createList',
        success: !listResult.error,
        result: listResult.result,
        error: listResult.error?.message
      });

      // Create Card if list creation was successful
      if (!listResult.error && listResult.result) {
        let listId = null;
        
        // Try to extract list ID from the result
        if (listResult.result.content && listResult.result.content[0]) {
          try {
            const listData = JSON.parse(listResult.result.content[0].text);
            listId = listData.id;
          } catch (e) {
            console.error('Error parsing list result:', e);
          }
        }

        if (listId) {
          const cardResult = await this.callMCPService('trello', 'createCard', {
            listId: listId,
            name: featureName,
            desc: description || `Implementation of ${featureName} feature`
          });

          console.error('Card creation result:', JSON.stringify(cardResult, null, 2));

          results.push({
            service: 'trello',
            method: 'createCard', 
            success: !cardResult.error,
            result: cardResult.result,
            error: cardResult.error?.message
          });
        } else {
          results.push({
            service: 'trello',
            method: 'createCard',
            success: false,
            error: 'Could not extract list ID from list creation result'
          });
        }
      }

    } catch (error) {
      console.error('Trello operation error:', error);
      results.push({
        service: 'trello',
        method: 'createList/createCard',
        success: false,
        error: `Trello operation failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    // Task 2: Create GitHub Branch (commented out until GitHub MCP is implemented)
    /*
    if (githubRepo) {
      try {
        const branchResult = await this.callMCPService('github', 'createBranch', {
          repo: githubRepo,
          branchName: branchName,
          baseBranch: baseBranch
        });

        results.push({
          service: 'github',
          method: 'createBranch',
          success: !branchResult.error,
          result: branchResult.result,
          error: branchResult.error?.message
        });

      } catch (error) {
        results.push({
          service: 'github',
          method: 'createBranch',
          success: false,
          error: `GitHub operation failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    */

    // Generate summary
    const successful = results.filter(r => r.success).length;
    const total = results.length;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: `Development feature planning completed: ${successful}/${total} tasks successful`,
            featureName,
            trelloBoard,
            githubRepo: githubRepo || 'Not provided',
            createdResources: {
              trelloList: listName,
              trelloCard: featureName,
              githubBranch: githubRepo ? branchName : 'Not created (GitHub repo not provided)'
            },
            results,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ]
    };
  }

  private async handleExecuteMultiServiceTask(args: any) {
    const { tasks } = args;
    const results: TaskResult[] = [];

    console.error(`Executing ${tasks.length} multi-service tasks`);

    for (const task of tasks) {
      try {
        console.error(`Executing task: ${task.service}.${task.method}`);
        const result = await this.callMCPService(task.service, task.method, task.params);
        results.push({
          service: task.service,
          method: task.method,
          success: !result.error,
          result: result.result,
          error: result.error?.message
        });
      } catch (error) {
        console.error(`Task execution error for ${task.service}.${task.method}:`, error);
        results.push({
          service: task.service,
          method: task.method,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const successful = results.filter(r => r.success).length;
    const total = results.length;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: `Multi-service task execution completed: ${successful}/${total} tasks successful`,
            results,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ]
    };
  }

  private async callMCPService(serviceName: string, method: string, params: any): Promise<MCPResponse> {
    const serverConfig = this.registeredServers.get(serviceName);
    if (!serverConfig) {
      throw new Error(`Service ${serviceName} not registered`);
    }

    const endpoint = serverConfig.endpoints[method];
    if (!endpoint) {
      throw new Error(`Method ${method} not available for service ${serviceName}`);
    }

    const mcpRequest: MCPRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: method,
        arguments: params
      }
    };

    const url = `${serverConfig.baseUrl}${endpoint}`;
    
    console.error(`Calling ${serviceName}.${method} at ${url}`);
    console.error(`Request:`, JSON.stringify(mcpRequest, null, 2));
    
    try {
      const response = await axios.post(url, mcpRequest, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000
      });

      console.error(`Response status: ${response.status}`);
      console.error(`Response data:`, JSON.stringify(response.data, null, 2));

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = response.data as MCPResponse;
      return result;

    } catch (error) {
      console.error(`Error calling ${serviceName}.${method}:`, error);
      return {
        jsonrpc: '2.0',
        id: mcpRequest.id,
        error: {
          code: -32603,
          message: `Failed to call ${serviceName}.${method}`,
          data: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MCP Orchestrator Server running on stdio');
  }
}

// Main execution
async function main() {
  const orchestrator = new MCPOrchestrator();
  await orchestrator.run();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('Shutting down MCP Orchestrator Server...');
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error in MCP Orchestrator Server:', error);
  process.exit(1);
});

export default MCPOrchestrator;