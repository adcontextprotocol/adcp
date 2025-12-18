import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AgentService } from "./agent-service.js";
import { MemberDatabase } from "./db/member-db.js";
import { AgentValidator } from "./validator.js";
import type { AgentType, MemberOffering } from "./types.js";

/**
 * Tool definitions for the AdCP Directory MCP server.
 * These are shared between stdio and HTTP transports.
 */
export const TOOL_DEFINITIONS = [
  // Member tools
  {
    name: "list_members",
    description:
      "List AdCP member organizations in the directory, optionally filtered by offerings or search term",
    inputSchema: {
      type: "object" as const,
      properties: {
        offerings: {
          type: "array",
          items: {
            type: "string",
            enum: ["buyer_agent", "sales_agent", "creative_agent", "signals_agent", "consulting", "other"],
          },
          description: "Filter by member offerings (what services they provide)",
        },
        markets: {
          type: "array",
          items: { type: "string" },
          description: "Filter by markets served (e.g., 'North America', 'APAC')",
        },
        search: {
          type: "string",
          description: "Search term to filter members by name, description, or tags",
        },
        limit: {
          type: "number",
          description: "Maximum number of members to return",
        },
      },
    },
  },
  {
    name: "get_member",
    description: "Get detailed information about a specific AdCP member by slug",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Member slug identifier (e.g., 'acme-media')",
        },
      },
      required: ["slug"],
    },
  },
  // Agent tools (backwards compatible)
  {
    name: "list_agents",
    description:
      "List all public agents from member organizations, optionally filtered by type (creative, signals, sales)",
    inputSchema: {
      type: "object" as const,
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
    description: "Get details for a specific agent by URL",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Agent URL (e.g., 'https://sales.example.com')",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "validate_agent",
    description:
      "Validate if an agent is authorized for a publisher domain by checking /.well-known/adagents.json",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
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
      type: "object" as const,
      properties: {
        agent_url: {
          type: "string",
          description: "Agent URL to query",
        },
      },
      required: ["agent_url"],
    },
  },
  {
    name: "find_agents_for_property",
    description: "Find which agents can sell a specific property",
    inputSchema: {
      type: "object" as const,
      properties: {
        property_type: {
          type: "string",
          description: "Property identifier type (e.g., 'domain', 'app_id')",
        },
        property_value: {
          type: "string",
          description: "Property identifier value (e.g., 'nytimes.com')",
        },
      },
      required: ["property_type", "property_value"],
    },
  },
];

/**
 * Resource definitions for the AdCP Directory MCP server.
 */
export const RESOURCE_DEFINITIONS = [
  {
    uri: "members://directory",
    name: "Member Directory",
    mimeType: "application/json",
    description: "All public AdCP member organizations",
  },
  {
    uri: "agents://creative",
    name: "Creative Agents",
    mimeType: "application/json",
    description: "All public creative agents",
  },
  {
    uri: "agents://signals",
    name: "Signals Agents",
    mimeType: "application/json",
    description: "All public signals/audience agents",
  },
  {
    uri: "agents://sales",
    name: "Sales Agents",
    mimeType: "application/json",
    description: "All public media sales agents",
  },
  {
    uri: "agents://all",
    name: "All Agents",
    mimeType: "application/json",
    description: "All public agents across all types",
  },
];

/**
 * Handles tool calls for the AdCP Directory MCP server.
 * Shared between stdio and HTTP transports.
 */
export class MCPToolHandler {
  private agentService: AgentService;
  private memberDb: MemberDatabase;
  private validator: AgentValidator;

  constructor() {
    this.agentService = new AgentService();
    this.memberDb = new MemberDatabase();
    this.validator = new AgentValidator();
  }

