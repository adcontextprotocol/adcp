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
import { brandDb } from "./db/brand-db.js";
import { propertyDb } from "./db/property-db.js";
import { registryRequestsDb } from "./db/registry-requests-db.js";
import { fetchBrandData, isBrandfetchConfigured, ENRICHMENT_CACHE_MAX_AGE_MS } from "./services/brandfetch.js";
import { AdAgentsManager } from "./adagents-manager.js";
import { bansDb } from "./db/bans-db.js";
import { notifyRegistryCreate, notifyRegistryEdit } from "./notifications/registry.js";
import { reviewNewRecord, reviewRegistryEdit } from "./addie/mcp/registry-review.js";
import type { MCPAuthContext } from "./mcp/auth.js";
import { createLogger } from "./logger.js";

const logger = createLogger('mcp-tools');

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalize and validate a domain string.
 * Strips protocol prefix and trailing slashes, lowercases, then validates format.
 * Returns null if invalid.
 */
function sanitizeDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
  return DOMAIN_REGEX.test(cleaned) ? cleaned : null;
}

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
  // Property tools
  {
    name: "resolve_property",
    description:
      "Resolve a publisher domain to its property information. Checks hosted properties, discovered properties, and live adagents.json.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Publisher domain to resolve (e.g., 'cnn.com')",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "list_properties",
    description:
      "List publisher properties in the registry. Includes hosted properties (synthetic adagents.json) and discovered properties (from crawled adagents.json). Can filter by source type and search by domain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source: {
          type: "string",
          enum: ["adagents_json", "hosted", "community", "discovered", "enriched"],
          description: "Filter by source type (hosted = synthetic, adagents_json = crawled from live site)",
        },
        search: {
          type: "string",
          description: "Search term for publisher domain",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 20, max: 100)",
        },
      },
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
        fresh: {
          type: "boolean",
          description: "Bypass cache and fetch fresh data (default: false)",
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
        fresh: {
          type: "boolean",
          description: "Bypass cache and fetch fresh data (default: false)",
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
  {
    name: "list_brands",
    description:
      "List brands in the registry. Includes brands with published brand.json, community-contributed brands, and enriched brands. Can filter by source type and search by name or domain.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source_type: {
          type: "string",
          enum: ["brand_json", "hosted", "community", "enriched"],
          description: "Filter by how the brand was added (brand_json = published manifest, hosted = self-hosted, community = contributed, enriched = via Brandfetch)",
        },
        search: {
          type: "string",
          description: "Search term for brand name or domain",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 20, max: 100)",
        },
      },
    },
  },
  // Community registry write tools
  {
    name: "save_brand",
    description:
      "Save a brand to the community registry. Creates a new brand (pending review) or edits an existing one (revision-tracked). Requires authentication.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Brand domain (e.g., 'acme-corp.com')",
        },
        brand_name: {
          type: "string",
          description: "Brand name",
        },
        house_domain: {
          type: "string",
          description: "Parent house/corporate brand domain (e.g., 'unilever.com')",
        },
        keller_type: {
          type: "string",
          enum: ["master", "sub_brand", "endorsed", "independent"],
          description: "Keller brand architecture type",
        },
        parent_brand: {
          type: "string",
          description: "Parent brand domain within the house portfolio",
        },
        brand_manifest: {
          type: "object",
          description: "Brand identity data (logo, colors, company info) stored in the registry",
        },
        edit_summary: {
          type: "string",
          description: "Summary of changes (required for edits, ignored for new brands)",
        },
      },
      required: ["domain", "brand_name"],
    },
  },
  {
    name: "save_property",
    description:
      "Save a publisher property to the community registry. Creates a new property (pending review) or edits an existing one (revision-tracked). Requires authentication.",
    inputSchema: {
      type: "object" as const,
      properties: {
        publisher_domain: {
          type: "string",
          description: "Publisher domain (e.g., 'example-news.com')",
        },
        authorized_agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" },
              authorized_for: { type: "string" },
            },
          },
          description: "Authorized agents for this property",
        },
        properties: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              name: { type: "string" },
            },
          },
          description: "Property inventory types",
        },
        contact: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          description: "Contact information for the property",
        },
        edit_summary: {
          type: "string",
          description: "Summary of changes (required for edits, ignored for new properties)",
        },
      },
      required: ["publisher_domain"],
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
    uri: "properties://registry",
    name: "Property Registry",
    mimeType: "application/json",
    description: "All publisher properties in the registry (hosted + discovered)",
  },
  {
    uri: "brands://registry",
    name: "Brand Registry",
    mimeType: "application/json",
    description: "All brands in the registry (hosted + discovered)",
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
  private adagentsManager: AdAgentsManager;

  constructor() {
    this.agentService = new AgentService();
    this.memberDb = new MemberDatabase();
    this.validator = new AgentValidator();
    this.federatedIndex = new FederatedIndexService();
    this.brandManager = new BrandManager();
    this.adagentsManager = new AdAgentsManager();
  }

  /**
   * Handle a tool call by name and return the result.
   */
  async handleToolCall(name: string, args: Record<string, unknown> | undefined, authContext?: MCPAuthContext): Promise<{
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

        // Enrich with hosted property data when federated index has no results
        if (result.authorized_agents.length === 0 && result.sales_agents_claiming.length === 0) {
          const hostedProp = await propertyDb.getHostedPropertyByDomain(domain);
          if (hostedProp && hostedProp.is_public && (!hostedProp.review_status || hostedProp.review_status === 'approved')) {
            const adagents = hostedProp.adagents_json as Record<string, unknown>;
            const authorizedAgents = (adagents.authorized_agents as Array<{ url: string; authorized_for?: string }>) || [];
            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `federated://domain/${encodeURIComponent(domain)}`,
                    mimeType: "application/json",
                    text: JSON.stringify({
                      domain,
                      source: "hosted",
                      authorized_agents: authorizedAgents.map(a => ({
                        url: a.url,
                        authorized_for: a.authorized_for,
                        source: "hosted",
                      })),
                      sales_agents_claiming: [],
                    }, null, 2),
                  },
                },
              ],
            };
          }
        }

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
        const fresh = args?.fresh as boolean | undefined;
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
        const resolved = await this.brandManager.resolveBrand(domain, { skipCache: fresh });
        if (!resolved) {
          // Fallback to discovered brands registry (skip pending review)
          const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
          if (discovered && (!discovered.review_status || discovered.review_status === 'approved')) {
            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `brand://${encodeURIComponent(domain)}`,
                    mimeType: "application/json",
                    text: JSON.stringify({
                      source: "registry",
                      source_type: discovered.source_type,
                      domain: discovered.domain,
                      canonical_domain: discovered.canonical_domain,
                      brand_name: discovered.brand_name,
                      house_domain: discovered.house_domain,
                      keller_type: discovered.keller_type,
                      brand_agent_url: discovered.brand_agent_url,
                      has_manifest: discovered.has_brand_manifest,
                    }, null, 2),
                  },
                },
              ],
            };
          }

          // Track demand signal for missing brand
          registryRequestsDb.trackRequest('brand', domain).catch((err) => {
            logger.warn({ err, domain }, 'Failed to track brand demand signal');
          });

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
                    hint: "No brand.json found and not in registry",
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
        const fresh = args?.fresh as boolean | undefined;
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
        const validation = await this.brandManager.validateDomain(domain, { skipCache: fresh });
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
        const rawEnrichDomain = args?.domain as string;
        if (!rawEnrichDomain) {
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

        // Normalize domain for consistent DB lookups (strip protocol, paths, query strings)
        const enrichDomain = rawEnrichDomain.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\/$/, '').toLowerCase();

        // Check DB for recently enriched data (avoids redundant Brandfetch API calls)
        const existingBrand = await brandDb.getDiscoveredBrandByDomain(enrichDomain);
        if (existingBrand?.has_brand_manifest && existingBrand.brand_manifest && existingBrand.last_validated) {
          const ageMs = Date.now() - new Date(existingBrand.last_validated).getTime();
          if (ageMs < ENRICHMENT_CACHE_MAX_AGE_MS) {
            return {
              content: [
                {
                  type: "resource",
                  resource: {
                    uri: `brand://enrichment/${encodeURIComponent(enrichDomain)}`,
                    mimeType: "application/json",
                    text: JSON.stringify({
                      success: true,
                      domain: existingBrand.domain,
                      cached: true,
                      manifest: existingBrand.brand_manifest,
                      source: "enriched",
                      enrichment_provider: "brandfetch",
                    }, null, 2),
                  },
                },
              ],
            };
          }
        }

        if (!isBrandfetchConfigured()) {
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `brand://enrichment/${encodeURIComponent(enrichDomain)}`,
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

        const enrichment = await fetchBrandData(enrichDomain);

        // Save enrichment to DB for future cache hits
        if (enrichment.success && enrichment.manifest) {
          brandDb.upsertDiscoveredBrand({
            domain: enrichment.domain,
            brand_name: enrichment.manifest.name,
            brand_manifest: {
              name: enrichment.manifest.name,
              url: enrichment.manifest.url,
              description: enrichment.manifest.description,
              logos: enrichment.manifest.logos,
              colors: enrichment.manifest.colors,
              fonts: enrichment.manifest.fonts,
              ...(enrichment.company ? { company: enrichment.company } : {}),
            },
            has_brand_manifest: true,
            source_type: 'enriched',
          }).catch((err) => {
            logger.warn({ err, domain: enrichDomain }, 'Failed to cache enrichment result');
          });
        }

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `brand://enrichment/${encodeURIComponent(enrichDomain)}`,
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

      case "list_brands": {
        const sourceType = args?.source_type as 'brand_json' | 'hosted' | 'community' | 'enriched' | undefined;
        const search = args?.search as string | undefined;
        const rawLimit = typeof args?.limit === 'number' ? args.limit : 20;
        const limit = Math.min(Math.max(1, rawLimit), 100);

        // Over-fetch when filtering by source_type since filtering happens in-memory
        const fetchLimit = sourceType ? limit * 5 : limit;
        const brands = await brandDb.getAllBrandsForRegistry({ search, limit: fetchLimit });

        // Filter by source type if specified, then apply the requested limit
        const filtered = sourceType
          ? brands.filter(b => b.source === sourceType).slice(0, limit)
          : brands;

        const result = filtered.map(b => ({
          domain: b.domain,
          brand_name: b.brand_name,
          source: b.source,
          has_manifest: b.has_manifest,
          house_domain: b.house_domain,
          keller_type: b.keller_type,
        }));

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: "brands://registry",
                mimeType: "application/json",
                text: JSON.stringify({ brands: result, count: result.length }, null, 2),
              },
            },
          ],
        };
      }

      // Property tools
      case "resolve_property": {
        const domain = sanitizeDomain(args?.domain as string);
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

        // Check hosted properties first
        const hosted = await propertyDb.getHostedPropertyByDomain(domain);
        if (hosted && hosted.is_public && (!hosted.review_status || hosted.review_status === 'approved')) {
          const adagents = hosted.adagents_json as Record<string, unknown>;
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `property://${encodeURIComponent(domain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    source: "hosted",
                    publisher_domain: hosted.publisher_domain,
                    verified: hosted.domain_verified,
                    authorized_agents: (adagents.authorized_agents as unknown[])?.length || 0,
                    properties: (adagents.properties as unknown[])?.length || 0,
                    has_contact: !!adagents.contact,
                  }, null, 2),
                },
              },
            ],
          };
        }

        // Check discovered properties
        const discovered = await propertyDb.getDiscoveredPropertiesByDomain(domain);
        if (discovered.length > 0) {
          const agents = await propertyDb.getAgentAuthorizationsForDomain(domain);
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `property://${encodeURIComponent(domain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    source: "adagents_json",
                    publisher_domain: domain,
                    verified: true,
                    authorized_agents: [...new Set(agents.map(a => a.agent_url))].length,
                    agent_urls: [...new Set(agents.map(a => a.agent_url))],
                    properties: discovered.length,
                    property_types: [...new Set(discovered.map(p => p.property_type))],
                  }, null, 2),
                },
              },
            ],
          };
        }

        // Try live validation
        const validation = await this.adagentsManager.validateDomain(domain);
        if (validation.valid && validation.raw_data) {
          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: `property://${encodeURIComponent(domain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    source: "adagents_json",
                    publisher_domain: domain,
                    verified: true,
                    authorized_agents: validation.raw_data.authorized_agents?.length || 0,
                    agent_urls: validation.raw_data.authorized_agents?.map((a: { url: string }) => a.url) || [],
                    properties: validation.raw_data.properties?.length || 0,
                    has_contact: !!validation.raw_data.contact,
                  }, null, 2),
                },
              },
            ],
          };
        }

        // Track demand signal for missing property
        registryRequestsDb.trackRequest('property', domain).catch((err) => {
          logger.warn({ err, domain }, 'Failed to track property demand signal');
        });

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: `property://${encodeURIComponent(domain)}`,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: "Property not found",
                  domain,
                  hint: "No adagents.json found and not in registry",
                }, null, 2),
              },
            },
          ],
          isError: true,
        };
      }

      case "list_properties": {
        const source = args?.source as 'adagents_json' | 'hosted' | 'community' | 'discovered' | 'enriched' | undefined;
        const search = args?.search as string | undefined;
        const rawLimit = typeof args?.limit === 'number' ? args.limit : 20;
        const limit = Math.min(Math.max(1, rawLimit), 100);

        // Over-fetch when filtering by source since filtering happens in-memory
        const fetchLimit = source ? limit * 5 : limit;
        const properties = await propertyDb.getAllPropertiesForRegistry({ search, limit: fetchLimit });

        const filtered = source
          ? properties.filter(p => p.source === source).slice(0, limit)
          : properties;

        const result = filtered.map(p => ({
          domain: p.domain,
          source: p.source,
          property_count: p.property_count,
          agent_count: p.agent_count,
          verified: p.verified,
        }));

        return {
          content: [
            {
              type: "resource",
              resource: {
                uri: "properties://registry",
                mimeType: "application/json",
                text: JSON.stringify({ properties: result, count: result.length }, null, 2),
              },
            },
          ],
        };
      }

      // Community registry write tools
      case "save_brand": {
        if (!authContext || authContext.sub === 'anonymous') {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Authentication required to save brands" }) }],
            isError: true,
          };
        }

        const domain = sanitizeDomain(args?.domain as string);
        const brandName = args?.brand_name as string;
        if (!domain || !brandName) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "domain and brand_name are required" }) }],
            isError: true,
          };
        }

        const banCheck = await bansDb.isUserBannedFromRegistry('registry_brand', authContext.sub, domain);
        if (banCheck.banned) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "You are banned from editing brands", reason: banCheck.ban?.reason }) }],
            isError: true,
          };
        }

        // Validate brand_manifest size if provided
        if (args?.brand_manifest) {
          const manifestJson = JSON.stringify(args.brand_manifest);
          if (manifestJson.length > 50000) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "brand_manifest exceeds 50KB size limit" }) }],
              isError: true,
            };
          }
        }

        try {
          const existing = await brandDb.getDiscoveredBrandByDomain(domain);

          // Reject edits to authoritative brands (managed via brand.json)
          if (existing && existing.source_type === 'brand_json') {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "Cannot edit authoritative brand (managed via brand.json)" }) }],
              isError: true,
            };
          }

          if (existing) {
            // Edit existing brand with revision tracking
            const editSummary = (args?.edit_summary as string) || 'MCP community edit';
            const { brand, revision_number } = await brandDb.editDiscoveredBrand(domain, {
              brand_name: brandName,
              house_domain: args?.house_domain as string | undefined,
              keller_type: args?.keller_type as 'master' | 'sub_brand' | 'endorsed' | 'independent' | undefined,
              parent_brand: args?.parent_brand as string | undefined,
              brand_manifest: args?.brand_manifest as Record<string, unknown> | undefined,
              has_brand_manifest: args?.brand_manifest ? true : undefined,
              edit_summary: editSummary,
              editor_user_id: authContext.sub,
              editor_email: authContext.email,
              editor_name: authContext.email,
            });

            const oldRevision = revision_number > 1
              ? await brandDb.getBrandRevision(domain, revision_number - 1)
              : null;

            // Fire-and-forget: notify then review (review runs even if notification fails)
            notifyRegistryEdit({
              entity_type: 'brand',
              domain,
              editor_email: authContext.email,
              edit_summary: editSummary,
              revision_number,
            }).catch((err) => { logger.error({ err }, 'MCP: Brand edit notification failed'); return null; })
              .then((slack_thread_ts) => {
                reviewRegistryEdit({
                  entity_type: 'brand',
                  domain,
                  editor_user_id: authContext.sub,
                  editor_email: authContext.email,
                  edit_summary: editSummary,
                  old_snapshot: oldRevision?.snapshot || {},
                  new_snapshot: brand as unknown as Record<string, unknown>,
                  revision_number,
                  slack_thread_ts: slack_thread_ts || undefined,
                }).catch((err) => logger.error({ err }, 'MCP: Brand edit review failed'));
              });

            return {
              content: [{
                type: "resource",
                resource: {
                  uri: `brand://${encodeURIComponent(domain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    success: true,
                    action: "edited",
                    domain: brand.domain,
                    brand_name: brand.brand_name,
                    revision_number,
                  }, null, 2),
                },
              }],
            };
          }

          // Create new community brand with pending review
          const brand = await brandDb.createDiscoveredBrand({
            domain,
            brand_name: brandName,
            house_domain: args?.house_domain as string | undefined,
            keller_type: args?.keller_type as 'master' | 'sub_brand' | 'endorsed' | 'independent' | undefined,
            parent_brand: args?.parent_brand as string | undefined,
            brand_manifest: args?.brand_manifest as Record<string, unknown> | undefined,
            has_brand_manifest: !!args?.brand_manifest,
            source_type: 'community',
          }, {
            user_id: authContext.sub,
            email: authContext.email,
            name: authContext.email,
          });

          // Fire-and-forget: notify then review (review runs even if notification fails)
          notifyRegistryCreate({
            entity_type: 'brand',
            domain: brand.domain,
            editor_email: authContext.email,
          }).catch((err) => { logger.error({ err }, 'MCP: New brand notification failed'); return null; })
            .then((slack_thread_ts) => {
              reviewNewRecord({
                entity_type: 'brand',
                domain: brand.domain,
                editor_user_id: authContext.sub,
                editor_email: authContext.email,
                snapshot: brand as unknown as Record<string, unknown>,
                slack_thread_ts: slack_thread_ts || undefined,
              }).catch((err) => logger.error({ err }, 'MCP: New brand review failed'));
            });

          return {
            content: [{
              type: "resource",
              resource: {
                uri: `brand://${encodeURIComponent(domain)}`,
                mimeType: "application/json",
                text: JSON.stringify({
                  success: true,
                  action: "created",
                  domain: brand.domain,
                  brand_name: brand.brand_name,
                  review_status: "pending",
                }, null, 2),
              },
            }],
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return {
            content: [{ type: "text", text: JSON.stringify({ error: message }) }],
            isError: true,
          };
        }
      }

      case "save_property": {
        if (!authContext || authContext.sub === 'anonymous') {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "Authentication required to save properties" }) }],
            isError: true,
          };
        }

        const publisherDomain = sanitizeDomain(args?.publisher_domain as string);
        if (!publisherDomain) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "publisher_domain is required or invalid format" }) }],
            isError: true,
          };
        }

        const propBanCheck = await bansDb.isUserBannedFromRegistry('registry_property', authContext.sub, publisherDomain);
        if (propBanCheck.banned) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "You are banned from editing properties", reason: propBanCheck.ban?.reason }) }],
            isError: true,
          };
        }

        const authorizedAgents = args?.authorized_agents as Array<{ url: string; authorized_for?: string }> || [];
        const propertyItems = args?.properties as Array<{ type: string; name: string }> || [];
        const contact = args?.contact as { name?: string; email?: string } | undefined;

        // Validate agent URLs
        for (const agent of authorizedAgents) {
          try {
            const parsed = new URL(agent.url);
            if (parsed.protocol !== 'https:') {
              return {
                content: [{ type: "text", text: JSON.stringify({ error: `Agent URL must use HTTPS: ${agent.url}` }) }],
                isError: true,
              };
            }
          } catch {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Invalid agent URL: ${agent.url}` }) }],
              isError: true,
            };
          }
        }

        const adagentsJson: Record<string, unknown> = {
          $schema: 'https://adcontextprotocol.org/schemas/v1/adagents.json',
          authorized_agents: authorizedAgents,
          properties: propertyItems,
        };
        if (contact) {
          adagentsJson.contact = contact;
        }

        try {
          // Check for authoritative lock — reject if domain has a live adagents.json
          const discoveredProps = await propertyDb.getDiscoveredPropertiesByDomain(publisherDomain);
          if (discoveredProps.length > 0) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "Cannot edit authoritative property (managed via adagents.json)" }) }],
              isError: true,
            };
          }

          const existing = await propertyDb.getHostedPropertyByDomain(publisherDomain);

          if (existing) {
            const editSummary = (args?.edit_summary as string) || 'MCP community edit';
            const { property, revision_number } = await propertyDb.editCommunityProperty(publisherDomain, {
              adagents_json: adagentsJson,
              edit_summary: editSummary,
              editor_user_id: authContext.sub,
              editor_email: authContext.email,
              editor_name: authContext.email,
            });

            const oldPropRevision = revision_number > 1
              ? await propertyDb.getPropertyRevision(publisherDomain, revision_number - 1)
              : null;

            // Fire-and-forget: notify then review (review runs even if notification fails)
            notifyRegistryEdit({
              entity_type: 'property',
              domain: publisherDomain,
              editor_email: authContext.email,
              edit_summary: editSummary,
              revision_number,
            }).catch((err) => { logger.error({ err }, 'MCP: Property edit notification failed'); return null; })
              .then((slack_thread_ts) => {
                reviewRegistryEdit({
                  entity_type: 'property',
                  domain: publisherDomain,
                  editor_user_id: authContext.sub,
                  editor_email: authContext.email,
                  edit_summary: editSummary,
                  old_snapshot: oldPropRevision?.snapshot || {},
                  new_snapshot: property as unknown as Record<string, unknown>,
                  revision_number,
                  slack_thread_ts: slack_thread_ts || undefined,
                }).catch((err) => logger.error({ err }, 'MCP: Property edit review failed'));
              });

            return {
              content: [{
                type: "resource",
                resource: {
                  uri: `property://${encodeURIComponent(publisherDomain)}`,
                  mimeType: "application/json",
                  text: JSON.stringify({
                    success: true,
                    action: "edited",
                    publisher_domain: property.publisher_domain,
                    revision_number,
                  }, null, 2),
                },
              }],
            };
          }

          // Create new community property with pending review
          const property = await propertyDb.createCommunityProperty({
            publisher_domain: publisherDomain,
            adagents_json: adagentsJson,
            source_type: 'community',
          }, {
            user_id: authContext.sub,
            email: authContext.email,
            name: authContext.email,
          });

          // Fire-and-forget: notify then review (review runs even if notification fails)
          notifyRegistryCreate({
            entity_type: 'property',
            domain: property.publisher_domain,
            editor_email: authContext.email,
          }).catch((err) => { logger.error({ err }, 'MCP: New property notification failed'); return null; })
            .then((slack_thread_ts) => {
              reviewNewRecord({
                entity_type: 'property',
                domain: property.publisher_domain,
                editor_user_id: authContext.sub,
                editor_email: authContext.email,
                snapshot: property as unknown as Record<string, unknown>,
                slack_thread_ts: slack_thread_ts || undefined,
              }).catch((err) => logger.error({ err }, 'MCP: New property review failed'));
            });

          return {
            content: [{
              type: "resource",
              resource: {
                uri: `property://${encodeURIComponent(publisherDomain)}`,
                mimeType: "application/json",
                text: JSON.stringify({
                  success: true,
                  action: "created",
                  publisher_domain: property.publisher_domain,
                  review_status: "pending",
                }, null, 2),
              },
            }],
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return {
            content: [{ type: "text", text: JSON.stringify({ error: message }) }],
            isError: true,
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

    // Handle properties resource
    if (uri === "properties://registry") {
      const properties = await propertyDb.getAllPropertiesForRegistry({ limit: 500 });
      const result = properties.map(p => ({
        domain: p.domain,
        source: p.source,
        property_count: p.property_count,
        agent_count: p.agent_count,
        verified: p.verified,
      }));

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Handle brands resource
    if (uri === "brands://registry") {
      const brands = await brandDb.getAllBrandsForRegistry({ limit: 500 });
      const result = brands.map(b => ({
        domain: b.domain,
        brand_name: b.brand_name,
        source: b.source,
        has_manifest: b.has_manifest,
        house_domain: b.house_domain,
        keller_type: b.keller_type,
      }));

      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
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
