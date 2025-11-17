import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Registry } from "./registry.js";
import { AgentValidator } from "./validator.js";
import type { AgentType } from "./types.js";

export class MCPServer {
  private server: Server;
  private registry: Registry;
  private validator: AgentValidator;

  constructor() {
    this.server = new Server(
      {
        name: "adcp-registry",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.registry = new Registry();
    this.validator = new AgentValidator();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "list_agents",
          description:
            "List all registered agents, optionally filtered by type (creative, signals, sales)",
          inputSchema: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["creative", "signals", "sales"],
                description: "Optional: Filter by agent type",
              },
            },
          },
        },
        {
          name: "get_agent",
          description: "Get details for a specific agent by name",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Agent identifier (e.g., 'creative/example-creative-agent')",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "validate_agent",
          description:
            "Validate if an agent is authorized for a publisher domain by checking /.well-known/adagents.json",
          inputSchema: {
            type: "object",
            properties: {
              domain: {
                type: "string",
                description: "Publisher domain (e.g., 'nytimes.com')",
              },
              agent_url: {
                type: "string",
                description: "Agent URL to validate (e.g., 'https://sales.example.com')",
              },
            },
            required: ["domain", "agent_url"],
          },
        },
        {
          name: "get_products_for_agent",
          description:
            "Query a sales agent for available products (proxy tool that calls get_products on the agent)",
          inputSchema: {
            type: "object",
            properties: {
              agent_url: {
                type: "string",
                description: "Agent URL to query",
              },
              params: {
                type: "object",
                description: "Parameters to pass to get_products (leave empty for public products)",
              },
            },
            required: ["agent_url"],
          },
        },
        {
          name: "list_creative_formats_for_agent",
          description:
            "Query an agent for supported creative formats (proxy tool that calls list_creative_formats on the agent)",
          inputSchema: {
            type: "object",
            properties: {
              agent_url: {
                type: "string",
                description: "Agent URL to query",
              },
              params: {
                type: "object",
                description: "Parameters to pass to list_creative_formats",
              },
            },
            required: ["agent_url"],
          },
        },
        {
          name: "get_properties_for_agent",
          description:
            "Query a sales agent for authorized properties (proxy tool that calls list_authorized_properties on the agent)",
          inputSchema: {
            type: "object",
            properties: {
              agent_url: {
                type: "string",
                description: "Agent URL to query",
              },
            },
            required: ["agent_url"],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "list_agents": {
          const type = args?.type as AgentType | undefined;
          const agents = this.registry.listAgents(type);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(agents, null, 2),
              },
            ],
          };
        }

        case "get_agent": {
          const agentName = args?.name as string;
          const agent = this.registry.getAgent(agentName);
          if (!agent) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: "Agent not found" }),
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(agent, null, 2),
              },
            ],
          };
        }

        case "validate_agent": {
          const domain = args?.domain as string;
          const agentUrl = args?.agent_url as string;
          const result = await this.validator.validate(domain, agentUrl);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_products_for_agent": {
          const agentUrl = args?.agent_url as string;
          const params = args?.params || {};

          try {
            const { AdCPClient } = await import("@adcp/client");
            const multiClient = new AdCPClient([{
              id: "registry",
              name: "Registry Query",
              agent_uri: agentUrl,
              protocol: "mcp",
            }]);
            const client = multiClient.agent("registry");

            const result = await client.executeTask("get_products", params);

            if (!result.success) {
              return {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `adcp://products/${agentUrl}`,
                      mimeType: "application/json",
                      text: JSON.stringify({ error: result.error || "Failed to get products" }),
                    },
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `adcp://products/${agentUrl}`,
                    mimeType: "application/json",
                    text: JSON.stringify(result.data),
                  },
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `adcp://products/${agentUrl}`,
                    mimeType: "application/json",
                    text: JSON.stringify({ error: error.message }),
                  },
                },
              ],
            };
          }
        }

        case "list_creative_formats_for_agent": {
          const agentUrl = args?.agent_url as string;
          const params = args?.params || {};

          try {
            const { AdCPClient } = await import("@adcp/client");
            const multiClient = new AdCPClient([{
              id: "registry",
              name: "Registry Query",
              agent_uri: agentUrl,
              protocol: "mcp",
            }]);
            const client = multiClient.agent("registry");

            const result = await client.executeTask("list_creative_formats", params);

            if (!result.success) {
              return {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `adcp://formats/${agentUrl}`,
                      mimeType: "application/json",
                      text: JSON.stringify({ error: result.error || "Failed to list formats" }),
                    },
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `adcp://formats/${agentUrl}`,
                    mimeType: "application/json",
                    text: JSON.stringify(result.data),
                  },
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `adcp://formats/${agentUrl}`,
                    mimeType: "application/json",
                    text: JSON.stringify({ error: error.message }),
                  },
                },
              ],
            };
          }
        }

        case "get_properties_for_agent": {
          const agentUrl = args?.agent_url as string;

          try {
            const { AdCPClient } = await import("@adcp/client");
            const multiClient = new AdCPClient([{
              id: "registry",
              name: "Registry Query",
              agent_uri: agentUrl,
              protocol: "mcp",
            }]);
            const client = multiClient.agent("registry");

            const result = await client.executeTask("list_authorized_properties", {});

            if (!result.success) {
              return {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `adcp://properties/${agentUrl}`,
                      mimeType: "application/json",
                      text: JSON.stringify({ error: result.error || "Failed to list properties" }),
                    },
                  },
                ],
              };
            }

            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `adcp://properties/${agentUrl}`,
                    mimeType: "application/json",
                    text: JSON.stringify(result.data),
                  },
                },
              ],
            };
          } catch (error: any) {
            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `adcp://properties/${agentUrl}`,
                    mimeType: "application/json",
                    text: JSON.stringify({ error: error.message }),
                  },
                },
              ],
            };
          }
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Unknown tool" }),
              },
            ],
            isError: true,
          };
      }
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: "agents://creative",
          name: "Creative Agents",
          mimeType: "application/json",
          description: "All registered creative agents",
        },
        {
          uri: "agents://signals",
          name: "Signals Agents",
          mimeType: "application/json",
          description: "All registered signals/audience agents",
        },
        {
          uri: "agents://sales",
          name: "Sales Agents",
          mimeType: "application/json",
          description: "All registered media sales agents",
        },
        {
          uri: "agents://all",
          name: "All Agents",
          mimeType: "application/json",
          description: "All registered agents across all types",
        },
      ],
    }));

    // Read resource contents
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const match = uri.match(/^agents:\/\/(.+)$/);

      if (!match) {
        throw new Error("Invalid resource URI");
      }

      const type = match[1];
      let agents;

      if (type === "all") {
        agents = this.registry.listAgents();
      } else if (["creative", "signals", "sales"].includes(type)) {
        agents = this.registry.listAgents(type as AgentType);
      } else {
        throw new Error("Unknown resource type");
      }

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(agents, null, 2),
          },
        ],
      };
    });
  }

  async start(): Promise<void> {
    await this.registry.load();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("AdCP Registry MCP server running on stdio");
  }
}
