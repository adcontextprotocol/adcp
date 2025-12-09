import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { WorkOS } from "@workos-inc/node";
import { Registry } from "./registry.js";
import { AgentValidator } from "./validator.js";
import { HealthChecker } from "./health.js";
import { CrawlerService } from "./crawler.js";
import { createLogger } from "./logger.js";
import { CapabilityDiscovery } from "./capabilities.js";
import { PublisherTracker } from "./publishers.js";
import { PropertiesService } from "./properties.js";
import { AdAgentsManager } from "./adagents-manager.js";
import { closeDatabase, getPool } from "./db/client.js";
import { getPropertyIndex, CreativeAgentClient, SingleAgentClient } from "@adcp/client";
import type { AgentType, AgentWithStats, Company } from "./types.js";
import type { Server } from "http";
import { stripe, STRIPE_WEBHOOK_SECRET, createStripeCustomer, createCustomerPortalSession, createCustomerSession, getSubscriptionInfo } from "./billing/stripe-client.js";
import Stripe from "stripe";
import { OrganizationDatabase } from "./db/organization-db.js";
import { MemberDatabase } from "./db/member-db.js";
import { RegistryDatabase } from "./db/registry-db.js";
import { requireAuth, requireAdmin, optionalAuth } from "./middleware/auth.js";
import { invitationRateLimiter, authRateLimiter, orgCreationRateLimiter } from "./middleware/rate-limit.js";
import { validateOrganizationName, validateEmail } from "./middleware/validation.js";
import jwt from "jsonwebtoken";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('http-server');

// Check if authentication is configured
const AUTH_ENABLED = !!(
  process.env.WORKOS_API_KEY &&
  process.env.WORKOS_CLIENT_ID &&
  process.env.WORKOS_COOKIE_PASSWORD &&
  process.env.WORKOS_COOKIE_PASSWORD.length >= 32
);

// Initialize WorkOS client only if authentication is enabled
const workos = AUTH_ENABLED ? new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
}) : null;
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || '';
const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const WORKOS_COOKIE_PASSWORD = process.env.WORKOS_COOKIE_PASSWORD || '';

export class HTTPServer {
  private app: express.Application;
  private server: Server | null = null;
  private registry: Registry;
  private validator: AgentValidator;
  private healthChecker: HealthChecker;
  private crawler: CrawlerService;
  private capabilityDiscovery: CapabilityDiscovery;
  private publisherTracker: PublisherTracker;
  private propertiesService: PropertiesService;
  private adagentsManager: AdAgentsManager;

  constructor() {
    this.app = express();
    this.registry = new Registry();
    this.validator = new AgentValidator();
    this.adagentsManager = new AdAgentsManager();
    this.healthChecker = new HealthChecker();
    this.crawler = new CrawlerService();
    this.capabilityDiscovery = new CapabilityDiscovery();
    this.publisherTracker = new PublisherTracker();
    this.propertiesService = new PropertiesService();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Use JSON parser for all routes EXCEPT Stripe webhooks (which need raw body)
    this.app.use((req, res, next) => {
      if (req.path === '/api/webhooks/stripe') {
        next();
      } else {
        express.json()(req, res, next);
      }
    });
    this.app.use(cookieParser());

    // Serve JSON schemas at /schemas/* from dist/schemas (built schemas)
    // In dev: __dirname is server/src, dist is at ../../dist
    // In prod: __dirname is dist, schemas are at ./schemas
    const distPath = process.env.NODE_ENV === 'production'
      ? __dirname
      : path.join(__dirname, "../../dist");
    this.app.use('/schemas', express.static(path.join(distPath, 'schemas')));

    // Serve other static files (robots.txt, images, etc.)
    const staticPath = process.env.NODE_ENV === 'production'
      ? path.join(__dirname, "../static")
      : path.join(__dirname, "../../static");
    this.app.use(express.static(staticPath));

    // Serve homepage and public assets at root
    // In prod: __dirname is dist, public is at ../server/public
    // In dev: __dirname is server/src, public is at ../public
    const publicPath = process.env.NODE_ENV === 'production'
      ? path.join(__dirname, "../server/public")
      : path.join(__dirname, "../public");
    this.app.use(express.static(publicPath));
  }


  private setupRoutes(): void {
    // Authentication routes (only if configured)
    if (AUTH_ENABLED) {
      this.setupAuthRoutes();
      logger.info('Authentication enabled');
    } else {
      logger.warn('Authentication disabled - WORKOS environment variables not configured');
    }

    // UI page routes (serve with environment variables injected)
    this.app.get('/onboarding', (req, res) => res.redirect('/onboarding.html'));
    this.app.get('/team', (req, res) => res.redirect('/team.html' + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '')));
    this.app.get('/dashboard', async (req, res) => {
      try {
        const fs = await import('fs/promises');
        const dashboardPath = process.env.NODE_ENV === 'production'
          ? path.join(__dirname, '../server/public/dashboard.html')
          : path.join(__dirname, '../public/dashboard.html');
        let html = await fs.readFile(dashboardPath, 'utf-8');

        // Replace template variables with environment values
        html = html
          .replace('{{STRIPE_PUBLISHABLE_KEY}}', process.env.STRIPE_PUBLISHABLE_KEY || '')
          .replace('{{STRIPE_PRICING_TABLE_ID}}', process.env.STRIPE_PRICING_TABLE_ID || '');

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        logger.error({ err: error }, 'Error serving dashboard');
        res.status(500).send('Error loading dashboard');
      }
    });

    // API endpoints

    // Public config endpoint - returns feature flags and auth state for nav
    this.app.get("/api/config", optionalAuth, (req, res) => {
      // User is populated by optionalAuth middleware if authenticated
      let isAdmin = false;
      if (req.user) {
        const adminEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
        isAdmin = adminEmails.includes(req.user.email.toLowerCase());
      }

      const user = req.user ? {
        email: req.user.email,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        isAdmin,
      } : null;

      res.json({
        membershipEnabled: process.env.MEMBERSHIP_ENABLED !== 'false',
        authEnabled: AUTH_ENABLED,
        user,
      });
    });

    this.app.get("/api/agents", async (req, res) => {
      const type = req.query.type as AgentType | undefined;
      const withHealth = req.query.health === "true";
      const withCapabilities = req.query.capabilities === "true";
      const withProperties = req.query.properties === "true";
      const agents = await this.registry.listAgents(type);

      if (!withHealth && !withCapabilities && !withProperties) {
        return res.json(agents);
      }

      // Enrich with health, stats, capabilities, and/or properties
      const enriched = await Promise.all(
        agents.map(async (agent): Promise<AgentWithStats> => {
          const promises = [];

          if (withHealth) {
            promises.push(
              this.healthChecker.checkHealth(agent),
              this.healthChecker.getStats(agent)
            );
          }

          if (withCapabilities) {
            promises.push(
              this.capabilityDiscovery.discoverCapabilities(agent)
            );
          }

          if (withProperties && agent.type === "sales") {
            promises.push(
              this.propertiesService.getPropertiesForAgent(agent)
            );
          }

          const results = await Promise.all(promises);

          const enrichedAgent: AgentWithStats = { ...agent };
          let resultIndex = 0;

          if (withHealth) {
            enrichedAgent.health = results[resultIndex++] as any;
            enrichedAgent.stats = results[resultIndex++] as any;
          }

          if (withCapabilities) {
            const capProfile = results[resultIndex++] as any;
            enrichedAgent.capabilities = {
              tools_count: capProfile.discovered_tools.length,
              tools: capProfile.discovered_tools,
              standard_operations: capProfile.standard_operations,
              creative_capabilities: capProfile.creative_capabilities,
              signals_capabilities: capProfile.signals_capabilities,
            };
          }

          if (withProperties && agent.type === "sales") {
            const propsProfile = results[resultIndex++] as any;
            enrichedAgent.properties = propsProfile.properties;
            enrichedAgent.propertiesError = propsProfile.error;
          }

          return enrichedAgent;
        })
      );

      res.json(enriched);
    });

    this.app.get("/api/agents/:type/:name", async (req, res) => {
      const agentId = `${req.params.type}/${req.params.name}`;
      const agent = await this.registry.getAgent(agentId);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const withHealth = req.query.health === "true";
      if (!withHealth) {
        return res.json(agent);
      }

      const [health, stats] = await Promise.all([
        this.healthChecker.checkHealth(agent),
        this.healthChecker.getStats(agent),
      ]);

      res.json({ ...agent, health, stats });
    });

