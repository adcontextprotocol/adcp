/**
 * Public Registry API routes.
 *
 * Extracted from http.ts. Every route is registered with both Express
 * and the OpenAPI registry so the spec can never drift from the code.
 */

import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import { CreativeAgentClient, SingleAgentClient } from "@adcp/client";
import type { Agent, AgentType, AgentWithStats } from "../types.js";
import { isValidAgentType } from "../types.js";
import { MemberDatabase } from "../db/member-db.js";
import * as manifestRefsDb from "../db/manifest-refs-db.js";
import { bulkResolveRateLimiter, brandCreationRateLimiter } from "../middleware/rate-limit.js";
import { createLogger } from "../logger.js";
import {
  registry,
  ResolvedBrandSchema,
  ResolvedPropertySchema,
  BrandRegistryItemSchema,
  PropertyRegistryItemSchema,
  FederatedAgentWithDetailsSchema,
  FederatedPublisherSchema,
  DomainLookupResultSchema,
  ValidationResultSchema,
  PublisherPropertySelectorSchema,
  PropertyIdentifierSchema,
  ErrorSchema,
} from "../schemas/registry.js";

import type { BrandManager } from "../brand-manager.js";
import type { BrandDatabase } from "../db/brand-db.js";
import type { PropertyDatabase } from "../db/property-db.js";
import type { AdAgentsManager } from "../adagents-manager.js";
import type { HealthChecker } from "../health.js";
import type { CrawlerService } from "../crawler.js";
import type { CapabilityDiscovery } from "../capabilities.js";

const logger = createLogger("registry-api");

// ── Config ──────────────────────────────────────────────────────

export interface RegistryApiConfig {
  brandManager: BrandManager;
  brandDb: BrandDatabase;
  propertyDb: PropertyDatabase;
  adagentsManager: AdAgentsManager;
  healthChecker: HealthChecker;
  crawler: CrawlerService;
  capabilityDiscovery: CapabilityDiscovery;
  registryRequestsDb: {
    trackRequest(type: string, domain: string): Promise<void>;
    markResolved(type: string, domain: string, resolved: string): Promise<boolean>;
  };
  requireAuth?: RequestHandler;
}

// ── Helpers ─────────────────────────────────────────────────────

function extractPublisherStats(result: { valid: boolean; raw_data?: any }) {
  let agentCount = 0;
  let propertyCount = 0;
  let tagCount = 0;
  let propertyTypeCounts: Record<string, number> = {};

  if (result.valid && result.raw_data) {
    agentCount = result.raw_data.authorized_agents?.length || 0;
    propertyCount = result.raw_data.properties?.length || 0;
    tagCount = Object.keys(result.raw_data.tags || {}).length;

    const properties = result.raw_data.properties || [];
    for (const prop of properties) {
      const propType = prop.property_type || "unknown";
      propertyTypeCounts[propType] = (propertyTypeCounts[propType] || 0) + 1;
    }
  }

  return { agentCount, propertyCount, tagCount, propertyTypeCounts };
}

