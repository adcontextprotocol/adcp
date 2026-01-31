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
import { FederatedIndexService } from "./federated-index.js";
import { siDb } from "./db/si-db.js";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { AgentType, MemberOffering } from "./types.js";
import { BrandManager } from "./brand-manager.js";
import { fetchBrandData, isBrandfetchConfigured } from "./services/brandfetch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
            enum: ["buyer_agent", "sales_agent", "creative_agent", "signals_agent", "si_agent", "governance_agent", "publisher", "consulting", "other"],
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
  // Publisher tools
  {
    name: "list_publishers",
    description:
      "List all publishers (domains hosting /.well-known/adagents.json) including both registered members and discovered from crawling",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "lookup_domain",
    description:
      "Find all agents authorized for a specific publisher domain, showing both verified (from adagents.json) and claimed (from sales agents)",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Publisher domain to look up (e.g., 'nytimes.com')",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "get_agent_domains",
    description:
      "Get all publisher domains that an agent is authorized to sell for",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_url: {
          type: "string",
          description: "Agent URL to look up (e.g., 'https://sales.example.com')",
        },
      },
      required: ["agent_url"],
    },
  },
  // Brand tools
  {
    name: "resolve_brand",
    description:
      "Resolve a domain to its canonical brand identity by following brand.json redirects and resolving through house portfolios",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Domain to resolve (e.g., 'jumpman23.com' or 'nike.com')",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "validate_brand_json",
    description:
      "Validate a domain's /.well-known/brand.json file against the Brand Protocol schema",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Domain to validate (e.g., 'nike.com')",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "validate_brand_agent",
    description:
      "Validate that a brand agent is reachable and responding via MCP protocol",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent_url: {
          type: "string",
          description: "Brand agent URL to validate (e.g., 'https://agent.nike.com/mcp')",
        },
      },
      required: ["agent_url"],
    },
  },
  {
    name: "enrich_brand",
    description:
      "Fetch brand data (logo, colors, company info) from Brandfetch API when no brand.json exists. Returns enriched brand manifest.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Domain to enrich (e.g., 'nike.com')",
        },
      },
      required: ["domain"],
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
  {
    uri: "publishers://all",
    name: "All Publishers",
    mimeType: "application/json",
    description: "All public publisher domains hosting adagents.json",
  },
  {
    uri: "ui://si/{session_id}",
    name: "SI Agent UI",
    mimeType: "text/html",
    description: "Interactive A2UI surface for an SI agent session, rendered via MCP Apps",
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
  private federatedIndex: FederatedIndexService;
  private brandManager: BrandManager;

  constructor() {
    this.agentService = new AgentService();
    this.memberDb = new MemberDatabase();
    this.validator = new AgentValidator();
    this.federatedIndex = new FederatedIndexService();
    this.brandManager = new BrandManager();
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

      // Publisher tools
      case "list_publishers": {
        // Use federated index to include both registered and discovered publishers
        const publishers = await this.federatedIndex.listAllPublishers();
        const bySource = {
          registered: publishers.filter(p => p.source === 'registered').length,
          discovered: publishers.filter(p => p.source === 'discovered').length,
        };

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: "publishers://all",
                mimeType: "application/json",
                text: JSON.stringify({ publishers, count: publishers.length, sources: bySource }, null, 2),
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

      case "lookup_domain": {
        const domain = args?.domain as string;
        if (!domain) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: domain" }),
              },
            ],
            isError: true,
          };
        }
        const result = await this.federatedIndex.lookupDomain(domain);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `federated://domain/${encodeURIComponent(domain)}`,
                mimeType: "application/json",
                text: JSON.stringify(result, null, 2),
              },
            },
          ],
        };
      }

      case "get_agent_domains": {
        const agentUrl = args?.agent_url as string;
        if (!agentUrl) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: agent_url" }),
              },
            ],
            isError: true,
          };
        }
        const domains = await this.federatedIndex.getDomainsForAgent(agentUrl);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `federated://agent/${encodeURIComponent(agentUrl)}/domains`,
                mimeType: "application/json",
                text: JSON.stringify({ agent_url: agentUrl, domains, count: domains.length }, null, 2),
              },
            },
          ],
        };
      }

      // Brand tools
      case "resolve_brand": {
        const domain = args?.domain as string;
        if (!domain) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: domain" }),
              },
            ],
            isError: true,
          };
        }
        const resolved = await this.brandManager.resolveBrand(domain);
        if (!resolved) {
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `brand://${encodeURIComponent(domain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    error: "Could not resolve brand",
                    domain,
                    hint: "Ensure the domain has a valid /.well-known/brand.json file",
                  }, null, 2),
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
                uri: `brand://${encodeURIComponent(resolved.canonical_domain)}`,
                mimeType: "application/json",
                text: JSON.stringify(resolved, null, 2),
              },
            },
          ],
        };
      }

      case "validate_brand_json": {
        const domain = args?.domain as string;
        if (!domain) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: domain" }),
              },
            ],
            isError: true,
          };
        }
        const validation = await this.brandManager.validateDomain(domain);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `brand://validation/${encodeURIComponent(domain)}`,
                mimeType: "application/json",
                text: JSON.stringify(validation, null, 2),
              },
            },
          ],
        };
      }

      case "validate_brand_agent": {
        const agentUrl = args?.agent_url as string;
        if (!agentUrl) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: agent_url" }),
              },
            ],
            isError: true,
          };
        }
        const validation = await this.brandManager.validateBrandAgent(agentUrl);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `brand://agent/${encodeURIComponent(agentUrl)}/validation`,
                mimeType: "application/json",
                text: JSON.stringify(validation, null, 2),
              },
            },
          ],
        };
      }

      case "enrich_brand": {
        const domain = args?.domain as string;
        if (!domain) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: domain" }),
              },
            ],
            isError: true,
          };
        }

        if (!isBrandfetchConfigured()) {
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `brand://enrichment/${encodeURIComponent(domain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    error: "Brandfetch not configured",
                    hint: "Set BRANDFETCH_API_KEY environment variable",
                  }, null, 2),
                },
              },
            ],
            isError: true,
          };
        }

        const enrichment = await fetchBrandData(domain);
        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `brand://enrichment/${encodeURIComponent(domain)}`,
                mimeType: "application/json",
                text: JSON.stringify({
                  ...enrichment,
                  source: "enriched",
                  enrichment_provider: "brandfetch",
                }, null, 2),
              },
            },
          ],
        };
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
    // Handle SI agent UI resource (MCP Apps)
    const siMatch = uri.match(/^ui:\/\/si\/(.+)$/);
    if (siMatch) {
      const sessionId = siMatch[1];
      return this.handleSiUiResource(uri, sessionId);
    }

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
        publishers_count: (m.publishers || []).filter((p) => p.is_public).length,
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

    // Handle publishers resource
    if (uri === "publishers://all") {
      const members = await this.memberDb.getPublicProfiles({});
      const publishers = members.flatMap((m) =>
        (m.publishers || [])
          .filter((p) => p.is_public)
          .map((p) => ({
            domain: p.domain,
            agent_count: p.agent_count,
            last_validated: p.last_validated,
            member: {
              slug: m.slug,
              display_name: m.display_name,
            },
          }))
      );

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(publishers, null, 2),
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

  /**
   * Handle SI UI resource request - serves MCP Apps shell with A2UI surface
   */
  private async handleSiUiResource(uri: string, sessionId: string): Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }> {
    // Get the session to retrieve the latest A2UI surface
    const session = await siDb.getSession(sessionId);
    if (!session) {
      throw new Error(`SI session not found: ${sessionId}`);
    }

    // Get the most recent message with a surface
    const messages = await siDb.getSessionMessages(sessionId, 1);
    const latestMessage = messages[0];

    // Build a surface from ui_elements if we don't have a native surface yet
    // This provides backwards compatibility during migration
    let surface = latestMessage?.ui_elements
      ? {
          surfaceId: `si-session-${sessionId}`,
          catalogId: "si-standard",
          components: (latestMessage.ui_elements as Array<{ type: string; data: Record<string, unknown> }>).map((el, idx) => ({
            id: `elem-${idx}`,
            component: { [el.type]: el.data },
          })),
        }
      : {
          surfaceId: `si-session-${sessionId}`,
          catalogId: "si-standard",
          components: [],
        };

    // Read the shell template
    const shellPath = join(__dirname, "../public/si-apps/shell.html");
    let shellHtml: string;
    try {
      shellHtml = await readFile(shellPath, "utf-8");
    } catch {
      throw new Error("SI Apps shell template not found");
    }

    // Inject the surface data into the shell
    const surfaceScript = `window.__SI_SURFACE__ = ${JSON.stringify(surface)};`;
    const injectedHtml = shellHtml.replace(
      /\/\/ This will be replaced by server-side injection[\s\S]*?\/\/ window\.__SI_SURFACE__ = .*$/m,
      surfaceScript
    );

    return {
      contents: [
        {
          uri,
          mimeType: "text/html",
          text: injectedHtml,
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