  /**
   * Handle a tool call by name and return the result.
   */
  async handleToolCall(name: string, args: Record<string, unknown> | undefined): Promise<{
    content: Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; text: string } }>;
    isError?: boolean;
  }> {
    switch (name) {
      // Member tools
      case "list_members": {
        const offerings = args?.offerings as MemberOffering[] | undefined;
        const markets = args?.markets as string[] | undefined;
        const search = args?.search as string | undefined;
        const limit = args?.limit as number | undefined;

        const members = await this.memberDb.getPublicProfiles({
          offerings,
          markets,
          search,
          limit,
        });

        // Return simplified member info
        const simplified = members.map((m) => ({
          slug: m.slug,
          display_name: m.display_name,
          tagline: m.tagline,
          logo_url: m.logo_url,
          offerings: m.offerings,
          headquarters: m.headquarters,
          markets: m.markets,
          agents: m.agents.filter((a) => a.is_public).map((a) => ({
            url: a.url,
            type: a.type,
            name: a.name,
          })),
          contact_website: m.contact_website,
        }));

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: "members://directory",
                mimeType: "application/json",
                text: JSON.stringify({ members: simplified, count: simplified.length }, null, 2),
              },
            },
          ],
        };
      }

      case "get_member": {
        const slug = args?.slug as string;
        const member = await this.memberDb.getProfileBySlug(slug);

        if (!member || !member.is_public) {
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `member://${encodeURIComponent(slug)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({ error: "Member not found" }),
                },
              },
            ],
            isError: true,
          };
        }

        // Return full member info (but only public agents)
        const result = {
          slug: member.slug,
          display_name: member.display_name,
          tagline: member.tagline,
          description: member.description,
          logo_url: member.logo_url,
          brand_color: member.brand_color,
          offerings: member.offerings,
          headquarters: member.headquarters,
          markets: member.markets,
          tags: member.tags,
          agents: member.agents.filter((a) => a.is_public).map((a) => ({
            url: a.url,
            type: a.type,
            name: a.name,
          })),
          contact: {
            email: member.contact_email,
            website: member.contact_website,
            phone: member.contact_phone,
          },
          social: {
            linkedin: member.linkedin_url,
            twitter: member.twitter_url,
          },
        };

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `member://${encodeURIComponent(slug)}`,
                mimeType: "application/json",
                text: JSON.stringify(result, null, 2),
              },
            },
          ],
        };
      }

      // Agent tools
      case "list_agents": {
        const type = args?.type as AgentType | undefined;
        const agents = await this.agentService.listAgents(type);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: type ? `agents://${encodeURIComponent(type)}` : "agents://all",
                mimeType: "application/json",
                text: JSON.stringify({ agents, count: agents.length }, null, 2),
              },
            },
          ],
        };
      }

      case "get_agent": {
        const agentUrl = args?.url as string;
        const agent = await this.agentService.getAgentByUrl(agentUrl);
        if (!agent) {
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `agent://${encodeURIComponent(agentUrl)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({ error: "Agent not found" }),
                },
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `agent://${encodeURIComponent(agentUrl)}`,
                mimeType: "application/json",
                text: JSON.stringify(agent, null, 2),
              },
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
              type: "resource",
              resource: {
                uri: `validation://${encodeURIComponent(domain)}/${encodeURIComponent(agentUrl)}`,
                mimeType: "application/json",
                text: JSON.stringify(result, null, 2),
              },
            },
          ],
        };
      }

      case "find_agents_for_property": {
        const propertyType = args?.property_type as string;
        const propertyValue = args?.property_value as string;

        // Find agents that can sell this property
        const allAgents = await this.agentService.listAgents("sales");
        const matchingAgents = [];

        for (const agent of allAgents) {
          // Check if agent is authorized for this property
          const validation = await this.validator.validate(propertyValue, agent.url);
          if (validation.authorized) {
            matchingAgents.push({
              url: agent.url,
              name: agent.name,
              contact: agent.contact,
            });
          }
        }

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `agents://property/${propertyType}/${encodeURIComponent(propertyValue)}`,
                mimeType: "application/json",
                text: JSON.stringify({
                  property: { type: propertyType, value: propertyValue },
                  agents: matchingAgents,
                  count: matchingAgents.length,
                }, null, 2),
              },
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
            id: "query",
            name: "Query",
            agent_uri: agentUrl,
            protocol: "mcp",
          }]);
          const client = multiClient.agent("query");

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
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `adcp://products/${agentUrl}`,
                  mimeType: "application/json",
                  text: JSON.stringify({ error: message }),
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
            id: "query",
            name: "Query",
            agent_uri: agentUrl,
            protocol: "mcp",
          }]);
          const client = multiClient.agent("query");

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
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `adcp://formats/${agentUrl}`,
                  mimeType: "application/json",
                  text: JSON.stringify({ error: message }),
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
            id: "query",
            name: "Query",
            agent_uri: agentUrl,
            protocol: "mcp",
          }]);
          const client = multiClient.agent("query");

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
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `adcp://properties/${agentUrl}`,
                  mimeType: "application/json",
                  text: JSON.stringify({ error: message }),
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
  }

  /**
   * Handle a resource read request.
   */
  async handleResourceRead(uri: string): Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }> {
    // Handle members resource
    if (uri === "members://directory") {
      const members = await this.memberDb.getPublicProfiles({});
      const simplified = members.map((m) => ({
        slug: m.slug,
        display_name: m.display_name,
        tagline: m.tagline,
        offerings: m.offerings,
        headquarters: m.headquarters,
        agents_count: m.agents.filter((a) => a.is_public).length,
      }));

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(simplified, null, 2),
          },
        ],
      };
    }

    // Handle agents resources
    const match = uri.match(/^agents:\/\/(.+)$/);
    if (!match) {
      throw new Error("Invalid resource URI");
    }

    const type = match[1];
    let agents;

    if (type === "all") {
      agents = await this.agentService.listAgents();
    } else if (["creative", "signals", "sales"].includes(type)) {
      agents = await this.agentService.listAgents(type as AgentType);
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
  }
}

/**
 * Create and configure an MCP Server instance with all AdCP Directory tools and resources.
 * This is the single source of truth for MCP server configuration.
 */
export function createMCPServer(): Server {
  const server = new Server(
    {
      name: "adcp-directory",
      version: "0.2.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  const toolHandler = new MCPToolHandler();

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return toolHandler.handleToolCall(name, args as Record<string, unknown> | undefined);
  });

  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCE_DEFINITIONS,
  }));

  // Read resource contents
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return toolHandler.handleResourceRead(request.params.uri);
  });

  return server;
}