// ── OpenAPI path registrations ──────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api",
  operationId: "apiDiscovery",
  summary: "API discovery",
  description: "Returns links to the main API entry points and documentation.",
  tags: ["Search"],
  responses: {
    200: { description: "API discovery information", content: { "application/json": { schema: z.object({ name: z.string(), version: z.string(), documentation: z.string(), openapi: z.string(), endpoints: z.record(z.string(), z.string()) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/brands/resolve",
  operationId: "resolveBrand",
  summary: "Resolve brand",
  description:
    "Resolve a domain to its canonical brand identity. Follows brand.json redirects and returns the resolved brand with its house, architecture type, and optional manifest.",
  tags: ["Brand Resolution"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "acmecorp.com" }),
      fresh: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: { description: "Brand resolved successfully", content: { "application/json": { schema: ResolvedBrandSchema } } },
    404: { description: "Brand not found", content: { "application/json": { schema: z.object({ error: z.string(), domain: z.string(), file_status: z.number().optional().openapi({ description: "HTTP status code from brand.json fetch (e.g. 404 vs 200 with invalid data)" }) }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/brands/resolve/bulk",
  operationId: "resolveBrandsBulk",
  summary: "Bulk resolve brands",
  description:
    "Resolve up to 100 domains to their canonical brand identities in a single request.\n\n**Rate limit:** 20 requests per minute per IP address.",
  tags: ["Brand Resolution"],
  request: {
    body: { content: { "application/json": { schema: z.object({ domains: z.array(z.string()).max(100) }) } } },
  },
  responses: {
    200: { description: "Bulk resolution results", content: { "application/json": { schema: z.object({ results: z.record(z.string(), ResolvedBrandSchema.nullable()) }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/brands/brand-json",
  operationId: "getBrandJson",
  summary: "Get brand.json",
  description: "Fetch the raw brand.json file for a domain.",
  tags: ["Brand Resolution"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "acmecorp.com" }),
      fresh: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: { description: "Raw brand.json data", content: { "application/json": { schema: z.object({ domain: z.string(), url: z.string(), variant: z.string().optional(), data: z.record(z.string(), z.unknown()), warnings: z.array(z.string()).optional() }) } } },
    404: { description: "Brand not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/brands/save",
  operationId: "saveBrand",
  summary: "Save brand",
  description:
    "Save or update a brand in the registry. Requires authentication. For existing brands, creates a revision-tracked edit. For new brands, creates the brand directly. Cannot edit authoritative brands managed via brand.json.",
  tags: ["Brand Resolution"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domain: z.string().openapi({ example: "acmecorp.com" }),
            brand_name: z.string().openapi({ example: "Acme Corp" }),
            brand_manifest: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Brand saved or updated",
      content: {
        "application/json": {
          schema: z.object({
            success: z.literal(true),
            message: z.string(),
            domain: z.string(),
            id: z.string(),
            revision_number: z.number().int().optional(),
          }),
        },
      },
    },
    400: { description: "Missing required fields or invalid domain", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot edit authoritative brand", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/brands/registry",
  operationId: "listBrands",
  summary: "List brands",
  description: "List all brands in the registry with optional search, pagination.",
  tags: ["Brand Resolution"],
  request: {
    query: z.object({
      search: z.string().optional(),
      limit: z.string().optional().openapi({ example: "100" }),
      offset: z.string().optional().openapi({ example: "0" }),
    }),
  },
  responses: {
    200: {
      description: "Brand list with stats",
      content: {
        "application/json": {
          schema: z.object({
            brands: z.array(BrandRegistryItemSchema),
            stats: z.object({
              total: z.number().int(),
              brand_json: z.number().int(),
              hosted: z.number().int(),
              community: z.number().int(),
              enriched: z.number().int(),
            }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/brands/enrich",
  operationId: "enrichBrand",
  summary: "Enrich brand",
  description: "Enrich brand data using Brandfetch. Returns logo, colors, and company information.",
  tags: ["Brand Resolution"],
  request: { query: z.object({ domain: z.string().openapi({ example: "acmecorp.com" }) }) },
  responses: {
    200: { description: "Enrichment data from Brandfetch", content: { "application/json": { schema: z.object({}).passthrough() } } },
    503: { description: "Brandfetch not configured", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// Property Resolution
registry.registerPath({
  method: "get",
  path: "/api/properties/resolve",
  operationId: "resolveProperty",
  summary: "Resolve property",
  description:
    "Resolve a publisher domain to its property information. Checks hosted properties, discovered properties, then live adagents.json validation.",
  tags: ["Property Resolution"],
  request: { query: z.object({ domain: z.string().openapi({ example: "examplepub.com" }) }) },
  responses: {
    200: { description: "Property resolved", content: { "application/json": { schema: ResolvedPropertySchema } } },
    404: { description: "Property not found", content: { "application/json": { schema: z.object({ error: z.string(), domain: z.string() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/properties/resolve/bulk",
  operationId: "resolvePropertiesBulk",
  summary: "Bulk resolve properties",
  description:
    "Resolve up to 100 publisher domains at once.\n\n**Rate limit:** 20 requests per minute per IP address.",
  tags: ["Property Resolution"],
  request: {
    body: { content: { "application/json": { schema: z.object({ domains: z.array(z.string()).max(100) }) } } },
  },
  responses: {
    200: { description: "Bulk resolution results", content: { "application/json": { schema: z.object({ results: z.record(z.string(), ResolvedPropertySchema.nullable()) }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/properties/registry",
  operationId: "listProperties",
  summary: "List properties",
  description: "List all properties in the registry with optional search, pagination.",
  tags: ["Property Resolution"],
  request: {
    query: z.object({
      search: z.string().optional(),
      limit: z.string().optional().openapi({ example: "100" }),
      offset: z.string().optional().openapi({ example: "0" }),
    }),
  },
  responses: {
    200: { description: "Property list with stats", content: { "application/json": { schema: z.object({ properties: z.array(PropertyRegistryItemSchema), stats: z.record(z.string(), z.unknown()) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/properties/validate",
  operationId: "validateProperty",
  summary: "Validate adagents.json",
  description: "Validate a domain's adagents.json file and return the validation result.",
  tags: ["Property Resolution"],
  request: { query: z.object({ domain: z.string().openapi({ example: "examplepub.com" }) }) },
  responses: {
    200: { description: "Validation result", content: { "application/json": { schema: ValidationResultSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/properties/save",
  operationId: "saveProperty",
  summary: "Save property",
  description:
    "Save or update a hosted property in the registry. Requires authentication. For existing properties, creates a revision-tracked edit. For new properties, creates the property directly. Cannot edit authoritative properties managed via adagents.json.",
  tags: ["Property Resolution"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            publisher_domain: z.string().openapi({ example: "examplepub.com" }),
            authorized_agents: z.array(z.object({ url: z.string(), authorized_for: z.string().optional() })).openapi({ example: [{ url: "https://agent.example.com" }] }),
            properties: z.array(z.object({ type: z.string(), name: z.string() })).optional().openapi({ example: [{ type: "website", name: "Example Publisher" }] }),
            contact: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Property saved or updated",
      content: {
        "application/json": {
          schema: z.object({
            success: z.literal(true),
            message: z.string(),
            id: z.string(),
            revision_number: z.number().int().optional(),
          }),
        },
      },
    },
    400: { description: "Missing required fields or invalid domain", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot edit authoritative property", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// Agent Discovery
registry.registerPath({
  method: "get",
  path: "/api/registry/agents",
  operationId: "listAgents",
  summary: "List agents",
  description:
    "List all registered and discovered agents. Optionally enrich with health checks, capabilities, and property summaries via query parameters.",
  tags: ["Agent Discovery"],
  request: {
    query: z.object({
      type: z.enum(["creative", "signals", "sales", "governance", "si", "unknown"]).optional(),
      health: z.enum(["true"]).optional(),
      capabilities: z.enum(["true"]).optional(),
      properties: z.enum(["true"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Agent list",
      content: {
        "application/json": {
          schema: z.object({
            agents: z.array(FederatedAgentWithDetailsSchema),
            count: z.number().int(),
            sources: z.object({ registered: z.number().int(), discovered: z.number().int() }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/publishers",
  operationId: "listPublishers",
  summary: "List publishers",
  description: "List all registered and discovered publishers.",
  tags: ["Agent Discovery"],
  responses: {
    200: {
      description: "Publisher list",
      content: {
        "application/json": {
          schema: z.object({
            publishers: z.array(FederatedPublisherSchema),
            count: z.number().int(),
            sources: z.object({ registered: z.number().int(), discovered: z.number().int() }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/stats",
  operationId: "getRegistryStats",
  summary: "Registry statistics",
  description: "Get aggregate statistics about the registry.",
  tags: ["Agent Discovery"],
  responses: {
    200: { description: "Registry statistics", content: { "application/json": { schema: z.object({}).passthrough() } } },
  },
});

// Lookups & Authorization
registry.registerPath({
  method: "get",
  path: "/api/registry/lookup/domain/{domain}",
  operationId: "lookupDomain",
  summary: "Domain lookup",
  description: "Find all agents authorized for a given publisher domain.",
  tags: ["Lookups & Authorization"],
  request: { params: z.object({ domain: z.string().openapi({ example: "examplepub.com" }) }) },
  responses: {
    200: { description: "Domain lookup result", content: { "application/json": { schema: DomainLookupResultSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/lookup/property",
  operationId: "lookupProperty",
  summary: "Property identifier lookup",
  description: "Find agents that hold a specific property identifier.",
  tags: ["Lookups & Authorization"],
  request: { query: z.object({ type: z.string(), value: z.string() }) },
  responses: {
    200: { description: "Matching agents", content: { "application/json": { schema: z.object({ type: z.string(), value: z.string(), agents: z.array(z.unknown()), count: z.number().int() }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/lookup/agent/{agentUrl}/domains",
  operationId: "getAgentDomains",
  summary: "Agent domain lookup",
  description: "Get all publisher domains associated with an agent.",
  tags: ["Lookups & Authorization"],
  request: { params: z.object({ agentUrl: z.string() }) },
  responses: {
    200: { description: "Domains for the agent", content: { "application/json": { schema: z.object({ agent_url: z.string(), domains: z.array(z.string()), count: z.number().int() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/validate/product-authorization",
  operationId: "validateProductAuthorization",
  summary: "Validate product authorization",
  description:
    "Check whether an agent is authorized to sell a product based on its publisher_properties.",
  tags: ["Lookups & Authorization"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            publisher_properties: z.array(PublisherPropertySelectorSchema),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Authorization validation result", content: { "application/json": { schema: z.object({ agent_url: z.string(), authorized: z.boolean(), checked_at: z.string() }).passthrough() } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/expand/product-identifiers",
  operationId: "expandProductIdentifiers",
  summary: "Expand product identifiers",
  description: "Expand publisher_properties selectors into concrete property identifiers for caching.",
  tags: ["Lookups & Authorization"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            publisher_properties: z.array(PublisherPropertySelectorSchema),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Expanded identifiers",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            properties: z.array(z.unknown()),
            identifiers: z.array(z.object({ type: z.string(), value: z.string(), property_id: z.string(), publisher_domain: z.string() })),
            property_count: z.number().int(),
            identifier_count: z.number().int(),
            generated_at: z.string(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/validate/property-authorization",
  operationId: "validatePropertyAuthorization",
  summary: "Property authorization check",
  description: "Quick check if a property identifier is authorized for an agent. Optimized for real-time ad request validation.",
  tags: ["Lookups & Authorization"],
  request: {
    query: z.object({
      agent_url: z.string(),
      identifier_type: z.string(),
      identifier_value: z.string(),
    }),
  },
  responses: {
    200: { description: "Authorization result", content: { "application/json": { schema: z.object({ agent_url: z.string(), identifier_type: z.string(), identifier_value: z.string(), authorized: z.boolean(), checked_at: z.string() }).passthrough() } } },
  },
});

// Validation Tools
registry.registerPath({
  method: "post",
  path: "/api/adagents/validate",
  operationId: "validateAdagents",
  summary: "Validate adagents.json",
  description: "Validate a domain's adagents.json file and optionally validate referenced agent cards.",
  tags: ["Validation Tools"],
  request: { body: { content: { "application/json": { schema: z.object({ domain: z.string() }) } } } },
  responses: {
    200: { description: "Validation result", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.object({ domain: z.string(), found: z.boolean(), validation: z.unknown(), agent_cards: z.unknown().optional() }), timestamp: z.string() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/adagents/create",
  operationId: "createAdagents",
  summary: "Generate adagents.json",
  description: "Generate a valid adagents.json file from a list of authorized agents.",
  tags: ["Validation Tools"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            authorized_agents: z.array(z.object({ url: z.string(), authorized_for: z.string().optional() })),
            include_schema: z.boolean().optional(),
            include_timestamp: z.boolean().optional(),
            properties: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Generated adagents.json", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.object({ success: z.boolean(), adagents_json: z.unknown(), validation: z.unknown() }), timestamp: z.string() }) } } },
  },
});

// Search
registry.registerPath({
  method: "get",
  path: "/api/search",
  operationId: "search",
  summary: "Search",
  description: "Search across brands, publishers, and properties. Returns up to 5 results per category.",
  tags: ["Search"],
  request: { query: z.object({ q: z.string().min(2) }) },
  responses: {
    200: { description: "Search results", content: { "application/json": { schema: z.object({ brands: z.array(z.unknown()), publishers: z.array(z.unknown()), properties: z.array(z.unknown()) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/manifest-refs/lookup",
  operationId: "lookupManifestRef",
  summary: "Manifest reference lookup",
  description: "Find the best manifest reference (brand.json URL or agent) for a domain.",
  tags: ["Search"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "acmecorp.com" }),
      type: z.string().optional().openapi({ example: "brand.json" }),
    }),
  },
  responses: {
    200: {
      description: "Reference lookup result",
      content: {
        "application/json": {
          schema: z.discriminatedUnion("success", [
            z.object({ success: z.literal(true), found: z.literal(true), reference: z.object({ reference_type: z.enum(["url", "agent"]), manifest_url: z.string().nullable(), agent_url: z.string().nullable(), agent_id: z.string().nullable(), verification_status: z.enum(["pending", "valid", "invalid", "unreachable"]) }) }),
            z.object({ success: z.literal(false), found: z.literal(false) }),
          ]),
        },
      },
    },
  },
});

// Agent Probing
registry.registerPath({
  method: "get",
  path: "/api/public/discover-agent",
  operationId: "discoverAgent",
  summary: "Discover agent",
  description: "Probe an agent URL to discover its name, type, supported protocols, and basic statistics.",
  tags: ["Agent Probing"],
  request: { query: z.object({ url: z.string() }) },
  responses: {
    200: { description: "Discovered agent info", content: { "application/json": { schema: z.object({ name: z.string(), description: z.string().optional(), protocols: z.array(z.string()), type: z.string(), stats: z.object({ format_count: z.number().int().optional(), product_count: z.number().int().optional(), publisher_count: z.number().int().optional() }) }) } } },
    504: { description: "Connection timeout", content: { "application/json": { schema: z.object({ error: z.string(), message: z.string() }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/public/agent-formats",
  operationId: "getAgentFormats",
  summary: "Get agent formats",
  description: "Fetch creative formats from a creative agent.",
  tags: ["Agent Probing"],
  request: { query: z.object({ url: z.string() }) },
  responses: {
    200: { description: "Creative formats", content: { "application/json": { schema: z.object({ success: z.boolean(), formats: z.array(z.unknown()) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/public/agent-products",
  operationId: "getAgentProducts",
  summary: "Get agent products",
  description: "Fetch products from a sales agent.",
  tags: ["Agent Probing"],
  request: { query: z.object({ url: z.string() }) },
  responses: {
    200: { description: "Products", content: { "application/json": { schema: z.object({ success: z.boolean(), products: z.array(z.unknown()) }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/public/validate-publisher",
  operationId: "validatePublisher",
  summary: "Validate publisher",
  description: "Validate a publisher domain's adagents.json and return summary statistics.",
  tags: ["Agent Probing"],
  request: { query: z.object({ domain: z.string().openapi({ example: "examplepub.com" }) }) },
  responses: {
    200: {
      description: "Publisher validation result",
      content: {
        "application/json": {
          schema: z.object({
            valid: z.boolean(),
            domain: z.string(),
            url: z.string().optional(),
            agent_count: z.number().int(),
            property_count: z.number().int(),
            property_type_counts: z.record(z.string(), z.number().int()),
            tag_count: z.number().int(),
            errors: z.array(z.string()).optional(),
            warnings: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
});

// ── Router factory ──────────────────────────────────────────────

export function createRegistryApiRouter(config: RegistryApiConfig): Router {
  const router = Router();
  const {
    brandManager,
    brandDb,
    propertyDb,
    adagentsManager,
    healthChecker,
    crawler,
    capabilityDiscovery,
    registryRequestsDb,
    requireAuth: authMiddleware,
  } = config;

  // ── API Discovery ─────────────────────────────────────────────

  router.get("/", (_req, res) => {
    res.json({
      name: "AgenticAdvertising.org Registry API",
      version: "1.0.0",
      documentation: "https://docs.adcontextprotocol.org/docs/registry/index",
      openapi: "https://agenticadvertising.org/openapi/registry.yaml",
      endpoints: {
        brands: "/api/brands/registry",
        properties: "/api/properties/registry",
        agents: "/api/registry/agents",
        search: "/api/search",
      },
    });
  });

  // ── Brand Resolution ──────────────────────────────────────────

  router.get("/brands/registry", async (req, res) => {
    try {
      const brands = await brandDb.getAllBrandsForRegistry({
        search: req.query.search as string,
        limit: req.query.limit ? Math.min(parseInt(req.query.limit as string), 5000) : undefined,
        offset: parseInt(req.query.offset as string) || 0,
      });

      const stats = {
        total: brands.length,
        brand_json: brands.filter((b) => b.source === "brand_json").length,
        hosted: brands.filter((b) => b.source === "hosted").length,
        community: brands.filter((b) => b.source === "community").length,
        enriched: brands.filter((b) => b.source === "enriched").length,
      };

      return res.json({ brands, stats });
    } catch (error) {
      logger.error({ error }, "Failed to list brands");
      return res.status(500).json({ error: "Failed to list brands" });
    }
  });

  router.get("/brands/resolve", async (req, res) => {
    try {
      const domain = req.query.domain as string;
      const fresh = req.query.fresh === "true";
      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }

      const resolved = await brandManager.resolveBrand(domain, { skipCache: fresh });
      if (!resolved) {
        const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
        if (discovered) {
          registryRequestsDb
            .markResolved("brand", domain, discovered.canonical_domain || discovered.domain)
            .catch((err) => logger.debug({ err }, "Registry request tracking failed"));
          return res.json({
            canonical_id: discovered.canonical_domain || discovered.domain,
            canonical_domain: discovered.canonical_domain || discovered.domain,
            brand_name: discovered.brand_name,
            source: discovered.source_type,
            brand_manifest: discovered.brand_manifest,
          });
        }
        registryRequestsDb
          .trackRequest("brand", domain)
          .catch((err) => logger.debug({ err }, "Registry request tracking failed"));

        const validation = await brandManager.validateDomain(domain);
        return res.status(404).json({
          error: "Brand not found",
          domain,
          file_status: validation.status_code,
        });
      }

      registryRequestsDb
        .markResolved("brand", domain, resolved.canonical_domain)
        .catch((err) => logger.debug({ err }, "Registry request tracking failed"));
      return res.json(resolved);
    } catch (error) {
      logger.error({ error }, "Failed to resolve brand");
      return res.status(500).json({ error: "Failed to resolve brand" });
    }
  });

  router.get("/brands/brand-json", async (req, res) => {
    try {
      const domain = ((req.query.domain as string) || "").toLowerCase();
      const fresh = req.query.fresh === "true";
      const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
      if (!domain || !domainPattern.test(domain)) {
        return res.status(400).json({ error: "Invalid domain format" });
      }

      const result = await brandManager.validateDomain(domain, { skipCache: fresh });

      if (!result.valid || !result.raw_data) {
        return res.status(404).json({
          error: "Brand not found or invalid",
          domain,
          errors: result.errors,
        });
      }

      return res.json({
        domain: result.domain,
        url: result.url,
        variant: result.variant,
        data: result.raw_data,
        warnings: result.warnings,
      });
    } catch (error) {
      logger.error({ error }, "Failed to fetch brand.json");
      return res.status(500).json({ error: "Failed to fetch brand data" });
    }
  });

  router.get("/brands/enrich", async (req, res) => {
    try {
      const domain = req.query.domain as string;
      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }

      const { fetchBrandData, isBrandfetchConfigured } = await import("../services/brandfetch.js");
      if (!isBrandfetchConfigured()) {
        return res.status(503).json({ error: "Brandfetch not configured" });
      }

      const enrichment = await fetchBrandData(domain);
      return res.json(enrichment);
    } catch (error) {
      logger.error({ error }, "Failed to enrich brand");
      return res.status(500).json({ error: "Failed to enrich brand" });
    }
  });

  router.post("/brands/resolve/bulk", bulkResolveRateLimiter, async (req, res) => {
    try {
      const { domains } = req.body;

      if (!Array.isArray(domains) || domains.length === 0) {
        return res.status(400).json({ error: "domains array required" });
      }
      if (domains.length > 100) {
        return res.status(400).json({ error: "Maximum 100 domains per request" });
      }
      if (!domains.every((d: unknown) => typeof d === "string" && d.length > 0)) {
        return res.status(400).json({ error: "All domains must be non-empty strings" });
      }

      const CONCURRENCY = 10;
      const results: Record<string, unknown> = {};
      const uniqueDomains = [...new Set(domains.map((d: string) => d.toLowerCase()))];

      for (let i = 0; i < uniqueDomains.length; i += CONCURRENCY) {
        const batch = uniqueDomains.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (domain) => {
            const resolved = await brandManager.resolveBrand(domain);
            if (resolved) {
              registryRequestsDb.markResolved("brand", domain, resolved.canonical_domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
              return { domain, result: resolved };
            }

            const discovered = await brandDb.getDiscoveredBrandByDomain(domain);
            if (discovered) {
              registryRequestsDb.markResolved("brand", domain, discovered.canonical_domain || discovered.domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
              return {
                domain,
                result: {
                  canonical_id: discovered.canonical_domain || discovered.domain,
                  canonical_domain: discovered.canonical_domain || discovered.domain,
                  brand_name: discovered.brand_name,
                  source: discovered.source_type,
                  brand_manifest: discovered.brand_manifest,
                },
              };
            }

            registryRequestsDb.trackRequest("brand", domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
            return { domain, result: null };
          })
        );

        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            results[outcome.value.domain] = outcome.value.result;
          }
        }
      }

      return res.json({ results });
    } catch (error) {
      logger.error({ error }, "Failed to bulk resolve brands");
      return res.status(500).json({ error: "Failed to bulk resolve brands" });
    }
  });

  const saveMiddleware = authMiddleware ? [authMiddleware, brandCreationRateLimiter] : [brandCreationRateLimiter];

  router.post("/brands/save", ...saveMiddleware, async (req, res) => {
    try {
      const { brand_name, brand_manifest } = req.body;
      const rawDomain = req.body.domain as string;

      if (!rawDomain || typeof rawDomain !== "string") {
        return res.status(400).json({ error: "domain is required" });
      }
      if (!brand_name || typeof brand_name !== "string") {
        return res.status(400).json({ error: "brand_name is required" });
      }

      const domain = rawDomain.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\/$/, "").toLowerCase();
      const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
      if (!domainPattern.test(domain)) {
        return res.status(400).json({ error: "Invalid domain format" });
      }

      const existing = await brandDb.getDiscoveredBrandByDomain(domain);

      if (existing) {
        if (existing.source_type === "brand_json") {
          return res.status(409).json({
            error: "Cannot edit authoritative brand (managed via brand.json)",
            domain,
          });
        }

        const editInput: Parameters<typeof brandDb.editDiscoveredBrand>[1] = {
          brand_name,
          edit_summary: "API: updated brand data",
          editor_user_id: req.user!.id,
          editor_email: req.user!.email,
          editor_name: `${req.user!.firstName || ""} ${req.user!.lastName || ""}`.trim() || req.user!.email,
        };
        if (brand_manifest !== undefined) {
          editInput.brand_manifest = brand_manifest;
          editInput.has_brand_manifest = !!brand_manifest;
        }

        const { brand, revision_number } = await brandDb.editDiscoveredBrand(domain, editInput);

        return res.json({
          success: true,
          message: `Brand "${brand_name}" updated in registry (revision ${revision_number})`,
          domain: brand.domain,
          id: brand.id,
          revision_number,
        });
      }

      const saved = await brandDb.upsertDiscoveredBrand({
        domain,
        brand_name,
        brand_manifest,
        has_brand_manifest: brand_manifest !== undefined ? !!brand_manifest : undefined,
        source_type: "community",
      });

      return res.json({
        success: true,
        message: `Brand "${brand_name}" saved to registry`,
        domain: saved.domain,
        id: saved.id,
      });
    } catch (error) {
      logger.error({ error }, "Failed to save brand");
      return res.status(500).json({ error: "Failed to save brand" });
    }
  });

  // ── Property Resolution ───────────────────────────────────────

  router.get("/properties/registry", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 5000);
      const offset = parseInt(req.query.offset as string) || 0;
      const search = req.query.search as string;

      const [properties, stats] = await Promise.all([
        propertyDb.getAllPropertiesForRegistry({ search, limit, offset }),
        propertyDb.getPropertyRegistryStats(search),
      ]);

      return res.json({ properties, stats });
    } catch (error) {
      logger.error({ error }, "Failed to list properties");
      return res.status(500).json({ error: "Failed to list properties" });
    }
  });

  router.get("/properties/resolve", async (req, res) => {
    try {
      const domain = req.query.domain as string;
      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }

      // Check hosted first
      const hosted = await propertyDb.getHostedPropertyByDomain(domain);
      if (hosted && hosted.is_public) {
        registryRequestsDb.markResolved("property", domain, hosted.publisher_domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
        return res.json({
          publisher_domain: hosted.publisher_domain,
          source: "hosted",
          authorized_agents: hosted.adagents_json.authorized_agents,
          properties: hosted.adagents_json.properties,
          contact: hosted.adagents_json.contact,
          verified: hosted.domain_verified,
        });
      }

      // Check discovered
      const discovered = await propertyDb.getDiscoveredPropertiesByDomain(domain);
      if (discovered.length > 0) {
        registryRequestsDb.markResolved("property", domain, domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
        const agents = await propertyDb.getAgentAuthorizationsForDomain(domain);
        return res.json({
          publisher_domain: domain,
          source: "adagents_json",
          authorized_agents: [...new Set(agents.map((a) => a.agent_url))].map((url) => ({ url })),
          properties: discovered.map((p) => ({
            id: p.property_id,
            type: p.property_type,
            name: p.name,
            identifiers: p.identifiers,
            tags: p.tags,
          })),
          verified: true,
        });
      }

      // Try live validation
      const validation = await adagentsManager.validateDomain(domain);
      if (validation.valid && validation.raw_data) {
        registryRequestsDb.markResolved("property", domain, domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
        return res.json({
          publisher_domain: domain,
          source: "adagents_json",
          authorized_agents: validation.raw_data.authorized_agents,
          properties: validation.raw_data.properties,
          contact: validation.raw_data.contact,
          verified: true,
        });
      }

      registryRequestsDb.trackRequest("property", domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
      return res.status(404).json({ error: "Property not found", domain });
    } catch (error) {
      logger.error({ error }, "Failed to resolve property");
      return res.status(500).json({ error: "Failed to resolve property" });
    }
  });

  router.get("/properties/validate", async (req, res) => {
    try {
      const domain = req.query.domain as string;
      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }

      const validation = await adagentsManager.validateDomain(domain);
      return res.json(validation);
    } catch (error) {
      logger.error({ error }, "Failed to validate property");
      return res.status(500).json({ error: "Failed to validate" });
    }
  });

  router.post("/properties/resolve/bulk", bulkResolveRateLimiter, async (req, res) => {
    try {
      const { domains } = req.body;

      if (!Array.isArray(domains) || domains.length === 0) {
        return res.status(400).json({ error: "domains array required" });
      }
      if (domains.length > 100) {
        return res.status(400).json({ error: "Maximum 100 domains per request" });
      }
      if (!domains.every((d: unknown) => typeof d === "string" && d.length > 0)) {
        return res.status(400).json({ error: "All domains must be non-empty strings" });
      }

      const CONCURRENCY = 10;
      const results: Record<string, unknown> = {};
      const uniqueDomains = [...new Set(domains.map((d: string) => d.toLowerCase()))];

      for (let i = 0; i < uniqueDomains.length; i += CONCURRENCY) {
        const batch = uniqueDomains.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (domain) => {
            const hosted = await propertyDb.getHostedPropertyByDomain(domain);
            if (hosted && hosted.is_public) {
              registryRequestsDb.markResolved("property", domain, hosted.publisher_domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
              return {
                domain,
                result: {
                  publisher_domain: hosted.publisher_domain,
                  source: "hosted",
                  authorized_agents: hosted.adagents_json.authorized_agents,
                  properties: hosted.adagents_json.properties,
                  verified: hosted.domain_verified,
                },
              };
            }

            const discovered = await propertyDb.getDiscoveredPropertiesByDomain(domain);
            if (discovered.length > 0) {
              registryRequestsDb.markResolved("property", domain, domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
              const agents = await propertyDb.getAgentAuthorizationsForDomain(domain);
              return {
                domain,
                result: {
                  publisher_domain: domain,
                  source: "adagents_json",
                  authorized_agents: [...new Set(agents.map((a) => a.agent_url))].map((url) => ({ url })),
                  properties: discovered.map((p) => ({
                    id: p.property_id,
                    type: p.property_type,
                    name: p.name,
                  })),
                  verified: true,
                },
              };
            }

            registryRequestsDb.trackRequest("property", domain).catch((err) => logger.debug({ err }, "Registry request tracking failed"));
            return { domain, result: null };
          })
        );

        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            results[outcome.value.domain] = outcome.value.result;
          }
        }
      }

      return res.json({ results });
    } catch (error) {
      logger.error({ error }, "Failed to bulk resolve properties");
      return res.status(500).json({ error: "Failed to bulk resolve properties" });
    }
  });

  router.post("/properties/save", ...saveMiddleware, async (req, res) => {
    try {
      const { authorized_agents, properties, contact } = req.body;
      const rawDomain = req.body.publisher_domain as string;

      if (!rawDomain || typeof rawDomain !== "string") {
        return res.status(400).json({ error: "publisher_domain is required" });
      }
      if (!Array.isArray(authorized_agents)) {
        return res.status(400).json({ error: "authorized_agents array is required" });
      }

      const publisher_domain = rawDomain.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\/$/, "").toLowerCase();
      const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
      if (!domainPattern.test(publisher_domain)) {
        return res.status(400).json({ error: "Invalid domain format" });
      }

      const adagentsJson: Record<string, unknown> = {
        $schema: "https://adcontextprotocol.org/schemas/v1/adagents.json",
        authorized_agents,
        properties: properties || [],
      };
      if (contact) {
        adagentsJson.contact = contact;
      }

      const existing = await propertyDb.getHostedPropertyByDomain(publisher_domain);

      if (existing) {
        const discovered = await propertyDb.getDiscoveredPropertiesByDomain(publisher_domain);
        if (discovered.length > 0) {
          return res.status(409).json({
            error: "Cannot edit authoritative property (managed via adagents.json)",
            domain: publisher_domain,
          });
        }

        const { property, revision_number } = await propertyDb.editCommunityProperty(publisher_domain, {
          adagents_json: adagentsJson,
          edit_summary: "API: updated property data",
          editor_user_id: req.user!.id,
          editor_email: req.user!.email,
          editor_name: `${req.user!.firstName || ""} ${req.user!.lastName || ""}`.trim() || req.user!.email,
        });

        return res.json({
          success: true,
          message: `Property "${publisher_domain}" updated in registry (revision ${revision_number})`,
          id: property.id,
          revision_number,
        });
      }

      const saved = await propertyDb.createHostedProperty({
        publisher_domain,
        adagents_json: adagentsJson,
        source_type: "community",
      });

      return res.json({
        success: true,
        message: `Hosted property created for ${publisher_domain}`,
        id: saved.id,
      });
    } catch (error) {
      logger.error({ error }, "Failed to save property");
      return res.status(500).json({ error: "Failed to save property" });
    }
  });

  // ── Validation Tools ──────────────────────────────────────────

  router.post("/adagents/validate", async (req, res) => {
    try {
      const { domain } = req.body;

      if (!domain || domain.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: "Domain is required",
          timestamp: new Date().toISOString(),
        });
      }

      logger.info({ domain }, "Validating adagents.json for domain");
      const validation = await adagentsManager.validateDomain(domain);

      let agentCards = undefined;
      if (validation.valid && validation.raw_data?.authorized_agents?.length > 0) {
        logger.info({ agentCount: validation.raw_data.authorized_agents.length }, "Validating agent cards");
        agentCards = await adagentsManager.validateAgentCards(validation.raw_data.authorized_agents);
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
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to validate domain:");
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  });

  router.post("/adagents/create", async (req, res) => {
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
          error: "authorized_agents array is required",
          timestamp: new Date().toISOString(),
        });
      }

      if (authorized_agents.length === 0) {
        return res.status(400).json({
          success: false,
          error: "At least one authorized agent is required",
          timestamp: new Date().toISOString(),
        });
      }

      logger.info({ agentCount: authorized_agents.length, propertyCount: properties?.length || 0 }, "Creating adagents.json");

      const validation = adagentsManager.validateProposed(authorized_agents);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          error: `Validation failed: ${validation.errors.map((e: any) => e.message).join(", ")}`,
          timestamp: new Date().toISOString(),
        });
      }

      const adagentsJson = adagentsManager.createAdAgentsJson(
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
      logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to create adagents.json:");
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ── Search ────────────────────────────────────────────────────

  router.get("/search", async (req, res) => {
    const q = ((req.query.q as string) || "").trim();
    if (q.length < 2) {
      return res.status(400).json({ error: "Query must be at least 2 characters" });
    }

    try {
      const [brands, properties, members] = await Promise.all([
        brandDb.getAllBrandsForRegistry({ search: q, limit: 5 }),
        propertyDb.getAllPropertiesForRegistry({ search: q, limit: 5 }),
        new MemberDatabase().getPublicProfiles({}),
      ]);

      const qLower = q.toLowerCase();
      const publishers = members
        .flatMap((m) =>
          (m.publishers || [])
            .filter((p) => p.is_public)
            .map((p) => ({
              domain: p.domain,
              member: { display_name: m.display_name },
            }))
        )
        .filter(
          (p) =>
            p.domain.toLowerCase().includes(qLower) ||
            p.member.display_name?.toLowerCase().includes(qLower)
        )
        .slice(0, 5);

      return res.json({ brands, publishers, properties });
    } catch (error) {
      logger.error({ error }, "Search failed");
      return res.status(500).json({ error: "Search failed" });
    }
  });

  router.get("/manifest-refs/lookup", async (req, res) => {
    try {
      const domain = req.query.domain as string;
      const manifestType = (req.query.type || "brand.json") as manifestRefsDb.ManifestType;

      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }

      const ref = await manifestRefsDb.getBestReference(domain, manifestType);
      if (!ref) {
        return res.json({ success: false, found: false });
      }

      return res.json({
        success: true,
        found: true,
        reference: {
          reference_type: ref.reference_type,
          manifest_url: ref.manifest_url,
          agent_url: ref.agent_url,
          agent_id: ref.agent_id,
          verification_status: ref.verification_status,
        },
      });
    } catch (error) {
      logger.error({ error }, "Failed to lookup manifest ref");
      return res.status(500).json({ error: "Failed to lookup reference" });
    }
  });

  // ── Agent Discovery (registry) ────────────────────────────────

  router.get("/registry/agents", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const type = req.query.type as AgentType | undefined;
      const withHealth = req.query.health === "true";
      const withCapabilities = req.query.capabilities === "true";
      const withProperties = req.query.properties === "true";

      const federatedAgents = await federatedIndex.listAllAgents(type);

      const agents = federatedAgents.map((fa) => ({
        name: fa.name || fa.url,
        url: fa.url,
        type: isValidAgentType(fa.type) ? fa.type : ("unknown" as const),
        protocol: fa.protocol || "mcp",
        description: fa.member?.display_name || fa.discovered_from?.publisher_domain || "",
        mcp_endpoint: fa.url,
        contact: {
          name: fa.member?.display_name || "",
          email: "",
          website: "",
        },
        added_date: fa.discovered_at || new Date().toISOString().split("T")[0],
        source: fa.source,
        member: fa.member,
        discovered_from: fa.discovered_from,
      }));

      const bySource = {
        registered: federatedAgents.filter((a) => a.source === "registered").length,
        discovered: federatedAgents.filter((a) => a.source === "discovered").length,
      };

      if (!withHealth && !withCapabilities && !withProperties) {
        return res.json({ agents, count: agents.length, sources: bySource });
      }

      const enriched = await Promise.all(
        agents.map(async (agent): Promise<AgentWithStats> => {
          const enrichedAgent: AgentWithStats = { ...agent } as AgentWithStats;

          if (withCapabilities) {
            const capProfile = await capabilityDiscovery.discoverCapabilities(agent as Agent);
            if (capProfile) {
              enrichedAgent.capabilities = {
                tools_count: capProfile.discovered_tools?.length || 0,
                tools: capProfile.discovered_tools || [],
                standard_operations: capProfile.standard_operations,
                creative_capabilities: capProfile.creative_capabilities,
                signals_capabilities: capProfile.signals_capabilities,
                discovery_error: capProfile.discovery_error,
                oauth_required: capProfile.oauth_required,
              };

              if (!enrichedAgent.type || enrichedAgent.type === "unknown") {
                const inferredType = capabilityDiscovery.inferTypeFromProfile(capProfile);
                if (inferredType !== "unknown") {
                  enrichedAgent.type = inferredType;
                }
              }
            }
          }

          const promises = [];

          if (withHealth) {
            promises.push(
              healthChecker.checkHealth(agent as Agent),
              healthChecker.getStats(agent as Agent)
            );
          }

          if (withProperties && enrichedAgent.type === "sales") {
            promises.push(
              federatedIndex.getPropertiesForAgent(agent.url),
              federatedIndex.getPublisherDomainsForAgent(agent.url)
            );
          }

          const results = await Promise.all(promises);
          let resultIndex = 0;

          if (withHealth) {
            enrichedAgent.health = results[resultIndex++] as any;
            enrichedAgent.stats = results[resultIndex++] as any;
          }

          if (withProperties && enrichedAgent.type === "sales") {
            const agentProperties = results[resultIndex++] as any[];
            const publisherDomains = results[resultIndex++] as string[];

            if (agentProperties && agentProperties.length > 0) {
              enrichedAgent.publisher_domains = publisherDomains;

              const countByType: Record<string, number> = {};
              for (const prop of agentProperties) {
                const t = prop.property_type || "unknown";
                countByType[t] = (countByType[t] || 0) + 1;
              }

              const allTags = new Set<string>();
              for (const prop of agentProperties) {
                for (const tag of prop.tags || []) {
                  allTags.add(tag);
                }
              }

              enrichedAgent.property_summary = {
                total_count: agentProperties.length,
                count_by_type: countByType,
                tags: Array.from(allTags),
                publisher_count: publisherDomains.length,
              };
            }
          }

          return enrichedAgent;
        })
      );

      res.json({ agents: enriched, count: enriched.length, sources: bySource });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list agents" });
    }
  });

  router.get("/registry/publishers", async (_req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const publishers = await federatedIndex.listAllPublishers();
      const bySource = {
        registered: publishers.filter((p) => p.source === "registered").length,
        discovered: publishers.filter((p) => p.source === "discovered").length,
      };
      res.json({ publishers, count: publishers.length, sources: bySource });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list publishers" });
    }
  });

  router.get("/registry/stats", async (_req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const stats = await federatedIndex.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to get registry stats" });
    }
  });

  // ── Lookups & Authorization ───────────────────────────────────

  router.get("/registry/lookup/domain/:domain", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const domain = req.params.domain;
      const result = await federatedIndex.lookupDomain(domain);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Domain lookup failed" });
    }
  });

  router.get("/registry/lookup/property", async (req, res) => {
    const { type, value } = req.query;

    if (!type || !value) {
      return res.status(400).json({ error: "Missing required query params: type and value" });
    }

    try {
      const federatedIndex = crawler.getFederatedIndex();
      const results = await federatedIndex.findAgentsForPropertyIdentifier(type as string, value as string);
      res.json({ type, value, agents: results, count: results.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Property lookup failed" });
    }
  });

  router.get("/registry/lookup/agent/:agentUrl/domains", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const agentUrl = decodeURIComponent(req.params.agentUrl);
      const domains = await federatedIndex.getDomainsForAgent(agentUrl);
      res.json({ agent_url: agentUrl, domains, count: domains.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Agent domain lookup failed" });
    }
  });

  router.post("/registry/validate/product-authorization", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const { agent_url, publisher_properties } = req.body;

      if (!agent_url) {
        return res.status(400).json({ error: "Missing required field: agent_url" });
      }

      if (!publisher_properties || !Array.isArray(publisher_properties)) {
        return res.status(400).json({ error: "Missing required field: publisher_properties (array of selectors)" });
      }

      const result = await federatedIndex.validateAgentForProduct(agent_url, publisher_properties);
      res.json({ agent_url, ...result, checked_at: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Product authorization validation failed" });
    }
  });

  router.post("/registry/expand/product-identifiers", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const { agent_url, publisher_properties } = req.body;

      if (!agent_url) {
        return res.status(400).json({ error: "Missing required field: agent_url" });
      }

      if (!publisher_properties || !Array.isArray(publisher_properties)) {
        return res.status(400).json({ error: "Missing required field: publisher_properties (array of selectors)" });
      }

      const expandedProperties = await federatedIndex.expandPublisherPropertiesToIdentifiers(agent_url, publisher_properties);

      const allIdentifiers: Array<{ type: string; value: string; property_id: string; publisher_domain: string }> = [];
      for (const prop of expandedProperties) {
        for (const identifier of prop.identifiers) {
          allIdentifiers.push({
            type: identifier.type,
            value: identifier.value,
            property_id: prop.property_id,
            publisher_domain: prop.publisher_domain,
          });
        }
      }

      res.json({
        agent_url,
        properties: expandedProperties,
        identifiers: allIdentifiers,
        property_count: expandedProperties.length,
        identifier_count: allIdentifiers.length,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Property expansion failed" });
    }
  });

  router.get("/registry/validate/property-authorization", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const { agent_url, identifier_type, identifier_value } = req.query;

      if (!agent_url || !identifier_type || !identifier_value) {
        return res.status(400).json({ error: "Missing required query params: agent_url, identifier_type, identifier_value" });
      }

      const result = await federatedIndex.isPropertyAuthorizedForAgent(
        agent_url as string,
        identifier_type as string,
        identifier_value as string
      );

      res.json({
        agent_url,
        identifier_type,
        identifier_value,
        ...result,
        checked_at: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Property authorization check failed" });
    }
  });

  // ── Agent Probing ─────────────────────────────────────────────

  router.get("/public/discover-agent", async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      const client = new SingleAgentClient({
        id: "discovery",
        name: "discovery-client",
        agent_uri: url,
        protocol: "mcp",
      });

      const agentInfo = await client.getAgentInfo();
      const tools = agentInfo.tools || [];

      let agentType = "unknown";
      const toolNames = tools.map((t: { name: string }) => t.name.toLowerCase());
      if (toolNames.some((n: string) => n.includes("get_product") || n.includes("media_buy") || n.includes("create_media"))) {
        agentType = "sales";
      } else if (toolNames.some((n: string) => n.includes("signal") || n.includes("audience"))) {
        agentType = "signals";
      } else if (toolNames.some((n: string) => n.includes("creative") || n.includes("format") || n.includes("preview"))) {
        agentType = "creative";
      }

      const hostname = new URL(url).hostname;
      const agentName = agentInfo.name && agentInfo.name !== "discovery-client" ? agentInfo.name : hostname;

      const protocols: string[] = [agentInfo.protocol];
      try {
        if (agentInfo.protocol === "mcp") {
          const a2aUrl = new URL("/.well-known/agent.json", url).toString();
          const a2aResponse = await fetch(a2aUrl, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(3000),
          });
          if (a2aResponse.ok) {
            protocols.push("a2a");
          }
        }
      } catch {
        // Ignore A2A check failures
      }

      let stats: { format_count?: number; product_count?: number; publisher_count?: number } = {};

      if (agentType === "creative") {
        try {
          const creativeClient = new CreativeAgentClient({ agentUrl: url });
          const formats = await creativeClient.listFormats();
          stats.format_count = formats.length;
        } catch (statsError) {
          logger.debug({ err: statsError, url }, "Failed to fetch creative formats");
          stats.format_count = 0;
        }
      } else if (agentType === "sales") {
        stats.product_count = 0;
        stats.publisher_count = 0;
        try {
          const result = await client.getProducts({ brief: "" });
          if (result.data?.products) {
            stats.product_count = result.data.products.length;
          }
        } catch (statsError) {
          logger.debug({ err: statsError, url }, "Failed to fetch products");
        }
      }

      return res.json({ name: agentName, description: agentInfo.description, protocols, type: agentType, stats });
    } catch (error) {
      logger.error({ err: error, url }, "Public agent discovery error");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout", message: "Agent did not respond within 10 seconds" });
      }

      return res.status(500).json({ error: "Agent discovery failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  router.get("/public/agent-formats", async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      const creativeClient = new CreativeAgentClient({ agentUrl: url });
      const formats = await creativeClient.listFormats();

      return res.json({
        success: true,
        formats: formats.map((format) => {
          const formatWithAssets = format as typeof format & { assets?: unknown };
          return {
            format_id: format.format_id,
            name: format.name,
            type: format.type,
            description: format.description,
            preview_image: format.preview_image,
            example_url: format.example_url,
            renders: format.renders,
            assets_required: format.assets_required,
            assets: formatWithAssets.assets,
            output_format_ids: format.output_format_ids,
            agent_url: format.agent_url,
          };
        }),
      });
    } catch (error) {
      logger.error({ err: error, url }, "Agent formats fetch error");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout", message: "Agent did not respond within the timeout period" });
      }

      return res.status(500).json({ error: "Failed to fetch formats", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  router.get("/public/agent-products", async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      const client = new SingleAgentClient({
        id: "products-discovery",
        name: "products-discovery-client",
        agent_uri: url,
        protocol: "mcp",
      });

      const result = await client.getProducts({ brief: "" });
      const products = result.data?.products || [];

      return res.json({
        success: true,
        products: products.map((p: any) => ({
          product_id: p.product_id,
          name: p.name,
          description: p.description,
          property_type: p.property_type,
          property_name: p.property_name,
          pricing_model: p.pricing_model,
          base_rate: p.base_rate,
          currency: p.currency,
          format_ids: p.format_ids,
          delivery_channels: p.delivery_channels,
          targeting_capabilities: p.targeting_capabilities,
        })),
      });
    } catch (error) {
      logger.error({ err: error, url }, "Agent products fetch error");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout", message: "Agent did not respond within the timeout period" });
      }

      return res.status(500).json({ error: "Failed to fetch products", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  router.get("/public/validate-publisher", async (req, res) => {
    const { domain } = req.query;

    if (!domain || typeof domain !== "string") {
      return res.status(400).json({ error: "Domain is required" });
    }

    try {
      const result = await adagentsManager.validateDomain(domain);
      const stats = extractPublisherStats(result);

      return res.json({
        valid: result.valid,
        domain: result.domain,
        url: result.url,
        agent_count: stats.agentCount,
        property_count: stats.propertyCount,
        property_type_counts: stats.propertyTypeCounts,
        tag_count: stats.tagCount,
        errors: result.errors,
        warnings: result.warnings,
      });
    } catch (error) {
      logger.error({ err: error, domain }, "Public publisher validation error");

      return res.status(500).json({ error: "Publisher validation failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  return router;
}