    this.app.post("/api/validate", async (req, res) => {
      const { domain, agent_url } = req.body;

      if (!domain || !agent_url) {
        return res.status(400).json({
          error: "Missing required fields: domain and agent_url",
        });
      }

      try {
        const result = await this.validator.validate(domain, agent_url);
        res.json(result);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Validation failed",
        });
      }
    });

    // Property lookup endpoints
    this.app.get("/api/lookup/property", (req, res) => {
      const { type, value } = req.query;

      if (!type || !value) {
        return res.status(400).json({
          error: "Missing required query params: type and value",
        });
      }

      const index = getPropertyIndex();
      const agents = index.findAgentsForProperty(
        type as any, // PropertyIdentifierType
        value as string
      );

      res.json({
        type,
        value,
        agents,
        count: agents.length,
      });
    });

    this.app.get("/api/agents/:id/properties", async (req, res) => {
      const agentId = req.params.id;
      const agent = await this.registry.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      const index = getPropertyIndex();
      const auth = index.getAgentAuthorizations(agent.url);

      if (!auth) {
        return res.json({
          agent_id: agentId,
          agent_url: agent.url,
          properties: [],
          publisher_domains: [],
          count: 0,
        });
      }

      res.json({
        agent_id: agentId,
        agent_url: auth.agent_url,
        properties: auth.properties,
        publisher_domains: auth.publisher_domains,
        count: auth.properties.length,
      });
    });

    // Crawler endpoints
    this.app.post("/api/crawler/run", async (req, res) => {
      const agents = await this.registry.listAgents("sales");
      const result = await this.crawler.crawlAllAgents(agents);
      res.json(result);
    });

    this.app.get("/api/crawler/status", (req, res) => {
      res.json(this.crawler.getStatus());
    });

    this.app.get("/api/stats", async (req, res) => {
      const agents = await this.registry.listAgents();
      const byType = {
        creative: agents.filter((a) => a.type === "creative").length,
        signals: agents.filter((a) => a.type === "signals").length,
        sales: agents.filter((a) => a.type === "sales").length,
      };

      res.json({
        total: agents.length,
        by_type: byType,
        cache: this.validator.getCacheStats(),
      });
    });

    // Capability endpoints
    this.app.get("/api/agents/:id/capabilities", async (req, res) => {
      const agentId = req.params.id;
      const agent = await this.registry.getAgent(agentId);

      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }

      try {
        const profile = await this.capabilityDiscovery.discoverCapabilities(agent);
        res.json(profile);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Capability discovery failed",
        });
      }
    });

    this.app.post("/api/capabilities/discover-all", async (req, res) => {
      const agents = await this.registry.listAgents();
      try {
        const profiles = await this.capabilityDiscovery.discoverAll(agents);
        res.json({
          total: profiles.size,
          profiles: Array.from(profiles.values()),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Bulk discovery failed",
        });
      }
    });

    // Publisher endpoints
    this.app.get("/api/publishers", async (req, res) => {
      const agents = await this.registry.listAgents("sales");
      try {
        const statuses = await this.publisherTracker.trackPublishers(agents);
        res.json({
          total: statuses.size,
          publishers: Array.from(statuses.values()),
          stats: this.publisherTracker.getDeploymentStats(),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Publisher tracking failed",
        });
      }
    });

    this.app.get("/api/publishers/:domain", async (req, res) => {
      const domain = req.params.domain;
      const agents = await this.registry.listAgents("sales");

      // Find agents claiming this domain
      const expectedAgents = agents
        .filter((a) => {
          try {
            const url = new URL(a.url);
            return url.hostname === domain;
          } catch {
            return false;
          }
        })
        .map((a) => a.url);

      try {
        const status = await this.publisherTracker.checkPublisher(domain, expectedAgents);
        res.json(status);
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Publisher check failed",
        });
      }
    });

    this.app.get("/api/publishers/:domain/validation", async (req, res) => {
      const domain = req.params.domain;
      const agents = await this.registry.listAgents("sales");

      const expectedAgents = agents
        .filter((a) => {
          try {
            const url = new URL(a.url);
            return url.hostname === domain;
          } catch {
            return false;
          }
        })
        .map((a) => a.url);

      try {
        const status = await this.publisherTracker.checkPublisher(domain, expectedAgents);
        res.json({
          domain: status.domain,
          deployment_status: status.deployment_status,
          issues: status.issues,
          coverage_percentage: status.coverage_percentage,
          recommended_actions: status.issues.map((issue) => ({
            issue: issue.message,
            fix: issue.fix,
            severity: issue.severity,
          })),
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "Validation failed",
        });
      }
    });





    // Simple REST API endpoint - for web apps and quick integrations
    this.app.get("/agents", async (req, res) => {
      const type = req.query.type as AgentType | undefined;
      const agents = await this.registry.listAgents(type);

      res.json({
        agents,
        count: agents.length,
        by_type: {
          creative: agents.filter(a => a.type === "creative").length,
          signals: agents.filter(a => a.type === "signals").length,
          sales: agents.filter(a => a.type === "sales").length,
        }
      });
    });

    // MCP endpoint - for AI agents to discover other agents
    // This makes the registry itself an MCP server that can be queried by other agents
    this.app.options("/mcp", (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.status(204).end();
    });

    this.app.post("/mcp", async (req, res) => {
      // Add CORS headers for browser-based MCP clients
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      const { method, params, id } = req.body;

      try {
        // Handle MCP tools/list request
        if (method === "tools/list") {
          res.json({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "list_agents",
                  description: "List all registered AdCP agents, optionally filtered by type",
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
                  description: "Get details for a specific agent by ID",
                  inputSchema: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        description: "Agent identifier (e.g., 'creative/4dvertible-creative-agent')",
                      },
                    },
                    required: ["id"],
                  },
                },
                {
                  name: "find_agents_for_property",
                  description: "Find which agents can sell a specific property",
                  inputSchema: {
                    type: "object",
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
                {
                  name: "get_properties_for_agent",
                  description: "Get all properties that a specific agent is authorized to sell by checking their publisher's adagents.json",
                  inputSchema: {
                    type: "object",
                    properties: {
                      agent_url: {
                        type: "string",
                        description: "Agent URL (e.g., 'https://sales.weather.com')",
                      },
                    },
                    required: ["agent_url"],
                  },
                },
                {
                  name: "get_products_for_agent",
                  description: "Query a sales agent for available products (proxy tool that calls get_products on the agent)",
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
                  description: "Query an agent for supported creative formats (proxy tool that calls list_creative_formats on the agent)",
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
              ],
            },
          });
          return;
        }

        // Handle MCP tools/call request
        if (method === "tools/call") {
          const { name, arguments: args } = params;

          if (name === "list_agents") {
            const type = args?.type as AgentType | undefined;
            const agents = await this.registry.listAgents(type);
            res.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `https://registry.adcontextprotocol.org/agents/${type || "all"}`,
                      mimeType: "application/json",
                      text: JSON.stringify({
                        agents,
                        count: agents.length,
                        by_type: {
                          creative: agents.filter(a => a.type === "creative").length,
                          signals: agents.filter(a => a.type === "signals").length,
                          sales: agents.filter(a => a.type === "sales").length,
                        }
                      }, null, 2),
                    },
                  },
                ],
              },
            });
            return;
          }

          if (name === "get_agent") {
            const agentId = args?.id as string;
            const agent = await this.registry.getAgent(agentId);
            if (!agent) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32602,
                  message: "Agent not found",
                },
              });
              return;
            }
            res.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `https://registry.adcontextprotocol.org/agents/${agentId}`,
                      mimeType: "application/json",
                      text: JSON.stringify(agent, null, 2),
                    },
                  },
                ],
              },
            });
            return;
          }

          if (name === "find_agents_for_property") {
            const propertyType = args?.property_type as string;
            const propertyValue = args?.property_value as string;
            const index = getPropertyIndex();
            const agents = index.findAgentsForProperty(propertyType as any, propertyValue);
            res.json({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "resource",
                    resource: {
                      uri: `https://registry.adcontextprotocol.org/properties/${propertyType}/${propertyValue}`,
                      mimeType: "application/json",
                      text: JSON.stringify(
                        { property_type: propertyType, property_value: propertyValue, agents, count: agents.length },
                        null,
                        2
                      ),
                    },
                  },
                ],
              },
            });
            return;
          }

          if (name === "get_properties_for_agent") {
            const agentUrl = args?.agent_url as string;
            if (!agentUrl) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32602,
                  message: "Missing agent_url parameter",
                },
              });
              return;
            }

            try {
              // Find the agent in our registry
              const agents = Array.from((await this.registry.getAllAgents()).values());
              const agent = agents.find((a) => a.url === agentUrl);

              if (!agent) {
                res.json({
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32602,
                    message: `Agent not found: ${agentUrl}`,
                  },
                });
                return;
              }

              // Use cached properties service
              const profile = await this.propertiesService.getPropertiesForAgent(agent);

              const url = new URL(agentUrl);
              const domain = url.hostname;

              res.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: `https://registry.adcontextprotocol.org/agent-properties/${domain}`,
                        mimeType: "application/json",
                        text: JSON.stringify(
                          {
                            agent_url: agentUrl,
                            domain,
                            protocol: profile.protocol,
                            properties: profile.properties,
                            count: profile.properties.length,
                            error: profile.error,
                            status: profile.error ? "error" : profile.properties.length > 0 ? "success" : "empty",
                            last_fetched: profile.last_fetched,
                          },
                          null,
                          2
                        ),
                      },
                    },
                  ],
                },
              });
              return;
            } catch (error: any) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: `Failed to get properties: ${error.message}`,
                },
              });
              return;
            }
          }

          if (name === "get_products_for_agent") {
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

              res.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: `adcp://products/${agentUrl}`,
                        mimeType: "application/json",
                        text: JSON.stringify(result.success ? result.data : { error: result.error || "Failed to get products" }),
                      },
                    },
                  ],
                },
              });
              return;
            } catch (error: any) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: `Failed to get products: ${error.message}`,
                },
              });
              return;
            }
          }

          if (name === "list_creative_formats_for_agent") {
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

              res.json({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: `adcp://formats/${agentUrl}`,
                        mimeType: "application/json",
                        text: JSON.stringify(result.success ? result.data : { error: result.error || "Failed to list formats" }),
                      },
                    },
                  ],
                },
              });
              return;
            } catch (error: any) {
              res.json({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32603,
                  message: `Failed to list formats: ${error.message}`,
                },
              });
              return;
            }
          }

          res.json({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: "Unknown tool",
            },
          });
          return;
        }

        // Unknown method
        res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        });
      } catch (error: any) {
        res.json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: error?.message || "Internal error",
          },
        });
      }
    });

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        registry: {
          mode: "database",
          using_database: true,
        },
      });
    });

    // Homepage route - serve index.html at root
    this.app.get("/", (req, res) => {
      const homepagePath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, "../server/public/index.html")
        : path.join(__dirname, "../public/index.html");
      res.sendFile(homepagePath);
    });

    // Registry UI route - serve registry.html at /registry
    this.app.get("/registry", (req, res) => {
      const registryPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, "../server/public/registry.html")
        : path.join(__dirname, "../public/registry.html");
      res.sendFile(registryPath);
    });

    // AdAgents Manager UI route - serve adagents.html at /adagents
    this.app.get("/adagents", (req, res) => {
      const adagentsPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, "../server/public/adagents.html")
        : path.join(__dirname, "../public/adagents.html");
      res.sendFile(adagentsPath);
    });

    // Member Profile UI route - serve member-profile.html at /member-profile
    this.app.get("/member-profile", (req, res) => {
      const memberProfilePath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, "../server/public/member-profile.html")
        : path.join(__dirname, "../public/member-profile.html");
      res.sendFile(memberProfilePath);
    });

    // Member Directory UI route - serve members.html at /members
    this.app.get("/members", (req, res) => {
      const membersPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, "../server/public/members.html")
        : path.join(__dirname, "../public/members.html");
      res.sendFile(membersPath);
    });

    // Individual member profile page
    this.app.get("/members/:slug", (req, res) => {
      const membersPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, "../server/public/members.html")
        : path.join(__dirname, "../public/members.html");
      res.sendFile(membersPath);
    });

    // AdAgents API Routes
    // Validate domain's adagents.json
    this.app.post("/api/adagents/validate", async (req, res) => {
      try {
        const { domain } = req.body;

        if (!domain || domain.trim().length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Domain is required',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info({ domain }, 'Validating adagents.json for domain');

        // Validate the domain's adagents.json
        const validation = await this.adagentsManager.validateDomain(domain);

        let agentCards = undefined;

        // If adagents.json is found and has agents, validate their cards
        if (validation.valid && validation.raw_data?.authorized_agents?.length > 0) {
          logger.info({ agentCount: validation.raw_data.authorized_agents.length }, 'Validating agent cards');
          agentCards = await this.adagentsManager.validateAgentCards(validation.raw_data.authorized_agents);
        }

        return res.json({
          success: true,
          data: {
            domain: validation.domain,
            found: validation.status_code === 200,
            validation,
            agent_cards: agentCards,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to validate domain:');
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Create adagents.json file
    this.app.post("/api/adagents/create", async (req, res) => {
      try {
        const {
          authorized_agents,
          include_schema = true,
          include_timestamp = true,
          properties,
        } = req.body;

        if (!authorized_agents || !Array.isArray(authorized_agents)) {
          return res.status(400).json({
            success: false,
            error: 'authorized_agents array is required',
            timestamp: new Date().toISOString(),
          });
        }

        if (authorized_agents.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'At least one authorized agent is required',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info({
          agentCount: authorized_agents.length,
          propertyCount: properties?.length || 0,
        }, 'Creating adagents.json');

        // Validate the proposed structure
        const validation = this.adagentsManager.validateProposed(authorized_agents);

        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            error: `Validation failed: ${validation.errors.map((e: any) => e.message).join(', ')}`,
            timestamp: new Date().toISOString(),
          });
        }

        // Create the adagents.json content
        const adagentsJson = this.adagentsManager.createAdAgentsJson(
          authorized_agents,
          include_schema,
          include_timestamp,
          properties
        );

        return res.json({
          success: true,
          data: {
            success: true,
            adagents_json: adagentsJson,
            validation,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to create adagents.json:');
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Validate agent cards only (utility endpoint)
    this.app.post("/api/adagents/validate-cards", async (req, res) => {
      try {
        const { agent_urls } = req.body;

        if (!agent_urls || !Array.isArray(agent_urls) || agent_urls.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'agent_urls array with at least one URL is required',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info({ cardCount: agent_urls.length }, 'Validating agent cards');

        const agents = agent_urls.map((url: string) => ({ url, authorized_for: 'validation' }));
        const agentCards = await this.adagentsManager.validateAgentCards(agents);

        return res.json({
          success: true,
          data: {
            agent_cards: agentCards,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to validate agent cards:');
        return res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    });

    // Stripe Webhooks (independent of WorkOS auth)
    // POST /api/webhooks/stripe - Handle Stripe webhooks
    this.app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        logger.warn('Stripe not configured for webhooks');
        return res.status(400).json({ error: 'Stripe not configured' });
      }

      const sig = req.headers['stripe-signature'];
      if (!sig) {
        return res.status(400).json({ error: 'Missing stripe-signature header' });
      }

      let event: Stripe.Event;

      try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        logger.error({ err }, 'Webhook signature verification failed');
        return res.status(400).json({ error: 'Webhook signature verification failed' });
      }

      logger.info({ eventType: event.type }, 'Stripe webhook event received');

      // Initialize database clients
      const orgDb = new OrganizationDatabase();
      const pool = getPool();

      try {
        switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            logger.info({
              customer: subscription.customer,
              status: subscription.status,
              eventType: event.type,
            }, 'Processing subscription event');

            // For subscription created, record agreement acceptance atomically
            if (event.type === 'customer.subscription.created') {
              const customerId = subscription.customer as string;
              const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

              if (org) {
                // Get agreement info from organization's pending fields
                // (set when user checked the agreement checkbox)
                let agreementVersion = org.pending_agreement_version || '1.0';
                let agreementAcceptedAt = org.pending_agreement_accepted_at || new Date();

                // If no pending agreement, use current version
                if (!org.pending_agreement_version) {
                  const currentAgreement = await orgDb.getCurrentAgreementByType('membership');
                  if (currentAgreement) {
                    agreementVersion = currentAgreement.version;
                  }
                }

                // Get customer info from Stripe to find user email
                const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
                const userEmail = customer.email || 'unknown@example.com';

                // Get WorkOS user ID from email
                // Note: In production, we'd need a more robust way to link Stripe customer to WorkOS user
                // For now, we'll use the email from the customer record
                try {
                  const users = await workos!.userManagement.listUsers({ email: userEmail });
                  const workosUser = users.data[0];

                  if (workosUser) {
                    // Record membership agreement acceptance
                    await orgDb.recordUserAgreementAcceptance({
                      workos_user_id: workosUser.id,
                      email: userEmail,
                      agreement_type: 'membership',
                      agreement_version: agreementVersion,
                      workos_organization_id: org.workos_organization_id,
                      // Note: IP and user-agent not available in webhook context
                    });

                    // Update organization record
                    await orgDb.updateOrganization(org.workos_organization_id, {
                      agreement_signed_at: agreementAcceptedAt,
                      agreement_version: agreementVersion,
                    });

                    // Store agreement metadata in Stripe subscription
                    await stripe.subscriptions.update(subscription.id, {
                      metadata: {
                        workos_organization_id: org.workos_organization_id,
                        membership_agreement_version: agreementVersion,
                        membership_agreement_accepted_at: agreementAcceptedAt.toISOString(),
                      }
                    });

                    logger.info({
                      orgId: org.workos_organization_id,
                      subscriptionId: subscription.id,
                      agreementVersion,
                      userEmail,
                    }, 'Subscription created - membership agreement recorded atomically');
                  } else {
                    logger.error({ userEmail }, 'Could not find WorkOS user for Stripe customer');
                  }
                } catch (userError) {
                  logger.error({ error: userError }, 'Failed to record agreement acceptance in webhook');
                }
              }
            }

            // Update database with subscription status and period end
            // This allows admin dashboard to display data without querying Stripe API
            try {
              const customerId = subscription.customer as string;
              const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

              if (org) {
                // Calculate period end from subscription or invoice
                let periodEnd: Date | null = null;

                if ((subscription as any).current_period_end) {
                  periodEnd = new Date((subscription as any).current_period_end * 1000);
                }

                await pool.query(
                  `UPDATE organizations
                   SET subscription_status = $1,
                       stripe_subscription_id = $2,
                       subscription_current_period_end = $3,
                       updated_at = NOW()
                   WHERE workos_organization_id = $4`,
                  [
                    subscription.status,
                    subscription.id,
                    periodEnd,
                    org.workos_organization_id
                  ]
                );

                logger.info({
                  orgId: org.workos_organization_id,
                  subscriptionId: subscription.id,
                  status: subscription.status,
                  periodEnd: periodEnd?.toISOString(),
                }, 'Subscription data synced to database');
              }
            } catch (syncError) {
              logger.error({ error: syncError }, 'Failed to sync subscription data to database');
              // Don't throw - let webhook succeed even if sync fails
            }
            break;
          }

          case 'invoice.payment_succeeded': {
            const invoice = event.data.object as Stripe.Invoice;
            logger.info({
              customer: invoice.customer,
              invoiceId: invoice.id,
              amount: invoice.amount_paid,
            }, 'Invoice payment succeeded');

            // Get organization from customer ID
            const customerId = invoice.customer as string;
            const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

            if (org && invoice.amount_paid > 0) {
              // Determine revenue type
              let revenueType = 'one_time';
              if ((invoice as any).subscription) {
                revenueType = invoice.billing_reason === 'subscription_create'
                  ? 'subscription_initial'
                  : 'subscription_recurring';
              }

              // Extract primary product details (first line item)
              let productId: string | null = null;
              let productName: string | null = null;
              let priceId: string | null = null;
              let billingInterval: string | null = null;

              if (invoice.lines?.data && invoice.lines.data.length > 0) {
                const primaryLine = invoice.lines.data[0] as any;
                productId = primaryLine.price?.product as string || null;
                priceId = primaryLine.price?.id || null;
                billingInterval = primaryLine.price?.recurring?.interval || null;

                // Fetch product name if we have product ID
                if (productId) {
                  try {
                    const product = await stripe.products.retrieve(productId);
                    productName = product.name;
                  } catch (err) {
                    logger.error({ err, productId }, 'Failed to retrieve product details');
                    // Fallback to line item description (useful for tests)
                    productName = primaryLine.description || null;
                  }
                }
              }

              // Record revenue event
              try {
                await pool.query(
                  `INSERT INTO revenue_events (
                    workos_organization_id,
                    stripe_invoice_id,
                    stripe_subscription_id,
                    stripe_payment_intent_id,
                    stripe_charge_id,
                    amount_paid,
                    currency,
                    revenue_type,
                    billing_reason,
                    product_id,
                    product_name,
                    price_id,
                    billing_interval,
                    paid_at,
                    period_start,
                    period_end,
                    metadata
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
                  [
                    org.workos_organization_id,
                    invoice.id,
                    (invoice as any).subscription || null,
                    (invoice as any).payment_intent || null,
                    (invoice as any).charge || null,
                    invoice.amount_paid, // in cents
                    invoice.currency,
                    revenueType,
                    invoice.billing_reason || null,
                    productId,
                    productName,
                    priceId,
                    billingInterval,
                    new Date(invoice.status_transitions.paid_at! * 1000),
                    invoice.period_start ? new Date(invoice.period_start * 1000) : null,
                    invoice.period_end ? new Date(invoice.period_end * 1000) : null,
                    JSON.stringify({
                      invoice_number: invoice.number,
                      hosted_invoice_url: invoice.hosted_invoice_url,
                      invoice_pdf: invoice.invoice_pdf,
                      metadata: invoice.metadata,
                    }),
                  ]
                );
              } catch (revenueError) {
                logger.error({
                  err: revenueError,
                  orgId: org.workos_organization_id,
                  invoiceId: invoice.id,
                }, 'Failed to insert revenue event');
                // Continue processing - don't fail the webhook
              }

              // Store subscription line items for subscriptions
              if (invoice.subscription && invoice.lines?.data) {
                const subscriptionId = invoice.subscription as string;

                for (const line of invoice.lines.data) {
                  if (line.type === 'subscription') {
                    const lineProductId = line.price?.product as string || null;
                    let lineProductName: string | null = null;

                    // Fetch product name
                    if (lineProductId) {
                      try {
                        const product = await stripe.products.retrieve(lineProductId);
                        lineProductName = product.name;
                      } catch (err) {
                        logger.error({ err, productId: lineProductId }, 'Failed to retrieve line product');
                        // Fallback to line item description (useful for tests)
                        lineProductName = line.description || null;
                      }
                    }

                    // Upsert line item (update if exists, insert if new)
                    await pool.query(
                      `INSERT INTO subscription_line_items (
                        workos_organization_id,
                        stripe_subscription_id,
                        stripe_subscription_item_id,
                        price_id,
                        product_id,
                        product_name,
                        quantity,
                        amount,
                        billing_interval,
                        usage_type,
                        metadata
                      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                      ON CONFLICT (stripe_subscription_item_id)
                      DO UPDATE SET
                        price_id = EXCLUDED.price_id,
                        product_id = EXCLUDED.product_id,
                        product_name = EXCLUDED.product_name,
                        quantity = EXCLUDED.quantity,
                        amount = EXCLUDED.amount,
                        billing_interval = EXCLUDED.billing_interval,
                        usage_type = EXCLUDED.usage_type,
                        metadata = EXCLUDED.metadata,
                        updated_at = NOW()`,
                      [
                        org.workos_organization_id,
                        subscriptionId,
                        line.subscription_item || null,
                        line.price?.id || null,
                        lineProductId,
                        lineProductName,
                        line.quantity || 1,
                        line.amount, // in cents
                        line.price?.recurring?.interval || null,
                        line.price?.recurring?.usage_type || 'licensed',
                        JSON.stringify(line.metadata || {}),
                      ]
                    );
                  }
                }
              }

              // Update organization subscription details cache
              if (invoice.subscription) {
                await pool.query(
                  `UPDATE organizations
                   SET subscription_product_id = $1,
                       subscription_product_name = $2,
                       subscription_price_id = $3,
                       subscription_amount = $4,
                       subscription_currency = $5,
                       subscription_interval = $6,
                       subscription_metadata = $7,
                       updated_at = NOW()
                   WHERE workos_organization_id = $8`,
                  [
                    productId,
                    productName,
                    priceId,
                    invoice.amount_paid,
                    invoice.currency,
                    billingInterval,
                    JSON.stringify(invoice.metadata || {}),
                    org.workos_organization_id,
                  ]
                );
              }

              logger.info({
                orgId: org.workos_organization_id,
                invoiceId: invoice.id,
                amount: invoice.amount_paid,
                revenueType,
                productName,
              }, 'Revenue event recorded');
            }
            break;
          }

          case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            logger.warn({
              customer: invoice.customer,
              invoiceId: invoice.id,
              attemptCount: invoice.attempt_count,
            }, 'Invoice payment failed');

            // Get organization from customer ID
            const customerId = invoice.customer as string;
            const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

            if (org) {
              // Record failed payment event
              try {
                await pool.query(
                  `INSERT INTO revenue_events (
                    workos_organization_id,
                    stripe_invoice_id,
                    stripe_subscription_id,
                    stripe_payment_intent_id,
                    amount_paid,
                    currency,
                    revenue_type,
                    billing_reason,
                    paid_at,
                    metadata
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                  [
                    org.workos_organization_id,
                    invoice.id,
                    invoice.subscription || null,
                    invoice.payment_intent || null,
                    0, // No payment received
                    invoice.currency,
                    'payment_failed',
                    invoice.billing_reason || null,
                    new Date(),
                    JSON.stringify({
                      attempt_count: invoice.attempt_count,
                      next_payment_attempt: invoice.next_payment_attempt,
                      last_finalization_error: invoice.last_finalization_error,
                      metadata: invoice.metadata,
                    }),
                  ]
                );

                logger.info({
                  orgId: org.workos_organization_id,
                  invoiceId: invoice.id,
                }, 'Failed payment event recorded');
              } catch (revenueError) {
                logger.error({
                  err: revenueError,
                  orgId: org.workos_organization_id,
                  invoiceId: invoice.id,
                }, 'Failed to insert failed payment event');
                // Continue processing - don't fail the webhook
              }
            }
            // Could send email notification here
            break;
          }

          case 'charge.refunded': {
            const charge = event.data.object as Stripe.Charge;
            logger.info({
              chargeId: charge.id,
              amountRefunded: charge.amount_refunded,
            }, 'Charge refunded');

            // Get organization from customer ID
            if (charge.customer) {
              const customerId = charge.customer as string;
              const org = await orgDb.getOrganizationByStripeCustomerId(customerId);

              if (org && charge.amount_refunded > 0) {
                // Record refund as negative revenue event
                try {
                  await pool.query(
                    `INSERT INTO revenue_events (
                      workos_organization_id,
                      stripe_charge_id,
                      stripe_payment_intent_id,
                      amount_paid,
                      currency,
                      revenue_type,
                      paid_at,
                      metadata
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                      org.workos_organization_id,
                      charge.id,
                      charge.payment_intent || null,
                      -charge.amount_refunded, // Negative amount for refund
                      charge.currency,
                      'refund',
                      new Date(),
                      JSON.stringify({
                        refund_reason: charge.refunds?.data[0]?.reason || null,
                        original_charge_amount: charge.amount,
                        refunded_amount: charge.amount_refunded,
                        metadata: charge.metadata,
                      }),
                    ]
                  );

                  logger.info({
                    orgId: org.workos_organization_id,
                    chargeId: charge.id,
                    refundAmount: charge.amount_refunded,
                  }, 'Refund event recorded');
                } catch (revenueError) {
                  logger.error({
                    err: revenueError,
                    orgId: org.workos_organization_id,
                    chargeId: charge.id,
                  }, 'Failed to insert refund event');
                  // Continue processing - don't fail the webhook
                }
              }
            }
            break;
          }

          default:
            logger.debug({ eventType: event.type }, 'Unhandled webhook event type');
        }

        res.json({ received: true });
      } catch (error) {
        logger.error({ err: error }, 'Error processing webhook');
        res.status(500).json({ error: 'Webhook processing failed' });
      }
    });


    // Admin stats endpoint - moved here so it works in tests
    // GET /api/admin/stats - Admin dashboard statistics
    this.app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();

        // Get member counts
        const memberStats = await pool.query(`
          SELECT
            COUNT(*) as total_members,
            COUNT(CASE WHEN subscription_amount IS NOT NULL AND subscription_current_period_end > NOW() AND subscription_canceled_at IS NULL THEN 1 END) as active_subscriptions,
            COUNT(CASE
              WHEN subscription_amount IS NOT NULL
                AND subscription_current_period_end IS NOT NULL
                AND subscription_current_period_end < NOW() + INTERVAL '30 days'
                AND subscription_canceled_at IS NULL
              THEN 1
            END) as expiring_this_month,
            COUNT(CASE WHEN subscription_interval = 'month' AND subscription_amount IS NOT NULL AND subscription_current_period_end > NOW() AND subscription_canceled_at IS NULL THEN 1 END) as monthly_subscriptions,
            COUNT(CASE WHEN subscription_interval = 'year' AND subscription_amount IS NOT NULL AND subscription_current_period_end > NOW() AND subscription_canceled_at IS NULL THEN 1 END) as annual_subscriptions
          FROM organizations
        `);

        // Get revenue metrics
        const revenueStats = await pool.query(`
          SELECT
            -- Total revenue (all time, including refunds as negative)
            COALESCE(SUM(CASE WHEN revenue_type != 'payment_failed' THEN amount_paid ELSE 0 END), 0) as total_revenue,

            -- Total refunds
            COALESCE(SUM(CASE WHEN revenue_type = 'refund' THEN ABS(amount_paid) ELSE 0 END), 0) as total_refunds,

            -- This month's revenue
            COALESCE(SUM(CASE
              WHEN revenue_type != 'refund'
                AND revenue_type != 'payment_failed'
                AND paid_at >= date_trunc('month', CURRENT_DATE)
              THEN amount_paid
              ELSE 0
            END), 0) as current_month_revenue,

            -- Last month's revenue
            COALESCE(SUM(CASE
              WHEN revenue_type != 'refund'
                AND revenue_type != 'payment_failed'
                AND paid_at >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
                AND paid_at < date_trunc('month', CURRENT_DATE)
              THEN amount_paid
              ELSE 0
            END), 0) as last_month_revenue,

            -- Subscription revenue (recurring only)
            COALESCE(SUM(CASE
              WHEN revenue_type = 'subscription_recurring'
              THEN amount_paid
              ELSE 0
            END), 0) as recurring_revenue,

            -- One-time revenue
            COALESCE(SUM(CASE
              WHEN revenue_type IN ('one_time', 'subscription_initial')
              THEN amount_paid
              ELSE 0
            END), 0) as one_time_revenue
          FROM revenue_events
        `);

        // Calculate MRR (Monthly Recurring Revenue) from active subscriptions
        const mrrStats = await pool.query(`
          SELECT
            COALESCE(SUM(CASE
              WHEN subscription_interval = 'month'
              THEN subscription_amount
              WHEN subscription_interval = 'year'
              THEN subscription_amount / 12.0
              ELSE 0
            END), 0) as mrr
          FROM organizations
          WHERE subscription_amount IS NOT NULL
            AND subscription_current_period_end > NOW()
            AND subscription_canceled_at IS NULL
        `);

        // Get revenue by product
        const productRevenue = await pool.query(`
          SELECT
            product_name,
            COUNT(*) as count,
            SUM(amount_paid) as revenue
          FROM revenue_events
          WHERE revenue_type != 'refund'
            AND revenue_type != 'payment_failed'
            AND product_name IS NOT NULL
          GROUP BY product_name
          ORDER BY revenue DESC
        `);

        const members = memberStats.rows[0];
        const revenue = revenueStats.rows[0];
        const mrr = mrrStats.rows[0];

        // Format currency values
        const formatCurrency = (cents: number) => {
          const dollars = (cents / 100).toFixed(2);
          return `$${dollars}`;
        };

        res.json({
          // Member stats
          total_members: parseInt(members.total_members) || 0,
          active_subscriptions: parseInt(members.active_subscriptions) || 0,
          expiring_this_month: parseInt(members.expiring_this_month) || 0,
          monthly_subscriptions: parseInt(members.monthly_subscriptions) || 0,
          annual_subscriptions: parseInt(members.annual_subscriptions) || 0,

          // Revenue stats
          total_revenue: formatCurrency(parseInt(revenue.total_revenue)),
          total_refunds: formatCurrency(parseInt(revenue.total_refunds)),
          current_month_revenue: formatCurrency(parseInt(revenue.current_month_revenue)),
          last_month_revenue: formatCurrency(parseInt(revenue.last_month_revenue)),
          recurring_revenue: formatCurrency(parseInt(revenue.recurring_revenue)),
          one_time_revenue: formatCurrency(parseInt(revenue.one_time_revenue)),

          // MRR and ARR
          mrr: formatCurrency(parseFloat(mrr.mrr)),
          arr: formatCurrency(parseFloat(mrr.mrr) * 12),

          // Revenue by product
          product_breakdown: productRevenue.rows.map((row: any) => ({
            product_name: row.product_name,
            count: String(parseInt(row.count)),
            revenue: formatCurrency(parseInt(row.revenue)),
          })),
        });
      } catch (error) {
        logger.error({ err: error }, 'Error fetching admin stats');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch admin statistics',
        });
      }
    });

    // Admin routes
    // GET /admin - Admin landing page
    this.app.get('/admin', requireAuth, requireAdmin, (req, res) => {
      const adminPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, '../server/public/admin.html')
        : path.join(__dirname, '../public/admin.html');
      res.sendFile(adminPath);
    });


    // Admin agreement management endpoints
    // GET /api/admin/agreements - List all agreements
    this.app.get('/api/admin/agreements', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();
        const result = await pool.query(
          'SELECT * FROM agreements ORDER BY agreement_type, effective_date DESC'
        );

        res.json(result.rows);
      } catch (error) {
        logger.error({ err: error }, 'Get all agreements error:');
        res.status(500).json({
          error: 'Failed to get agreements',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/admin/agreements - Create new agreement
    this.app.post('/api/admin/agreements', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { agreement_type, version, effective_date, text } = req.body;
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];

        if (!agreement_type || !version || !effective_date || !text) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'agreement_type, version, effective_date, and text are required'
          });
        }

        if (!validTypes.includes(agreement_type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, or membership'
          });
        }

        const pool = getPool();
        const result = await pool.query(
          `INSERT INTO agreements (agreement_type, version, effective_date, text)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [agreement_type, version, effective_date, text]
        );

        res.json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, 'Create agreement error:');
        res.status(500).json({
          error: 'Failed to create agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/admin/agreements/:id - Update agreement
    this.app.put('/api/admin/agreements/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const { agreement_type, version, effective_date, text } = req.body;
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];

        if (!agreement_type || !version || !effective_date || !text) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'agreement_type, version, effective_date, and text are required'
          });
        }

        if (!validTypes.includes(agreement_type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, or membership'
          });
        }

        const pool = getPool();
        const result = await pool.query(
          `UPDATE agreements
           SET agreement_type = $1, version = $2, effective_date = $3, text = $4
           WHERE id = $5
           RETURNING *`,
          [agreement_type, version, effective_date, text, id]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: 'Agreement not found',
            message: `No agreement found with id ${id}`
          });
        }

        res.json(result.rows[0]);
      } catch (error) {
        logger.error({ err: error }, 'Update agreement error:');
        res.status(500).json({
          error: 'Failed to update agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/admin/members - List all members with subscription info
    this.app.get('/api/admin/members', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();

        // Get all organizations from database
        const result = await pool.query(`
          SELECT
            workos_organization_id,
            name,
            stripe_customer_id,
            created_at,
            subscription_amount,
            subscription_interval,
            subscription_currency,
            subscription_canceled_at,
            subscription_current_period_end,
            agreement_signed_at,
            agreement_version
          FROM organizations
          ORDER BY created_at DESC
        `);

        // Enrich with WorkOS organization membership data
        const members = await Promise.all(
          result.rows.map(async row => {
            let ownerEmail = 'No owner';

            try {
              if (workos) {
                // Get organization memberships from WorkOS
                const memberships = await workos.userManagement.listOrganizationMemberships({
                  organizationId: row.workos_organization_id,
                });

                // Find the first member (in a real system, you'd look for admin role)
                // WorkOS doesn't have a built-in "owner" role, but organizations typically
                // have at least one admin who can be considered the primary contact
                if (memberships.data && memberships.data.length > 0) {
                  const firstMember = memberships.data[0];
                  ownerEmail = firstMember.user?.email || 'Unknown';
                }
              }
            } catch (error) {
              logger.warn({ err: error, orgId: row.workos_organization_id }, 'Failed to fetch organization memberships');
              // Continue with 'No owner' - don't fail the entire request
            }

            // Convert timestamp to Unix timestamp (seconds) for JavaScript Date compatibility
            const periodEndTimestamp = row.subscription_current_period_end
              ? Math.floor(new Date(row.subscription_current_period_end).getTime() / 1000)
              : null;

            // Infer subscription status from existing fields
            let subscriptionStatus = 'none';
            if (row.subscription_amount && row.subscription_current_period_end) {
              const periodEnd = new Date(row.subscription_current_period_end);
              const now = new Date();

              if (row.subscription_canceled_at) {
                subscriptionStatus = 'canceled';
              } else if (periodEnd > now) {
                subscriptionStatus = 'active';
              } else {
                subscriptionStatus = 'expired';
              }
            }

            return {
              company_id: row.workos_organization_id, // Keep company_id name for backwards compatibility
              company_name: row.name, // Keep company_name for backwards compatibility
              stripe_customer_id: row.stripe_customer_id,
              created_at: row.created_at,
              subscription_status: subscriptionStatus,
              subscription_amount: row.subscription_amount,
              subscription_interval: row.subscription_interval,
              subscription_currency: row.subscription_currency || 'usd',
              subscription_current_period_end: periodEndTimestamp,
              subscription_canceled_at: row.subscription_canceled_at,
              agreement_signed_at: row.agreement_signed_at,
              agreement_version: row.agreement_version,
              owner_email: ownerEmail,
            };
          })
        );

        res.json(members);
      } catch (error) {
        logger.error({ err: error }, 'Error fetching admin members');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch members list',
        });
      }
    });

    // POST /api/admin/members/:orgId/sync - Sync organization data from WorkOS and Stripe
    this.app.post('/api/admin/members/:orgId/sync', requireAuth, requireAdmin, async (req, res) => {
      const { orgId } = req.params;

      try {
        const pool = getPool();
        const syncResults: {
          success: boolean;
          workos?: { success: boolean; email?: string; error?: string };
          stripe?: { success: boolean; subscription?: any; error?: string };
          updated?: boolean;
        } = { success: false };

        // Get the organization from database
        const orgResult = await pool.query(
          'SELECT workos_organization_id, stripe_customer_id FROM organizations WHERE workos_organization_id = $1',
          [orgId]
        );

        if (orgResult.rows.length === 0) {
          return res.status(404).json({ error: 'Organization not found' });
        }

        const org = orgResult.rows[0];

        // Sync from WorkOS
        if (workos) {
          try {
            const memberships = await workos.userManagement.listOrganizationMemberships({
              organizationId: orgId,
            });

            if (memberships.data && memberships.data.length > 0) {
              const firstMember = memberships.data[0];
              const email = firstMember.user?.email;

              syncResults.workos = {
                success: true,
                email: email || undefined,
              };
            } else {
              syncResults.workos = {
                success: true,
                error: 'No members found in organization',
              };
            }
          } catch (error) {
            syncResults.workos = {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error fetching from WorkOS',
            };
          }
        } else {
          syncResults.workos = {
            success: false,
            error: 'WorkOS not initialized',
          };
        }

        // Sync from Stripe
        if (org.stripe_customer_id) {
          if (stripe) {
            try {
              // Get customer with subscriptions
              const customer = await stripe.customers.retrieve(org.stripe_customer_id, {
                expand: ['subscriptions'],
              });

              if (customer.deleted) {
                syncResults.stripe = {
                  success: true,
                  error: 'Customer has been deleted',
                };
              } else {
                const subscriptions = (customer as Stripe.Customer).subscriptions;

                if (subscriptions && subscriptions.data.length > 0) {
                  const subscription = subscriptions.data[0];
                  const priceData = subscription.items.data[0]?.price;

                  // Update organization with fresh subscription data
                  await pool.query(
                    `UPDATE organizations
                     SET subscription_amount = $1,
                         subscription_interval = $2,
                         subscription_currency = $3,
                         subscription_current_period_end = $4,
                         subscription_canceled_at = $5,
                         updated_at = NOW()
                     WHERE workos_organization_id = $6`,
                    [
                      priceData?.unit_amount || null,
                      priceData?.recurring?.interval || null,
                      priceData?.currency || 'usd',
                      subscription.current_period_end
                        ? new Date(subscription.current_period_end * 1000)
                        : null,
                      subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
                      orgId,
                    ]
                  );

                  syncResults.stripe = {
                    success: true,
                    subscription: {
                      status: subscription.status,
                      amount: priceData?.unit_amount,
                      interval: priceData?.recurring?.interval,
                      current_period_end: subscription.current_period_end,
                      canceled_at: subscription.canceled_at,
                    },
                  };
                  syncResults.updated = true;
                } else {
                  syncResults.stripe = {
                    success: true,
                    error: 'No active subscription found',
                  };
                }
              }
            } catch (error) {
              syncResults.stripe = {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error fetching from Stripe',
              };
            }
          } else {
            syncResults.stripe = {
              success: false,
              error: 'Stripe not initialized',
            };
          }
        } else {
          syncResults.stripe = {
            success: false,
            error: 'No Stripe customer ID',
          };
        }

        syncResults.success = (syncResults.workos?.success || false) && (syncResults.stripe?.success || false);

        res.json(syncResults);
      } catch (error) {
        logger.error({ err: error, orgId }, 'Error syncing organization data');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to sync organization data',
        });
      }
    });

    // PATCH /api/admin/members/:orgId/memberships/:membershipId - Update membership role (admin bootstrap)
    // Used to fix organizations that have no owner
    this.app.patch('/api/admin/members/:orgId/memberships/:membershipId', requireAuth, requireAdmin, async (req, res) => {
      const { orgId, membershipId } = req.params;
      const { role } = req.body;

      if (!role || !['owner', 'admin', 'member'].includes(role)) {
        return res.status(400).json({
          error: 'Invalid role',
          message: 'Role must be owner, admin, or member',
        });
      }

      try {
        // Verify membership belongs to this org
        const membership = await workos!.userManagement.getOrganizationMembership(membershipId);
        if (membership.organizationId !== orgId) {
          return res.status(400).json({
            error: 'Invalid membership',
            message: 'This membership does not belong to the specified organization',
          });
        }

        // Update the membership role
        const updatedMembership = await workos!.userManagement.updateOrganizationMembership(membershipId, {
          roleSlug: role,
        });

        logger.info({ orgId, membershipId, role, adminEmail: req.user!.email }, 'Admin updated membership role');

        res.json({
          success: true,
          membership: {
            id: updatedMembership.id,
            user_id: updatedMembership.userId,
            role: updatedMembership.role?.slug || 'member',
          },
        });
      } catch (error) {
        logger.error({ err: error, orgId, membershipId }, 'Admin update membership role error');
        res.status(500).json({
          error: 'Failed to update membership role',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/admin/agreements/record - Admin endpoint to record missing agreement acceptances
    // Used to fix organizations where agreement wasn't properly recorded during subscription
    this.app.post('/api/admin/agreements/record', requireAuth, requireAdmin, async (req, res) => {
      const { workos_user_id, email, agreement_type, agreement_version, workos_organization_id } = req.body;

      if (!workos_user_id || !email || !agreement_type) {
        return res.status(400).json({
          error: 'Missing required fields',
          message: 'workos_user_id, email, and agreement_type are required',
        });
      }

      const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];
      if (!validTypes.includes(agreement_type)) {
        return res.status(400).json({
          error: 'Invalid agreement type',
          message: 'Type must be: terms_of_service, privacy_policy, or membership',
        });
      }

      const orgDb = new OrganizationDatabase();

      try {
        // Get current agreement version if not provided
        let version = agreement_version;
        if (!version) {
          const currentAgreement = await orgDb.getCurrentAgreementByType(agreement_type);
          if (!currentAgreement) {
            return res.status(400).json({
              error: 'No agreement found',
              message: `No ${agreement_type} agreement exists in the system`,
            });
          }
          version = currentAgreement.version;
        }

        // Record the acceptance
        await orgDb.recordUserAgreementAcceptance({
          workos_user_id,
          email,
          agreement_type,
          agreement_version: version,
          workos_organization_id: workos_organization_id || null,
          ip_address: 'admin-recorded',
          user_agent: `Admin: ${req.user!.email}`,
        });

        logger.info({
          workos_user_id,
          email,
          agreement_type,
          agreement_version: version,
          recorded_by: req.user!.email,
        }, 'Admin recorded agreement acceptance');

        res.json({
          success: true,
          recorded: {
            workos_user_id,
            email,
            agreement_type,
            agreement_version: version,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Admin record agreement error');
        res.status(500).json({
          error: 'Failed to record agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/admin/members/:orgId/payments - Get payment history for organization
    this.app.get('/api/admin/members/:orgId/payments', requireAuth, requireAdmin, async (req, res) => {
      const { orgId } = req.params;

      try {
        const pool = getPool();

        // Get payment history from revenue_events table
        const result = await pool.query(
          `SELECT
            event_type,
            amount_cents,
            currency,
            event_timestamp,
            stripe_invoice_id,
            product_name
           FROM revenue_events
           WHERE workos_organization_id = $1
           ORDER BY event_timestamp DESC`,
          [orgId]
        );

        res.json(result.rows);
      } catch (error) {
        logger.error({ err: error, orgId }, 'Error fetching payment history');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch payment history',
        });
      }
    });

    // GET /api/admin/analytics-data - Get simple analytics data from views
    this.app.get('/api/admin/analytics-data', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pool = getPool();
        // Query all analytics views
        const [revenueByMonth, customerHealth, subscriptionMetrics, productRevenue, totalRevenue, totalCustomers] = await Promise.all([
          pool.query('SELECT * FROM revenue_by_month ORDER BY month DESC LIMIT 12'),
          pool.query('SELECT * FROM customer_health ORDER BY customer_since DESC'),
          pool.query('SELECT * FROM subscription_metrics LIMIT 1'),
          pool.query('SELECT * FROM product_revenue ORDER BY total_revenue DESC'),
          pool.query('SELECT SUM(net_revenue) as total FROM revenue_by_month'),
          pool.query('SELECT COUNT(*) as total FROM customer_health'),
        ]);

        const metrics = subscriptionMetrics.rows[0] || {};
        res.json({
          revenue_by_month: revenueByMonth.rows,
          customer_health: customerHealth.rows,
          subscription_metrics: {
            ...metrics,
            mrr: metrics.total_mrr || 0,
            total_revenue: totalRevenue.rows[0]?.total || 0,
            total_customers: totalCustomers.rows[0]?.total || 0,
          },
          product_revenue: productRevenue.rows,
        });
      } catch (error) {
        logger.error({ err: error }, 'Error fetching analytics data');
        res.status(500).json({
          error: 'Internal server error',
          message: 'Unable to fetch analytics data',
        });
      }
    });

    // Serve admin pages
    this.app.get('/admin/members', requireAuth, requireAdmin, (req, res) => {
      const membersPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, '../server/public/admin-members.html')
        : path.join(__dirname, '../public/admin-members.html');
      res.sendFile(membersPath);
    });

    this.app.get('/admin/agreements', requireAuth, requireAdmin, (req, res) => {
      const agreementsPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, '../server/public/admin-agreements.html')
        : path.join(__dirname, '../public/admin-agreements.html');
      res.sendFile(agreementsPath);
    });

    this.app.get('/admin/analytics', requireAuth, requireAdmin, (req, res) => {
      const analyticsPath = process.env.NODE_ENV === 'production'
        ? path.join(__dirname, '../server/public/admin-analytics.html')
        : path.join(__dirname, '../public/admin-analytics.html');
      res.sendFile(analyticsPath);
    });

  }

  private setupAuthRoutes(): void {
    if (!workos) {
      logger.error('Cannot setup auth routes - WorkOS not initialized');
      return;
    }

    const orgDb = new OrganizationDatabase();

    // GET /auth/login - Redirect to WorkOS for authentication
    this.app.get('/auth/login', authRateLimiter, (req, res) => {
      try {
        const returnTo = req.query.return_to as string;
        const state = returnTo ? JSON.stringify({ return_to: returnTo }) : undefined;

        const authUrl = workos!.userManagement.getAuthorizationUrl({
          provider: 'authkit',
          clientId: WORKOS_CLIENT_ID,
          redirectUri: WORKOS_REDIRECT_URI,
          state,
        });

        res.redirect(authUrl);
      } catch (error) {
        logger.error({ err: error }, 'Login redirect error:');
        res.status(500).json({
          error: 'Failed to initiate login',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /auth/callback - Handle OAuth callback from WorkOS
    this.app.get('/auth/callback', authRateLimiter, async (req, res) => {
      const code = req.query.code as string;
      const state = req.query.state as string;

      if (!code) {
        return res.status(400).json({
          error: 'Missing authorization code',
          message: 'No authorization code provided',
        });
      }

      try {
        // Exchange code for sealed session and user info
        const { user, sealedSession } = await workos!.userManagement.authenticateWithCode({
          clientId: WORKOS_CLIENT_ID,
          code,
          session: {
            sealSession: true,
            cookiePassword: WORKOS_COOKIE_PASSWORD,
          },
        });

        logger.info({ userId: user.id }, 'User authenticated via OAuth callback');

        // Check if user needs to accept (or re-accept) ToS and Privacy Policy
        // This happens when:
        // 1. User has never accepted them, OR
        // 2. The version has been updated since they last accepted
        try {
          const tosAgreement = await orgDb.getCurrentAgreementByType('terms_of_service');
          const privacyAgreement = await orgDb.getCurrentAgreementByType('privacy_policy');

          // Check if user has already accepted the CURRENT version
          const hasAcceptedCurrentTos = tosAgreement
            ? await orgDb.hasUserAcceptedAgreementVersion(user.id, 'terms_of_service', tosAgreement.version)
            : true;

          const hasAcceptedCurrentPrivacy = privacyAgreement
            ? await orgDb.hasUserAcceptedAgreementVersion(user.id, 'privacy_policy', privacyAgreement.version)
            : true;

          // If they haven't accepted the current version, record acceptance
          // (On first login, this auto-accepts. On subsequent logins with updated agreements,
          // they'll be prompted via dashboard modal before this point)
          if (tosAgreement && !hasAcceptedCurrentTos) {
            await orgDb.recordUserAgreementAcceptance({
              workos_user_id: user.id,
              email: user.email,
              agreement_type: 'terms_of_service',
              agreement_version: tosAgreement.version,
              ip_address: req.ip,
              user_agent: req.get('user-agent'),
            });
            logger.debug({ userId: user.id, version: tosAgreement.version }, 'ToS acceptance recorded');
          }

          if (privacyAgreement && !hasAcceptedCurrentPrivacy) {
            await orgDb.recordUserAgreementAcceptance({
              workos_user_id: user.id,
              email: user.email,
              agreement_type: 'privacy_policy',
              agreement_version: privacyAgreement.version,
              ip_address: req.ip,
              user_agent: req.get('user-agent'),
            });
            logger.debug({ userId: user.id, version: privacyAgreement.version }, 'Privacy policy acceptance recorded');
          }
        } catch (agreementError) {
          // Log but don't fail authentication if agreement recording fails
          logger.error({ error: agreementError }, 'Failed to record agreement acceptance');
        }

        // Set sealed session cookie
        res.cookie('wos-session', sealedSession!, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        logger.debug('Session cookie set, checking organization memberships');

        // Check if user belongs to any WorkOS organizations
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        logger.debug({ count: memberships.data.length }, 'Organization memberships retrieved');

        // Parse return_to from state
        let returnTo = '/dashboard';
        if (state) {
          try {
            const parsedState = JSON.parse(state);
            returnTo = parsedState.return_to || returnTo;
          } catch (e) {
            // Invalid state, use default
          }
        }

        // Redirect to dashboard or onboarding
        if (memberships.data.length === 0) {
          logger.debug('No organizations found, redirecting to onboarding');
          res.redirect('/onboarding.html');
        } else {
          logger.debug({ returnTo }, 'Redirecting authenticated user');
          res.redirect(returnTo);
        }
      } catch (error) {
        logger.error({ err: error }, 'Auth callback error:');
        res.status(500).json({
          error: 'Authentication failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /auth/logout - Clear session and redirect
    this.app.get('/auth/logout', async (req, res) => {
      try {
        const sessionCookie = req.cookies['wos-session'];

        // Revoke the session on WorkOS side if it exists
        if (sessionCookie && workos) {
          try {
            const result = await workos.userManagement.authenticateWithSessionCookie({
              sessionData: sessionCookie,
              cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
            });

            // If we successfully got the session, revoke it
            if (result.authenticated && 'sessionId' in result && result.sessionId) {
              await workos.userManagement.revokeSession({
                sessionId: result.sessionId,
              });
            }
          } catch (error) {
            // Session might already be invalid, that's okay
            logger.debug({ err: error }, 'Failed to revoke session on WorkOS (may already be invalid)');
          }
        }

        // Clear the cookie
        res.clearCookie('wos-session');
        res.redirect('/');
      } catch (error) {
        logger.error({ err: error }, 'Error during logout');
        // Still clear the cookie and redirect even if revocation failed
        res.clearCookie('wos-session');
        res.redirect('/');
      }
    });

    // GET /api/me - Get current user info
    this.app.get('/api/me', requireAuth, async (req, res) => {
      try {
        const user = req.user!;

        // Get user's WorkOS organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        // Map memberships to organization details with roles
        // Fetch organization details separately since membership.organization may be undefined
        const organizations = await Promise.all(
          memberships.data.map(async (membership) => {
            const [workosOrg, localOrg] = await Promise.all([
              workos!.organizations.getOrganization(membership.organizationId),
              orgDb.getOrganization(membership.organizationId),
            ]);
            return {
              id: membership.organizationId,
              name: workosOrg.name,
              // Access role from the membership's role object
              role: membership.role?.slug || 'member',
              status: membership.status,
              is_personal: localOrg?.is_personal || false,
            };
          })
        );

        res.json({
          user: {
            id: user.id,
            email: user.email,
            first_name: user.firstName,
            last_name: user.lastName,
          },
          organizations,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get current user error:');
        res.status(500).json({
          error: 'Failed to get user info',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/agreements - Get user's agreement acceptance history
    this.app.get('/api/me/agreements', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const acceptances = await orgDb.getUserAgreementAcceptances(user.id);

        // Get current versions of all agreement types
        const agreementTypes = ['terms_of_service', 'privacy_policy', 'membership'];
        const currentVersions = await Promise.all(
          agreementTypes.map(async (type) => {
            const current = await orgDb.getCurrentAgreementByType(type);
            return { type, current };
          })
        );

        // Format for display and check if any are outdated
        const formattedAcceptances = acceptances.map(acceptance => {
          const currentInfo = currentVersions.find(v => v.type === acceptance.agreement_type);
          const currentVersion = currentInfo?.current?.version;
          const isOutdated = currentVersion && currentVersion !== acceptance.agreement_version;

          return {
            type: acceptance.agreement_type,
            version: acceptance.agreement_version,
            accepted_at: acceptance.accepted_at,
            current_version: currentVersion,
            is_outdated: isOutdated,
            // Optionally include IP/user-agent for audit purposes
            // (consider privacy implications before exposing to UI)
          };
        });

        // Check for any agreements that haven't been accepted at all
        const acceptedTypes = acceptances.map(a => a.agreement_type);
        const missingAcceptances = currentVersions
          .filter(v => v.current && !acceptedTypes.includes(v.type))
          .map(v => ({
            type: v.type,
            version: null,
            accepted_at: null,
            current_version: v.current!.version,
            is_outdated: true,
          }));

        res.json({
          agreements: [...formattedAcceptances, ...missingAcceptances],
          needs_reacceptance: formattedAcceptances.some(a => a.is_outdated) || missingAcceptances.length > 0,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get user agreements error:');
        res.status(500).json({
          error: 'Failed to get agreement history',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/me/agreements/accept - Accept an agreement
    this.app.post('/api/me/agreements/accept', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { agreement_type, version } = req.body;

        if (!agreement_type || !version) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'agreement_type and version are required',
          });
        }

        const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];
        if (!validTypes.includes(agreement_type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, or membership',
          });
        }

        // Record the acceptance
        await orgDb.recordUserAgreementAcceptance({
          workos_user_id: user.id,
          email: user.email,
          agreement_type,
          agreement_version: version,
          ip_address: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
          user_agent: req.headers['user-agent'] || 'unknown',
        });

        logger.info({ userId: user.id, agreementType: agreement_type, version }, 'User accepted agreement');

        res.json({
          success: true,
          message: 'Agreement accepted successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Accept agreement error');
        res.status(500).json({
          error: 'Failed to accept agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/invitations - Get pending invitations for the current user
    this.app.get('/api/me/invitations', requireAuth, async (req, res) => {
      try {
        const user = req.user!;

        // Get invitations for this user's email
        const invitations = await workos!.userManagement.listInvitations({
          email: user.email,
        });

        // Filter to only pending invitations and get org details
        const pendingInvitations = await Promise.all(
          invitations.data
            .filter(inv => inv.state === 'pending')
            .map(async (inv) => {
              let orgName = 'Organization';
              if (inv.organizationId) {
                try {
                  const org = await workos!.organizations.getOrganization(inv.organizationId);
                  orgName = org.name;
                } catch {
                  // Org may not exist
                }
              }
              return {
                id: inv.id,
                organization_id: inv.organizationId,
                organization_name: orgName,
                email: inv.email,
                role: (inv as any).roleSlug || 'member',
                state: inv.state,
                created_at: inv.createdAt,
                expires_at: inv.expiresAt,
              };
            })
        );

        res.json({ invitations: pendingInvitations });
      } catch (error) {
        logger.error({ err: error }, 'Get user invitations error:');
        res.status(500).json({
          error: 'Failed to get invitations',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/invitations/:invitationId/accept - Accept an invitation
    this.app.post('/api/invitations/:invitationId/accept', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { invitationId } = req.params;

        // Get the invitation to verify it belongs to this user
        const invitation = await workos!.userManagement.getInvitation(invitationId);

        if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'This invitation is not for your email address',
          });
        }

        if (invitation.state !== 'pending') {
          return res.status(400).json({
            error: 'Invalid invitation',
            message: 'This invitation has already been accepted or has expired',
          });
        }

        // Accept the invitation - this creates the membership
        await workos!.userManagement.acceptInvitation(invitationId);

        logger.info({ userId: user.id, invitationId, orgId: invitation.organizationId }, 'User accepted invitation');

        res.json({
          success: true,
          message: 'Invitation accepted successfully',
          organization_id: invitation.organizationId,
        });
      } catch (error) {
        logger.error({ err: error }, 'Accept invitation error:');
        res.status(500).json({
          error: 'Failed to accept invitation',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/agreement/current - Get current agreement by type
    this.app.get('/api/agreement/current', async (req, res) => {
      try {
        const type = (req.query.type as string) || 'membership';
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];

        if (!validTypes.includes(type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, or membership'
          });
        }

        const agreement = await orgDb.getCurrentAgreementByType(type);

        if (!agreement) {
          return res.status(404).json({
            error: 'Agreement not found',
            message: `No ${type} agreement found`
          });
        }

        res.json({
          version: agreement.version,
          type: type,
          text: agreement.text,
          effective_date: agreement.effective_date,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get agreement error:');
        res.status(500).json({
          error: 'Failed to get agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/agreement - Get specific agreement by type and version (or current if no version)
    this.app.get('/api/agreement', async (req, res) => {
      try {
        const type = req.query.type as string;
        const version = req.query.version as string;
        const format = req.query.format as string; // 'json' or 'html' (default: html)
        const validTypes = ['terms_of_service', 'privacy_policy', 'membership'];

        if (!type) {
          return res.status(400).json({
            error: 'Missing parameters',
            message: 'Type parameter is required'
          });
        }

        if (!validTypes.includes(type)) {
          return res.status(400).json({
            error: 'Invalid agreement type',
            message: 'Type must be: terms_of_service, privacy_policy, or membership'
          });
        }

        // If version is provided, get that specific version, otherwise get current
        const agreement = version
          ? await orgDb.getAgreementByTypeAndVersion(type, version)
          : await orgDb.getCurrentAgreementByType(type);

        if (!agreement) {
          return res.status(404).json({
            error: 'Agreement not found',
            message: version
              ? `No ${type} agreement found for version ${version}`
              : `No ${type} agreement found`
          });
        }

        // Return JSON if explicitly requested
        if (format === 'json') {
          return res.json({
            version: agreement.version,
            type: type,
            text: agreement.text,
            effective_date: agreement.effective_date,
          });
        }

        // Otherwise render as HTML
        const { marked } = await import('marked');
        const htmlContent = await marked(agreement.text);

        const typeLabels: Record<string, string> = {
          terms_of_service: 'Terms of Service',
          privacy_policy: 'Privacy Policy',
          membership: 'Membership Agreement'
        };

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${typeLabels[type]} - AdCP Registry</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      padding: 40px 20px;
      line-height: 1.6;
      color: #333;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    h1 {
      color: #2d3748;
      margin-bottom: 10px;
    }
    .meta {
      color: #666;
      font-size: 14px;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid #e0e0e0;
    }
    .content h1 { margin-top: 30px; font-size: 24px; }
    .content h2 { margin-top: 25px; font-size: 20px; }
    .content h3 { margin-top: 20px; font-size: 18px; }
    .content p { margin: 15px 0; }
    .content ul, .content ol { margin: 15px 0; padding-left: 30px; }
    .content li { margin: 8px 0; }
    .back-link {
      display: inline-block;
      margin-top: 30px;
      color: #667eea;
      text-decoration: none;
    }
    .back-link:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${typeLabels[type]}</h1>
    <div class="meta">
      Version ${agreement.version} • Effective Date: ${new Date(agreement.effective_date).toLocaleDateString()}
    </div>
    <div class="content">
      ${htmlContent}
    </div>
    <a href="javascript:window.close()" class="back-link">← Close</a>
  </div>
</body>
</html>
        `;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (error) {
        logger.error({ err: error }, 'Get agreement error:');
        res.status(500).json({
          error: 'Failed to get agreement',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/organizations - Create a new organization
    this.app.post('/api/organizations', requireAuth, orgCreationRateLimiter, async (req, res) => {
      try {
        const user = req.user!;
        const { organization_name, is_personal } = req.body;

        // Validate required fields
        if (!organization_name) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'organization_name is required',
          });
        }

        // Validate organization name format
        const nameValidation = validateOrganizationName(organization_name);
        if (!nameValidation.valid) {
          return res.status(400).json({
            error: 'Invalid organization name',
            message: nameValidation.error,
          });
        }

        // Use trimmed name for consistency
        const trimmedName = organization_name.trim();

        logger.info({ organization_name: trimmedName, is_personal }, 'Creating WorkOS organization');

        // Create WorkOS Organization
        const workosOrg = await workos!.organizations.createOrganization({
          name: trimmedName,
        });

        logger.info({ orgId: workosOrg.id, name: trimmedName }, 'WorkOS organization created');

        // Add user as organization owner (since they created it)
        await workos!.userManagement.createOrganizationMembership({
          userId: user.id,
          organizationId: workosOrg.id,
          roleSlug: 'owner',
        });

        logger.info({ userId: user.id, orgId: workosOrg.id }, 'User added as organization member');

        // Create organization record in our database
        await orgDb.createOrganization({
          workos_organization_id: workosOrg.id,
          name: trimmedName,
          is_personal: is_personal || false,
        });

        logger.info({ orgId: workosOrg.id }, 'Organization record created in database');

        // Record ToS and Privacy Policy acceptance
        const tosAgreement = await orgDb.getCurrentAgreementByType('terms_of_service');
        const privacyAgreement = await orgDb.getCurrentAgreementByType('privacy_policy');

        if (tosAgreement) {
          await orgDb.recordUserAgreementAcceptance({
            workos_user_id: user.id,
            email: user.email,
            agreement_type: 'terms_of_service',
            agreement_version: tosAgreement.version,
            ip_address: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
            user_agent: req.headers['user-agent'] || 'unknown',
            workos_organization_id: workosOrg.id,
          });
        }

        if (privacyAgreement) {
          await orgDb.recordUserAgreementAcceptance({
            workos_user_id: user.id,
            email: user.email,
            agreement_type: 'privacy_policy',
            agreement_version: privacyAgreement.version,
            ip_address: req.ip || (req.headers['x-forwarded-for'] as string) || 'unknown',
            user_agent: req.headers['user-agent'] || 'unknown',
            workos_organization_id: workosOrg.id,
          });
        }

        res.json({
          success: true,
          organization: {
            id: workosOrg.id,
            name: workosOrg.name,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Create organization error');

        // Provide more helpful error messages for common WorkOS errors
        let errorMessage = error instanceof Error ? error.message : 'Unknown error';

        if (errorMessage.includes('state should not be empty')) {
          errorMessage = 'WorkOS configuration error: Organizations require additional setup in WorkOS Dashboard. Please contact support or check your WorkOS settings.';
        }

        res.status(500).json({
          error: 'Failed to create organization',
          message: errorMessage,
        });
      }
    });

    // Billing Routes

    // POST /api/organizations/:orgId/billing/portal - Create Customer Portal session
    this.app.post('/api/organizations/:orgId/billing/portal', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Verify user is member of this organization
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Get organization from database
        const org = await orgDb.getOrganization(orgId);
        if (!org) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'Organization not found in database',
          });
        }

        // Create Stripe customer if needed
        let stripeCustomerId = org.stripe_customer_id;
        if (!stripeCustomerId) {
          logger.info({ orgId }, 'Creating Stripe customer for organization');
          stripeCustomerId = await createStripeCustomer({
            email: user.email,
            name: org.name,
            metadata: {
              workos_organization_id: orgId,
            },
          });

          if (!stripeCustomerId) {
            return res.status(500).json({
              error: 'Failed to create billing account',
              message: 'Could not create Stripe customer',
            });
          }

          // Save Stripe customer ID
          await orgDb.setStripeCustomerId(orgId, stripeCustomerId);
        }

        // Create Customer Portal session
        const returnUrl = `${req.protocol}://${req.get('host')}/dashboard`;
        const portalUrl = await createCustomerPortalSession(stripeCustomerId, returnUrl);

        if (!portalUrl) {
          return res.status(500).json({
            error: 'Failed to create portal session',
            message: 'Could not create Stripe Customer Portal session',
          });
        }

        res.json({
          success: true,
          portal_url: portalUrl,
        });
      } catch (error) {
        logger.error({ err: error }, 'Create portal session error');
        res.status(500).json({
          error: 'Failed to create portal session',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/organizations/:orgId/billing - Get billing info
    this.app.get('/api/organizations/:orgId/billing', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Get organization from database
        const org = await orgDb.getOrganization(orgId);
        if (!org) {
          return res.status(404).json({
            error: 'Organization not found',
            message: 'The requested organization does not exist in database',
          });
        }

        // Verify user is a member of this organization
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Get subscription info - if this fails, we want to know about it
        const subscriptionInfo = await orgDb.getSubscriptionInfo(orgId);

        if (subscriptionInfo === null) {
          // Stripe API call failed - this is an error, not "no subscription"
          return res.status(500).json({
            error: 'Failed to fetch subscription info from Stripe',
            message: 'Unable to retrieve billing information. Please try again.',
          });
        }

        // Create customer session for pricing table (if customer exists)
        let customerSessionSecret = null;
        if (org.stripe_customer_id) {
          customerSessionSecret = await createCustomerSession(org.stripe_customer_id);
        }

        res.json({
          subscription: subscriptionInfo,
          stripe_customer_id: org.stripe_customer_id || null,
          customer_session_secret: customerSessionSecret,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get billing info error:');
        res.status(500).json({
          error: 'Failed to get billing info',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/organizations/:orgId/pending-agreement - Store pending agreement info
    // This is called when user checks the agreement checkbox, before payment
    // Actual acceptance is recorded in webhook when payment succeeds
    this.app.post('/api/organizations/:orgId/pending-agreement', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;
        const { agreement_version, agreement_accepted_at } = req.body;

        if (!agreement_version) {
          return res.status(400).json({
            error: 'Missing required field',
            message: 'agreement_version is required',
          });
        }

        // Verify user is member of this organization
        const memberships = await workos.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Store pending agreement info in organization record
        // This will be used by webhook when subscription is created
        await orgDb.updateOrganization(orgId, {
          pending_agreement_version: agreement_version,
          pending_agreement_accepted_at: agreement_accepted_at ? new Date(agreement_accepted_at) : new Date(),
        });

        logger.info({
          orgId,
          userId: user.id,
          version: agreement_version
        }, 'Pending agreement info stored (will be recorded on payment success)');

        res.json({
          success: true,
          agreement_version,
          accepted_at: new Date().toISOString(),
        });

      } catch (error) {
        logger.error({ err: error }, 'Accept membership agreement error:');
        res.status(500).json({
          error: 'Failed to record agreement acceptance',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/organizations/:orgId/domain-verification-link - Generate WorkOS portal link for domain verification
    this.app.post('/api/organizations/:orgId/domain-verification-link', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Verify user is member of this organization
        const memberships = await workos.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Generate portal link for domain verification
        const { link } = await workos.portal.generateLink({
          organization: orgId,
          intent: 'domain_verification' as any,
        });

        logger.info({ organizationId: orgId, userId: user.id }, 'Generated domain verification portal link');

        res.json({ link });
      } catch (error) {
        logger.error({ err: error }, 'Failed to generate domain verification link');
        res.status(500).json({
          error: 'Failed to generate domain verification link',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/organizations/:orgId/convert-to-team - Convert personal workspace to team
    this.app.post('/api/organizations/:orgId/convert-to-team', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Verify user is owner of this organization
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        const userRole = memberships.data[0].role?.slug || 'member';
        if (userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only owners can convert a workspace to a team',
          });
        }

        // Check if already a team
        const localOrg = await orgDb.getOrganization(orgId);
        if (!localOrg?.is_personal) {
          return res.status(400).json({
            error: 'Already a team',
            message: 'This workspace is already a team workspace',
          });
        }

        // Convert to team by setting is_personal to false
        await orgDb.updateOrganization(orgId, { is_personal: false });

        // Record audit log
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: user.id,
          action: 'convert_to_team',
          resource_type: 'organization',
          resource_id: orgId,
          details: {
            previous_state: 'personal',
            new_state: 'team',
          },
        });

        logger.info({ orgId, userId: user.id }, 'Personal workspace converted to team');

        res.json({
          success: true,
          message: 'Workspace converted to team successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Convert to team error');
        res.status(500).json({
          error: 'Failed to convert workspace',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Team Management Routes

    // GET /api/organizations/:orgId/members - List organization members
    this.app.get('/api/organizations/:orgId/members', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Get all members of the organization
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          organizationId: orgId,
          statuses: ['active', 'pending'],
        });

        // Fetch user details for each membership
        const members = await Promise.all(
          memberships.data.map(async (membership) => {
            try {
              const memberUser = await workos!.userManagement.getUser(membership.userId);
              return {
                id: membership.id,
                user_id: membership.userId,
                email: memberUser.email,
                first_name: memberUser.firstName || null,
                last_name: memberUser.lastName || null,
                role: membership.role?.slug || 'member',
                status: membership.status,
                created_at: membership.createdAt,
              };
            } catch (error) {
              // User might have been deleted
              logger.warn({ membershipId: membership.id, userId: membership.userId }, 'Failed to fetch user for membership');
              return {
                id: membership.id,
                user_id: membership.userId,
                email: 'Unknown',
                first_name: null,
                last_name: null,
                role: membership.role?.slug || 'member',
                status: membership.status,
                created_at: membership.createdAt,
              };
            }
          })
        );

        // Get pending invitations for this organization
        const invitations = await workos!.userManagement.listInvitations({
          organizationId: orgId,
        });

        const pendingInvitations = invitations.data
          .filter(inv => inv.state === 'pending')
          .map(inv => ({
            id: inv.id,
            email: inv.email,
            state: inv.state,
            expires_at: inv.expiresAt,
            created_at: inv.createdAt,
            inviter_user_id: inv.inviterUserId,
          }));

        res.json({
          members,
          pending_invitations: pendingInvitations,
        });
      } catch (error) {
        logger.error({ err: error }, 'List organization members error');
        res.status(500).json({
          error: 'Failed to list organization members',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/organizations/:orgId/invitations - Invite a new member
    this.app.post('/api/organizations/:orgId/invitations', requireAuth, invitationRateLimiter, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;
        const { email, role } = req.body;

        if (!email) {
          return res.status(400).json({
            error: 'Missing required field',
            message: 'email is required',
          });
        }

        // Validate email format
        const emailValidation = validateEmail(email);
        if (!emailValidation.valid) {
          return res.status(400).json({
            error: 'Invalid email',
            message: emailValidation.error,
          });
        }

        // Validate role if provided
        const validRoles = ['member', 'admin', 'owner'];
        if (role && !validRoles.includes(role)) {
          return res.status(400).json({
            error: 'Invalid role',
            message: `Role must be one of: ${validRoles.join(', ')}`,
          });
        }

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Check user's role - only admins or owners can invite
        const userRole = userMemberships.data[0].role?.slug || 'member';
        if (userRole !== 'admin' && userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only admins and owners can invite new members',
          });
        }

        // Send invitation via WorkOS
        const invitation = await workos!.userManagement.sendInvitation({
          email,
          organizationId: orgId,
          inviterUserId: user.id,
          roleSlug: role || 'member',
        });

        logger.info({ orgId, email, inviterId: user.id }, 'Invitation sent');

        // Record audit log
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: user.id,
          action: 'member_invited',
          resource_type: 'invitation',
          resource_id: invitation.id,
          details: { email, role: role || 'member' },
        });

        res.json({
          success: true,
          invitation: {
            id: invitation.id,
            email: invitation.email,
            state: invitation.state,
            expires_at: invitation.expiresAt,
            accept_invitation_url: invitation.acceptInvitationUrl,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Send invitation error');

        // Check for specific WorkOS errors
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorMessage.includes('already a member')) {
          return res.status(400).json({
            error: 'User already a member',
            message: 'This user is already a member of the organization',
          });
        }
        if (errorMessage.includes('pending invitation')) {
          return res.status(400).json({
            error: 'Invitation already exists',
            message: 'An invitation has already been sent to this email address',
          });
        }

        res.status(500).json({
          error: 'Failed to send invitation',
          message: errorMessage,
        });
      }
    });

    // DELETE /api/organizations/:orgId/invitations/:invitationId - Revoke an invitation
    this.app.delete('/api/organizations/:orgId/invitations/:invitationId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId, invitationId } = req.params;

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Check user's role - only admins or owners can revoke invitations
        const userRole = userMemberships.data[0].role?.slug || 'member';
        if (userRole !== 'admin' && userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only admins and owners can revoke invitations',
          });
        }

        // Verify invitation belongs to this organization
        const invitation = await workos!.userManagement.getInvitation(invitationId);
        if (invitation.organizationId !== orgId) {
          return res.status(404).json({
            error: 'Invitation not found',
            message: 'This invitation does not belong to this organization',
          });
        }

        // Revoke the invitation
        await workos!.userManagement.revokeInvitation(invitationId);

        logger.info({ orgId, invitationId, revokerId: user.id }, 'Invitation revoked');

        // Record audit log
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: user.id,
          action: 'invitation_revoked',
          resource_type: 'invitation',
          resource_id: invitationId,
          details: { email: invitation.email },
        });

        res.json({
          success: true,
          message: 'Invitation revoked successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Revoke invitation error');
        res.status(500).json({
          error: 'Failed to revoke invitation',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/organizations/:orgId/invitations/:invitationId/resend - Resend an invitation
    this.app.post('/api/organizations/:orgId/invitations/:invitationId/resend', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId, invitationId } = req.params;

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Check user's role - only admins or owners can resend invitations
        const userRole = userMemberships.data[0].role?.slug || 'member';
        if (userRole !== 'admin' && userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only admins and owners can resend invitations',
          });
        }

        // Verify invitation belongs to this organization
        const invitation = await workos!.userManagement.getInvitation(invitationId);
        if (invitation.organizationId !== orgId) {
          return res.status(404).json({
            error: 'Invitation not found',
            message: 'This invitation does not belong to this organization',
          });
        }

        // Resend the invitation
        const updatedInvitation = await workos!.userManagement.resendInvitation(invitationId);

        logger.info({ orgId, invitationId, resenderId: user.id }, 'Invitation resent');

        res.json({
          success: true,
          invitation: {
            id: updatedInvitation.id,
            email: updatedInvitation.email,
            state: updatedInvitation.state,
            expires_at: updatedInvitation.expiresAt,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Resend invitation error');
        res.status(500).json({
          error: 'Failed to resend invitation',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PATCH /api/organizations/:orgId/members/:membershipId - Update member role
    this.app.patch('/api/organizations/:orgId/members/:membershipId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId, membershipId } = req.params;
        const { role } = req.body;

        if (!role) {
          return res.status(400).json({
            error: 'Missing required field',
            message: 'role is required',
          });
        }

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Check user's role - only admins or owners can update roles
        const userRole = userMemberships.data[0].role?.slug || 'member';
        if (userRole !== 'admin' && userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only admins and owners can update member roles',
          });
        }

        // Verify membership belongs to this organization
        const membership = await workos!.userManagement.getOrganizationMembership(membershipId);
        if (membership.organizationId !== orgId) {
          return res.status(404).json({
            error: 'Member not found',
            message: 'This member does not belong to this organization',
          });
        }

        // Prevent self-demotion from owner role
        if (membership.userId === user.id && userRole === 'owner' && role !== 'owner') {
          return res.status(400).json({
            error: 'Cannot demote yourself',
            message: 'You cannot change your own owner role. Transfer ownership to another member first.',
          });
        }

        // Update the membership role
        const updatedMembership = await workos!.userManagement.updateOrganizationMembership(membershipId, {
          roleSlug: role,
        });

        logger.info({ orgId, membershipId, newRole: role, updaterId: user.id }, 'Member role updated');

        // Record audit log
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: user.id,
          action: 'member_role_updated',
          resource_type: 'membership',
          resource_id: membershipId,
          details: { target_user_id: membership.userId, new_role: role, old_role: membership.role?.slug },
        });

        res.json({
          success: true,
          membership: {
            id: updatedMembership.id,
            user_id: updatedMembership.userId,
            role: updatedMembership.role?.slug || 'member',
            status: updatedMembership.status,
          },
        });
      } catch (error) {
        logger.error({ err: error }, 'Update member role error');
        res.status(500).json({
          error: 'Failed to update member role',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/organizations/:orgId/members/:membershipId - Remove a member
    this.app.delete('/api/organizations/:orgId/members/:membershipId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId, membershipId } = req.params;

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Check user's role - only admins or owners can remove members
        const userRole = userMemberships.data[0].role?.slug || 'member';
        if (userRole !== 'admin' && userRole !== 'owner') {
          return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'Only admins and owners can remove members',
          });
        }

        // Verify membership belongs to this organization
        const membership = await workos!.userManagement.getOrganizationMembership(membershipId);
        if (membership.organizationId !== orgId) {
          return res.status(404).json({
            error: 'Member not found',
            message: 'This member does not belong to this organization',
          });
        }

        // Prevent self-removal
        if (membership.userId === user.id) {
          return res.status(400).json({
            error: 'Cannot remove yourself',
            message: 'You cannot remove yourself from the organization. Leave the organization instead or transfer ownership first.',
          });
        }

        // Get member email for audit log before deletion
        let memberEmail = 'Unknown';
        try {
          const memberUser = await workos!.userManagement.getUser(membership.userId);
          memberEmail = memberUser.email;
        } catch {
          // User might not exist anymore
        }

        // Remove the member
        await workos!.userManagement.deleteOrganizationMembership(membershipId);

        logger.info({ orgId, membershipId, removerId: user.id }, 'Member removed');

        // Record audit log
        await orgDb.recordAuditLog({
          workos_organization_id: orgId,
          workos_user_id: user.id,
          action: 'member_removed',
          resource_type: 'membership',
          resource_id: membershipId,
          details: { removed_user_id: membership.userId, removed_email: memberEmail },
        });

        res.json({
          success: true,
          message: 'Member removed successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Remove member error');
        res.status(500).json({
          error: 'Failed to remove member',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/organizations/:orgId/roles - List available roles for the organization
    this.app.get('/api/organizations/:orgId/roles', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { orgId } = req.params;

        // Verify user is member of this organization
        const userMemberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
          organizationId: orgId,
        });

        if (userMemberships.data.length === 0) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You are not a member of this organization',
          });
        }

        // Get available roles from WorkOS
        const roles = await workos!.organizations.listOrganizationRoles({ organizationId: orgId });

        res.json({
          roles: roles.data.map(role => ({
            id: role.id,
            slug: role.slug,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
          })),
        });
      } catch (error) {
        logger.error({ err: error }, 'List organization roles error');

        // If roles aren't configured, return default roles
        if (error instanceof Error && error.message.includes('not found')) {
          return res.json({
            roles: [
              { slug: 'owner', name: 'Owner', description: 'Full access to all organization settings' },
              { slug: 'admin', name: 'Admin', description: 'Can manage members and settings' },
              { slug: 'member', name: 'Member', description: 'Standard member access' },
            ],
          });
        }

        res.status(500).json({
          error: 'Failed to list roles',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });


    // API Key Management Routes using WorkOS

    // Legacy API key endpoints - disabled after migration to WorkOS organizations
    // TODO: Re-implement using WorkOS organization-based access control
    /*
    // POST /api/companies/:companyId/api-keys - Create a new API key
    this.app.post('/api/companies/:companyId/api-keys', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { companyId } = req.params;
        const { name, permissions } = req.body;

        // Verify user has access to this company
        const companyUser = await companyDb.getCompanyUser(companyId, user.id);
        if (!companyUser || (companyUser.role !== 'owner' && companyUser.role !== 'admin')) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'Only company owners and admins can create API keys',
          });
        }

        // Create API key via WorkOS
        // Note: WorkOS API Keys product requires organization setup
        // This is demo/placeholder code - real implementation would use crypto.randomBytes()
        const apiKey = {
          id: `key_${Date.now()}`,
          name: name || 'API Key',
          key: `sk_demo_${Math.random().toString(36).substring(2, 15)}`,
          permissions: permissions || ['registry:read', 'registry:write'],
          created_at: new Date().toISOString(),
          company_id: companyId,
        };

        // Log API key creation
        await companyDb.recordAuditLog({
          company_id: companyId,
          user_id: user.id,
          action: 'api_key_created',
          resource_type: 'api_key',
          resource_id: apiKey.id,
          details: { name: apiKey.name, permissions: apiKey.permissions },
        });

        res.json({
          success: true,
          api_key: apiKey,
          warning: 'Store this key securely - it will not be shown again',
        });
      } catch (error) {
        logger.error({ err: error }, 'Create API key error:');
        res.status(500).json({
          error: 'Failed to create API key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/companies/:companyId/api-keys - List API keys for a company
    this.app.get('/api/companies/:companyId/api-keys', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { companyId } = req.params;

        // Verify user has access to this company
        const companyUser = await companyDb.getCompanyUser(companyId, user.id);
        if (!companyUser) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'You do not have access to this company',
          });
        }

        // In a real implementation, this would query WorkOS for the company's API keys
        // For now, return empty array as placeholder
        res.json({
          api_keys: [],
          message: 'WorkOS API Keys integration coming soon',
        });
      } catch (error) {
        logger.error({ err: error }, 'List API keys error:');
        res.status(500).json({
          error: 'Failed to list API keys',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/companies/:companyId/api-keys/:keyId - Revoke an API key
    this.app.delete('/api/companies/:companyId/api-keys/:keyId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { companyId, keyId } = req.params;

        // Verify user has access to this company
        const companyUser = await companyDb.getCompanyUser(companyId, user.id);
        if (!companyUser || (companyUser.role !== 'owner' && companyUser.role !== 'admin')) {
          return res.status(403).json({
            error: 'Access denied',
            message: 'Only company owners and admins can revoke API keys',
          });
        }

        // Revoke via WorkOS (placeholder)
        // In production: await workos!.apiKeys.revoke(keyId);

        // Log API key revocation
        await companyDb.recordAuditLog({
          company_id: companyId,
          user_id: user.id,
          action: 'api_key_revoked',
          resource_type: 'api_key',
          resource_id: keyId,
          details: {},
        });

        res.json({
          success: true,
          message: 'API key revoked successfully',
        });
      } catch (error) {
        logger.error({ err: error }, 'Revoke API key error:');
        res.status(500).json({
          error: 'Failed to revoke API key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
    */

    // Member Profile Routes
    const memberDb = new MemberDatabase();

    // GET /api/members - List public member profiles (for directory)
    this.app.get('/api/members', async (req, res) => {
      try {
        const { search, offerings, limit, offset } = req.query;

        const profiles = await memberDb.getPublicProfiles({
          search: search as string,
          offerings: offerings ? (offerings as string).split(',') as any : undefined,
          limit: limit ? parseInt(limit as string, 10) : 50,
          offset: offset ? parseInt(offset as string, 10) : 0,
        });

        res.json({ members: profiles });
      } catch (error) {
        logger.error({ err: error }, 'List members error');
        res.status(500).json({
          error: 'Failed to list members',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/members/carousel - Get member profiles for homepage carousel
    this.app.get('/api/members/carousel', async (req, res) => {
      try {
        const profiles = await memberDb.getCarouselProfiles();
        res.json({ members: profiles });
      } catch (error) {
        logger.error({ err: error }, 'Get carousel members error');
        res.status(500).json({
          error: 'Failed to get carousel members',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/members/:slug - Get single member profile by slug
    this.app.get('/api/members/:slug', async (req, res) => {
      try {
        const { slug } = req.params;
        const profile = await memberDb.getProfileBySlug(slug);

        if (!profile) {
          return res.status(404).json({
            error: 'Member not found',
            message: `No member found with slug: ${slug}`,
          });
        }

        // Only return if public (unless authenticated user owns it)
        if (!profile.is_public) {
          // Check if authenticated user owns this profile
          const sessionCookie = req.cookies?.['wos-session'];
          if (!sessionCookie || !AUTH_ENABLED || !workos) {
            return res.status(404).json({
              error: 'Member not found',
              message: `No member found with slug: ${slug}`,
            });
          }

          try {
            const result = await workos.userManagement.authenticateWithSessionCookie({
              sessionData: sessionCookie,
              cookiePassword: WORKOS_COOKIE_PASSWORD,
            });

            if (!result.authenticated || !('user' in result) || !result.user) {
              return res.status(404).json({
                error: 'Member not found',
                message: `No member found with slug: ${slug}`,
              });
            }

            // Check if user is member of the organization
            const memberships = await workos.userManagement.listOrganizationMemberships({
              userId: result.user.id,
              organizationId: profile.workos_organization_id,
            });

            if (memberships.data.length === 0) {
              return res.status(404).json({
                error: 'Member not found',
                message: `No member found with slug: ${slug}`,
              });
            }
          } catch {
            return res.status(404).json({
              error: 'Member not found',
              message: `No member found with slug: ${slug}`,
            });
          }
        }

        res.json({ member: profile });
      } catch (error) {
        logger.error({ err: error }, 'Get member error');
        res.status(500).json({
          error: 'Failed to get member',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/public/discover-agent - Public endpoint to discover agent info (for members directory)
    this.app.get('/api/public/discover-agent', async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        // Use SingleAgentClient which handles protocol detection and connection automatically
        const client = new SingleAgentClient({
          id: 'discovery',
          name: 'discovery-client',
          agent_uri: url,
          protocol: 'mcp', // Library handles protocol detection internally
        });

        // getAgentInfo() handles all the protocol detection and tool discovery
        const agentInfo = await client.getAgentInfo();
        const tools = agentInfo.tools || [];

        // Detect agent type from tools
        // Check for sales first since sales agents may also expose creative tools
        let agentType = 'unknown';
        const toolNames = tools.map((t: { name: string }) => t.name.toLowerCase());
        if (toolNames.some((n: string) => n.includes('get_product') || n.includes('media_buy') || n.includes('create_media'))) {
          agentType = 'sales';
        } else if (toolNames.some((n: string) => n.includes('signal') || n.includes('audience'))) {
          agentType = 'signals';
        } else if (toolNames.some((n: string) => n.includes('creative') || n.includes('format') || n.includes('preview'))) {
          agentType = 'creative';
        }

        // The library returns our config name, so extract real name from URL or use hostname
        const hostname = new URL(url).hostname;
        const agentName = (agentInfo.name && agentInfo.name !== 'discovery-client')
          ? agentInfo.name
          : hostname;

        // Detect protocols - check if both MCP and A2A are available
        const protocols: string[] = [agentInfo.protocol];
        try {
          // Check for A2A agent card if we detected MCP
          if (agentInfo.protocol === 'mcp') {
            const a2aUrl = new URL('/.well-known/agent.json', url).toString();
            const a2aResponse = await fetch(a2aUrl, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(3000),
            });
            if (a2aResponse.ok) {
              protocols.push('a2a');
            }
          }
        } catch {
          // Ignore A2A check failures
        }

        // Fetch type-specific stats
        let stats: {
          format_count?: number;
          product_count?: number;
          publisher_count?: number;
        } = {};

        if (agentType === 'creative') {
          try {
            const creativeClient = new CreativeAgentClient({ agentUrl: url });
            const formats = await creativeClient.listFormats();
            stats.format_count = formats.length;
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch creative formats');
            stats.format_count = 0;
          }
        } else if (agentType === 'sales') {
          // Always show product and publisher counts for sales agents
          stats.product_count = 0;
          stats.publisher_count = 0;
          try {
            const result = await client.getProducts({ brief: '' });
            if (result.data?.products) {
              stats.product_count = result.data.products.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch products');
          }
          try {
            const pubResult = await client.listAuthorizedProperties({});
            if (pubResult.data?.publisher_domains) {
              stats.publisher_count = pubResult.data.publisher_domains.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch publishers');
          }
        }

        return res.json({
          name: agentName,
          description: agentInfo.description,
          protocols,
          type: agentType,
          stats,
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Public agent discovery error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within 10 seconds',
          });
        }

        return res.status(500).json({
          error: 'Agent discovery failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/public/agent-formats - Public endpoint to fetch creative formats from a creative agent
    this.app.get('/api/public/agent-formats', async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        // CreativeAgentClient handles protocol detection internally
        const creativeClient = new CreativeAgentClient({
          agentUrl: url,
        });

        const formats = await creativeClient.listFormats();

        return res.json({
          success: true,
          formats: formats.map(format => ({
            format_id: format.format_id,
            name: format.name,
            type: format.type,
            description: format.description,
            preview_image: format.preview_image,
            example_url: format.example_url,
            renders: format.renders,
            assets_required: format.assets_required,
            output_format_ids: format.output_format_ids,
            agent_url: format.agent_url,
          })),
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Agent formats fetch error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within the timeout period',
          });
        }

        return res.status(500).json({
          error: 'Failed to fetch formats',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/me/member-profile - Get current user's organization's member profile
    // Supports ?org=org_id query parameter to specify which organization
    this.app.get('/api/me/member-profile', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          // Verify user is a member of the requested org
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          // Default to first org
          targetOrgId = memberships.data[0].organizationId;
        }

        const profile = await memberDb.getProfileByOrgId(targetOrgId);

        // Get org name from WorkOS
        const org = await workos!.organizations.getOrganization(targetOrgId);

        res.json({
          profile: profile || null,
          organization_id: targetOrgId,
          organization_name: org.name,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get my member profile error');
        res.status(500).json({
          error: 'Failed to get member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/me/member-profile - Create member profile for current user's organization
    // Supports ?org=org_id query parameter to specify which organization
    this.app.post('/api/me/member-profile', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;
        const {
          display_name,
          slug,
          tagline,
          description,
          logo_url,
          logo_light_url,
          logo_dark_url,
          brand_color,
          contact_email,
          contact_website,
          contact_phone,
          linkedin_url,
          twitter_url,
          offerings,
          tags,
          is_public,
          show_in_carousel,
        } = req.body;

        // Validate required fields
        if (!display_name || !slug) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'display_name and slug are required',
          });
        }

        // Validate slug format
        if (!/^[a-z0-9-]+$/.test(slug)) {
          return res.status(400).json({
            error: 'Invalid slug',
            message: 'Slug must contain only lowercase letters, numbers, and hyphens',
          });
        }

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(400).json({
            error: 'No organization',
            message: 'User must be a member of an organization to create a profile',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          // Verify user is a member of the requested org
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          // Default to first org
          targetOrgId = memberships.data[0].organizationId;
        }

        // Check if profile already exists for this org
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (existingProfile) {
          return res.status(409).json({
            error: 'Profile already exists',
            message: 'Organization already has a member profile. Use PUT to update.',
          });
        }

        // Check slug availability
        const slugAvailable = await memberDb.isSlugAvailable(slug);
        if (!slugAvailable) {
          return res.status(409).json({
            error: 'Slug not available',
            message: 'This slug is already taken. Please choose a different one.',
          });
        }

        // Validate offerings if provided
        const validOfferings = ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'consulting', 'other'];
        if (offerings && Array.isArray(offerings)) {
          const invalidOfferings = offerings.filter((o: string) => !validOfferings.includes(o));
          if (invalidOfferings.length > 0) {
            return res.status(400).json({
              error: 'Invalid offerings',
              message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${validOfferings.join(', ')}`,
            });
          }
        }

        const profile = await memberDb.createProfile({
          workos_organization_id: targetOrgId,
          display_name,
          slug,
          tagline,
          description,
          logo_url,
          logo_light_url,
          logo_dark_url,
          brand_color,
          contact_email,
          contact_website,
          contact_phone,
          linkedin_url,
          twitter_url,
          offerings: offerings || [],
          tags: tags || [],
          is_public: is_public ?? false,
          show_in_carousel: show_in_carousel ?? false,
        });

        logger.info({ profileId: profile.id, orgId: targetOrgId, slug }, 'Member profile created');

        res.status(201).json({ profile });
      } catch (error) {
        logger.error({ err: error }, 'Create member profile error');
        res.status(500).json({
          error: 'Failed to create member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/me/member-profile - Update current user's organization's member profile
    // Supports ?org=org_id query parameter to specify which organization
    this.app.put('/api/me/member-profile', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;
        const updates = req.body;

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(400).json({
            error: 'No organization',
            message: 'User must be a member of an organization to update a profile',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }

        // Check if profile exists
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (!existingProfile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: 'No member profile exists for your organization. Use POST to create one.',
          });
        }

        // Validate offerings if provided
        const validOfferings = ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'consulting', 'other'];
        if (updates.offerings && Array.isArray(updates.offerings)) {
          const invalidOfferings = updates.offerings.filter((o: string) => !validOfferings.includes(o));
          if (invalidOfferings.length > 0) {
            return res.status(400).json({
              error: 'Invalid offerings',
              message: `Invalid offerings: ${invalidOfferings.join(', ')}. Valid options: ${validOfferings.join(', ')}`,
            });
          }
        }

        // Remove fields that shouldn't be updated directly
        delete updates.id;
        delete updates.workos_organization_id;
        delete updates.slug; // Slug changes not allowed via this endpoint
        delete updates.created_at;
        delete updates.updated_at;
        delete updates.featured; // Only admins can set featured

        const profile = await memberDb.updateProfileByOrgId(targetOrgId, updates);

        logger.info({ profileId: profile?.id, orgId: targetOrgId }, 'Member profile updated');

        res.json({ profile });
      } catch (error) {
        logger.error({ err: error }, 'Update member profile error');
        res.status(500).json({
          error: 'Failed to update member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/me/member-profile - Delete current user's organization's member profile
    // Supports ?org=org_id query parameter to specify which organization
    this.app.delete('/api/me/member-profile', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(400).json({
            error: 'No organization',
            message: 'User must be a member of an organization',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }

        // Check if profile exists
        const existingProfile = await memberDb.getProfileByOrgId(targetOrgId);
        if (!existingProfile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: 'No member profile exists for your organization',
          });
        }

        await memberDb.deleteProfile(existingProfile.id);

        logger.info({ profileId: existingProfile.id, orgId: targetOrgId }, 'Member profile deleted');

        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error }, 'Delete member profile error');
        res.status(500).json({
          error: 'Failed to delete member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Admin routes for member profiles
    // GET /api/admin/member-profiles - List all member profiles (admin)
    this.app.get('/api/admin/member-profiles', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { is_public, search, limit, offset } = req.query;

        const profiles = await memberDb.listProfiles({
          is_public: is_public === 'true' ? true : is_public === 'false' ? false : undefined,
          search: search as string,
          limit: limit ? parseInt(limit as string, 10) : 100,
          offset: offset ? parseInt(offset as string, 10) : 0,
        });

        res.json({ profiles });
      } catch (error) {
        logger.error({ err: error }, 'Admin list member profiles error');
        res.status(500).json({
          error: 'Failed to list member profiles',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/admin/member-profiles/:id - Update any member profile (admin)
    this.app.put('/api/admin/member-profiles/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;
        const updates = req.body;

        // Remove fields that shouldn't be updated
        delete updates.id;
        delete updates.workos_organization_id;
        delete updates.created_at;
        delete updates.updated_at;

        const profile = await memberDb.updateProfile(id, updates);

        if (!profile) {
          return res.status(404).json({
            error: 'Profile not found',
            message: `No member profile found with ID: ${id}`,
          });
        }

        logger.info({ profileId: id, adminUpdate: true }, 'Member profile updated by admin');

        res.json({ profile });
      } catch (error) {
        logger.error({ err: error }, 'Admin update member profile error');
        res.status(500).json({
          error: 'Failed to update member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/admin/member-profiles/:id - Delete any member profile (admin)
    this.app.delete('/api/admin/member-profiles/:id', requireAuth, requireAdmin, async (req, res) => {
      try {
        const { id } = req.params;

        const deleted = await memberDb.deleteProfile(id);

        if (!deleted) {
          return res.status(404).json({
            error: 'Profile not found',
            message: `No member profile found with ID: ${id}`,
          });
        }

        logger.info({ profileId: id, adminDelete: true }, 'Member profile deleted by admin');

        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error }, 'Admin delete member profile error');
        res.status(500).json({
          error: 'Failed to delete member profile',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // ========================================
    // Organization Agent Management Endpoints
    // ========================================
    const registryDb = new RegistryDatabase();

    // GET /api/me/agents - List agents for the current user's organization
    this.app.get('/api/me/agents', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(404).json({
            error: 'No organization',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }

        // Get agents for this organization
        const agents = await registryDb.getEntriesByOrg(targetOrgId, 'agent');

        // Get org info
        const org = await workos!.organizations.getOrganization(targetOrgId);

        res.json({
          agents,
          organization_id: targetOrgId,
          organization_name: org.name,
        });
      } catch (error) {
        logger.error({ err: error }, 'Get org agents error');
        res.status(500).json({
          error: 'Failed to get agents',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // POST /api/me/agents - Create a new agent for the current user's organization
    this.app.post('/api/me/agents', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const requestedOrgId = req.query.org as string | undefined;
        const {
          name,
          slug,
          url,
          agent_type, // sales, creative, signals
          description,
          contact_name,
          contact_email,
          contact_website,
          tags,
        } = req.body;

        // Validate required fields
        if (!name || !slug || !url || !agent_type) {
          return res.status(400).json({
            error: 'Missing required fields',
            message: 'name, slug, url, and agent_type are required',
          });
        }

        // Validate agent type
        const validAgentTypes = ['sales', 'creative', 'signals'];
        if (!validAgentTypes.includes(agent_type)) {
          return res.status(400).json({
            error: 'Invalid agent type',
            message: `agent_type must be one of: ${validAgentTypes.join(', ')}`,
          });
        }

        // Validate slug format
        if (!/^[a-z0-9-]+$/.test(slug)) {
          return res.status(400).json({
            error: 'Invalid slug',
            message: 'Slug must contain only lowercase letters, numbers, and hyphens',
          });
        }

        // Validate URL format
        try {
          new URL(url);
        } catch {
          return res.status(400).json({
            error: 'Invalid URL',
            message: 'Please provide a valid URL',
          });
        }

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(400).json({
            error: 'No organization',
            message: 'User must be a member of an organization to create an agent',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }

        // Check slug availability
        const slugAvailable = await registryDb.isSlugAvailable(slug);
        if (!slugAvailable) {
          return res.status(409).json({
            error: 'Slug not available',
            message: 'This slug is already taken. Please choose a different one.',
          });
        }

        // Create the agent entry
        const entry = await registryDb.createEntry({
          entry_type: 'agent',
          name,
          slug,
          url,
          metadata: {
            agent_type,
            description: description || '',
            mcp_endpoint: url,
            protocol: 'mcp',
          },
          tags: tags || [agent_type],
          contact_name,
          contact_email,
          contact_website,
          approval_status: 'pending', // New agents need approval
          workos_organization_id: targetOrgId,
        });

        logger.info({
          entryId: entry.id,
          orgId: targetOrgId,
          agentType: agent_type,
        }, 'Agent created');

        res.status(201).json({
          agent: entry,
          message: 'Agent created successfully. It will be visible in the registry once approved.',
        });
      } catch (error) {
        logger.error({ err: error }, 'Create agent error');
        res.status(500).json({
          error: 'Failed to create agent',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // PUT /api/me/agents/:agentId - Update an agent
    this.app.put('/api/me/agents/:agentId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { agentId } = req.params;
        const requestedOrgId = req.query.org as string | undefined;
        const updates = req.body;

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Not authorized',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }

        // Get the agent to verify ownership
        const existingAgent = await registryDb.getEntryById(agentId);
        if (!existingAgent) {
          return res.status(404).json({
            error: 'Not found',
            message: 'Agent not found',
          });
        }

        // Verify this agent belongs to the user's organization
        if (existingAgent.workos_organization_id !== targetOrgId) {
          return res.status(403).json({
            error: 'Not authorized',
            message: 'You can only update agents owned by your organization',
          });
        }

        // Build update object (only allow certain fields to be updated)
        const allowedUpdates: any = {};
        if (updates.name) allowedUpdates.name = updates.name;
        if (updates.url) {
          try {
            new URL(updates.url);
            allowedUpdates.url = updates.url;
          } catch {
            return res.status(400).json({
              error: 'Invalid URL',
              message: 'Please provide a valid URL',
            });
          }
        }
        if (updates.contact_name !== undefined) allowedUpdates.contact_name = updates.contact_name;
        if (updates.contact_email !== undefined) allowedUpdates.contact_email = updates.contact_email;
        if (updates.contact_website !== undefined) allowedUpdates.contact_website = updates.contact_website;
        if (updates.tags) allowedUpdates.tags = updates.tags;

        // Update metadata fields
        if (updates.description !== undefined || updates.agent_type !== undefined) {
          const metadata = { ...existingAgent.metadata };
          if (updates.description !== undefined) metadata.description = updates.description;
          if (updates.agent_type !== undefined) {
            const validAgentTypes = ['sales', 'creative', 'signals'];
            if (!validAgentTypes.includes(updates.agent_type)) {
              return res.status(400).json({
                error: 'Invalid agent type',
                message: `agent_type must be one of: ${validAgentTypes.join(', ')}`,
              });
            }
            metadata.agent_type = updates.agent_type;
          }
          allowedUpdates.metadata = metadata;
        }

        // Updates reset approval status to pending (agent needs re-review)
        if (Object.keys(allowedUpdates).length > 0) {
          allowedUpdates.approval_status = 'pending';
        }

        const updatedAgent = await registryDb.updateEntry(existingAgent.slug, allowedUpdates);

        logger.info({
          agentId,
          orgId: targetOrgId,
        }, 'Agent updated');

        res.json({
          agent: updatedAgent,
          message: 'Agent updated successfully. Changes will be visible once approved.',
        });
      } catch (error) {
        logger.error({ err: error }, 'Update agent error');
        res.status(500).json({
          error: 'Failed to update agent',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // DELETE /api/me/agents/:agentId - Delete an agent
    this.app.delete('/api/me/agents/:agentId', requireAuth, async (req, res) => {
      try {
        const user = req.user!;
        const { agentId } = req.params;
        const requestedOrgId = req.query.org as string | undefined;

        // Get user's organization memberships
        const memberships = await workos!.userManagement.listOrganizationMemberships({
          userId: user.id,
        });

        if (memberships.data.length === 0) {
          return res.status(403).json({
            error: 'Not authorized',
            message: 'User is not a member of any organization',
          });
        }

        // Determine which org to use
        let targetOrgId: string;
        if (requestedOrgId) {
          const isMember = memberships.data.some(m => m.organizationId === requestedOrgId);
          if (!isMember) {
            return res.status(403).json({
              error: 'Not authorized',
              message: 'User is not a member of the requested organization',
            });
          }
          targetOrgId = requestedOrgId;
        } else {
          targetOrgId = memberships.data[0].organizationId;
        }

        // Delete the agent (only if it belongs to this org)
        const deleted = await registryDb.deleteEntryByIdForOrg(agentId, targetOrgId);

        if (!deleted) {
          return res.status(404).json({
            error: 'Not found',
            message: 'Agent not found or you do not have permission to delete it',
          });
        }

        logger.info({
          agentId,
          orgId: targetOrgId,
        }, 'Agent deleted');

        res.json({ success: true });
      } catch (error) {
        logger.error({ err: error }, 'Delete agent error');
        res.status(500).json({
          error: 'Failed to delete agent',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // GET /api/agents/check-slug/:slug - Check agent slug availability
    this.app.get('/api/agents/check-slug/:slug', async (req, res) => {
      try {
        const { slug } = req.params;
        const available = await registryDb.isSlugAvailable(slug);
        res.json({ available, slug });
      } catch (error) {
        logger.error({ err: error }, 'Check agent slug error');
        res.status(500).json({
          error: 'Failed to check slug availability',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Utility: Check slug availability
    this.app.get('/api/members/check-slug/:slug', async (req, res) => {
      try {
        const { slug } = req.params;
        const available = await memberDb.isSlugAvailable(slug);
        res.json({ available, slug });
      } catch (error) {
        logger.error({ err: error }, 'Check slug error');
        res.status(500).json({
          error: 'Failed to check slug availability',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Agent Discovery: Fetch agent info from URL
    this.app.get('/api/discover-agent', requireAuth, async (req, res) => {
      const { url } = req.query;

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
      }

      try {
        // Use SingleAgentClient which handles protocol detection and connection automatically
        const client = new SingleAgentClient({
          id: 'discovery',
          name: 'discovery-client',
          agent_uri: url,
          protocol: 'mcp', // Library handles protocol detection internally
        });

        // getAgentInfo() handles all the protocol detection and tool discovery
        const agentInfo = await client.getAgentInfo();
        const tools = agentInfo.tools || [];

        // Detect agent type from tools
        // Check for sales first since sales agents may also expose creative tools
        let agentType = 'unknown';
        const toolNames = tools.map((t: { name: string }) => t.name.toLowerCase());
        if (toolNames.some((n: string) => n.includes('get_product') || n.includes('media_buy') || n.includes('create_media'))) {
          agentType = 'sales';
        } else if (toolNames.some((n: string) => n.includes('signal') || n.includes('audience'))) {
          agentType = 'signals';
        } else if (toolNames.some((n: string) => n.includes('creative') || n.includes('format') || n.includes('preview'))) {
          agentType = 'creative';
        }

        // The library returns our config name, so extract real name from URL or use hostname
        const hostname = new URL(url).hostname;
        const agentName = (agentInfo.name && agentInfo.name !== 'discovery-client')
          ? agentInfo.name
          : hostname;

        // Detect protocols - check if both MCP and A2A are available
        const protocols: string[] = [agentInfo.protocol];
        try {
          // Check for A2A agent card if we detected MCP
          if (agentInfo.protocol === 'mcp') {
            const a2aUrl = new URL('/.well-known/agent.json', url).toString();
            const a2aResponse = await fetch(a2aUrl, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(3000),
            });
            if (a2aResponse.ok) {
              protocols.push('a2a');
            }
          }
        } catch {
          // Ignore A2A check failures
        }

        // Fetch type-specific stats
        let stats: {
          format_count?: number;
          product_count?: number;
          publisher_count?: number;
        } = {};

        if (agentType === 'creative') {
          try {
            const creativeClient = new CreativeAgentClient({ agentUrl: url });
            const formats = await creativeClient.listFormats();
            stats.format_count = formats.length;
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch creative formats');
            stats.format_count = 0;
          }
        } else if (agentType === 'sales') {
          // Always show product and publisher counts for sales agents
          stats.product_count = 0;
          stats.publisher_count = 0;
          try {
            const result = await client.getProducts({ brief: '' });
            if (result.data?.products) {
              stats.product_count = result.data.products.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch products');
          }
          try {
            const pubResult = await client.listAuthorizedProperties({});
            if (pubResult.data?.publisher_domains) {
              stats.publisher_count = pubResult.data.publisher_domains.length;
            }
          } catch (statsError) {
            logger.debug({ err: statsError, url }, 'Failed to fetch publishers');
          }
        }

        return res.json({
          name: agentName,
          description: agentInfo.description,
          protocols,
          type: agentType,
          stats,
        });
      } catch (error) {
        logger.error({ err: error, url }, 'Agent discovery error');

        if (error instanceof Error && error.name === 'TimeoutError') {
          return res.status(504).json({
            error: 'Connection timeout',
            message: 'Agent did not respond within 10 seconds',
          });
        }

        return res.status(500).json({
          error: 'Agent discovery failed',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  async start(port: number = 3000): Promise<void> {
    await this.registry.initialize();

    // Sync organizations from WorkOS and Stripe to local database (dev environment support)
    if (AUTH_ENABLED && workos) {
      const orgDb = new OrganizationDatabase();

      // Sync WorkOS organizations first
      try {
        const result = await orgDb.syncFromWorkOS(workos);
        if (result.synced > 0) {
          logger.info({ synced: result.synced, existing: result.existing }, 'Synced organizations from WorkOS');
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to sync organizations from WorkOS (non-fatal)');
      }

      // Then sync Stripe customer IDs
      try {
        const result = await orgDb.syncStripeCustomers();
        if (result.synced > 0) {
          logger.info({ synced: result.synced, skipped: result.skipped }, 'Synced Stripe customer IDs');
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to sync Stripe customers (non-fatal)');
      }
    }

    // Pre-warm caches for all agents in background
    const allAgents = await this.registry.listAgents();
    logger.info({ agentCount: allAgents.length }, 'Pre-warming caches');

    // Don't await - let this run in background
    this.prewarmCaches(allAgents).then(() => {
      logger.info('Cache pre-warming complete');
    }).catch(err => {
      logger.error({ err }, 'Cache pre-warming failed');
    });

    // Start periodic property crawler for sales agents
    const salesAgents = await this.registry.listAgents("sales");
    if (salesAgents.length > 0) {
      logger.info({ salesAgentCount: salesAgents.length }, 'Starting property crawler');
      this.crawler.startPeriodicCrawl(salesAgents, 60); // Crawl every 60 minutes
    }

    this.server = this.app.listen(port, () => {
      logger.info({
        port,
        webUi: `http://localhost:${port}`,
        api: `http://localhost:${port}/api/agents`,
      }, 'AdCP Registry HTTP server running');
    });

    // Setup graceful shutdown handlers
    this.setupShutdownHandlers();
  }

  /**
   * Setup graceful shutdown handlers for SIGTERM and SIGINT
   */
  private setupShutdownHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');
      await this.stop();
      process.exit(0);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    logger.info('Stopping HTTP server');

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) {
            logger.error({ err }, "Error closing HTTP server");
            reject(err);
          } else {
            logger.info("HTTP server closed");
            resolve();
          }
        });
      });
    }

    // Close database connection
    logger.info('Closing database connection');
    await closeDatabase();
    logger.info('Database connection closed');

    logger.info('Graceful shutdown complete');
  }

  private async prewarmCaches(agents: any[]): Promise<void> {
    await Promise.all(
      agents.map(async (agent) => {
        try {
          // Warm health and stats caches
          await Promise.all([
            this.healthChecker.checkHealth(agent),
            this.healthChecker.getStats(agent),
            this.capabilityDiscovery.discoverCapabilities(agent),
          ]);

          // Warm type-specific caches
          if (agent.type === "sales") {
            await this.propertiesService.getPropertiesForAgent(agent);
          }
        } catch (error) {
          // Errors are expected for offline agents, just continue
        }
      })
    );
  }
}

