/**
 * Public Registry API routes.
 *
 * Extracted from http.ts. Every route is registered with both Express
 * and the OpenAPI registry so the spec can never drift from the code.
 */

import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import escapeHtml from "escape-html";
import { CreativeAgentClient, SingleAgentClient, exchangeClientCredentials, ClientCredentialsExchangeError } from "@adcp/sdk";
import { runStoryboardStep, getComplianceStoryboardById, getFirstStepPreview, testCapabilityDiscovery, resolveStoryboardsForCapabilities, loadComplianceIndex } from "@adcp/sdk/testing";
import type { Agent, AgentType, AgentWithStats } from "../types.js";
import { isValidAgentType } from "../types.js";
import { MemberDatabase } from "../db/member-db.js";
import { query } from "../db/client.js";
import { resolvePrimaryOrganization } from "../db/users-db.js";
import * as manifestRefsDb from "../db/manifest-refs-db.js";
import { isUuid } from "../utils/uuid.js";
import { bulkResolveRateLimiter, brandCreationRateLimiter, storyboardEvalRateLimiter, storyboardStepRateLimiter, agentReadRateLimiter } from "../middleware/rate-limit.js";
import { listStoryboards, getStoryboard, getTestKitForStoryboard } from "../services/storyboards.js";
import {
  comply,
  complianceResultToDbInput,
  classifyCapabilityResolutionError,
  presentCapabilityResolutionError,
  computeSpecialismStatus,
} from "../addie/services/compliance-testing.js";
import { getPublicJwks } from "../services/verification-token.js";
import { renderBadgeSvg, VALID_BADGE_ROLES } from "../services/badge-svg.js";
import { resolveOwnerMembership } from "../services/membership-tiers.js";
import { inferDiagnosticAgentType } from "../lib/diagnostic-agent-type-inference.js";
import { isValidAdcpVersionShape } from "../services/adcp-taxonomy.js";
import { buildAaoVerificationBlock } from "../services/aao-verification-enrichment.js";
import { PUBLIC_TEST_AGENT } from "../config/test-agent.js";
import * as policiesDb from "../db/policies-db.js";
import { createLogger } from "../logger.js";
import { validateCrawlDomain, validateExternalUrl } from "../utils/url-security.js";
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
  FindCompanyResultSchema,
  BrandActivitySchema,
  PropertyActivitySchema,
  PolicySchema,
  PolicySummarySchema,
  PolicyHistorySchema,
  OperatorLookupResultSchema,
  PublisherLookupResultSchema,
  AgentComplianceDetailSchema,
  AgentVerificationSchema,
  StoryboardStatusSchema,
  RegistryMetadataSchema,
  MonitoringSettingsSchema,
  ComplianceRunSchema,
  OutboundRequestSchema,
  AgentAuthStatusSchema,
  CredentialSaveValidationErrorSchema,
  StoryboardSummarySchema,
  StoryboardDetailSchema,
} from "../schemas/registry.js";

import type { BrandManager } from "../brand-manager.js";
import type { BrandDatabase } from "../db/brand-db.js";
import type { PropertyDatabase } from "../db/property-db.js";
import { CatalogDatabase } from "../db/catalog-db.js";
import type { AdAgentsManager } from "../adagents-manager.js";
import type { HealthChecker } from "../health.js";
import type { CrawlerService } from "../crawler.js";
import type { CapabilityDiscovery } from "../capabilities.js";
import { AAO_HOST, aaoHostedBrandJsonUrl } from "../config/aao.js";
import { fetchBrandData, isBrandfetchConfigured, ENRICHMENT_CACHE_MAX_AGE_MS } from "../services/brandfetch.js";
import { PropertyCheckService } from "../services/property-check.js";
import { PropertyCheckDatabase } from "../db/property-check-db.js";
import { BulkPropertyCheckService } from "../services/bulk-property-check.js";
import { ComplianceDatabase, type LifecycleStage } from "../db/compliance-db.js";
import { AgentSnapshotDatabase } from "../db/agent-snapshot-db.js";
import { resolveUserAgentAuth } from "./helpers/resolve-user-agent-auth.js";
import { adaptAuthForSdk } from "../services/sdk-auth-adapter.js";
import { parseOAuthClientCredentialsInput } from "./helpers/oauth-client-credentials-input.js";
import { isOAuthRequiredErrorMessage } from "./helpers/oauth-error-detection.js";
import { AgentContextDatabase } from "../db/agent-context-db.js";
import { getRequestLog, getRequestCount } from "../db/outbound-log-db.js";
import { enrichUserWithMembership } from "../utils/html-config.js";
import { classifyProbeError } from "../utils/probe-error.js";
import { OrganizationDatabase, hasApiAccess, resolveMembershipTier } from "../db/organization-db.js";
import { resolveCallerOrgId } from "./helpers/resolve-caller-org.js";
import { canonicalizeAgentUrl } from "../db/publisher-db.js";
import {
  AuthorizationSnapshotDatabase,
  EvidenceValidationError,
  IncludeValidationError,
  parseEvidenceParam,
  parseIncludeParam,
} from "../db/authorization-snapshot-db.js";
import { createHash } from "crypto";
import { createGzip, constants as zlibConstants } from "zlib";

const logger = createLogger("registry-api");
const propertyCheckService = new PropertyCheckService();
const propertyCheckDb = new PropertyCheckDatabase();
const bulkCheckService = new BulkPropertyCheckService();
const complianceDb = new ComplianceDatabase();
const agentSnapshotDb = new AgentSnapshotDatabase();
const agentContextDb = new AgentContextDatabase();

/** Strip protocol, path, query, and fragment from a URL to extract the domain. */
function extractDomain(raw: string): string {
  let d = raw.replace(/^https?:\/\//, "");
  const pathIdx = d.search(/[/?#]/);
  if (pathIdx !== -1) d = d.substring(0, pathIdx);
  if (d.endsWith("/")) d = d.slice(0, -1);
  return d.toLowerCase();
}

const VALID_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && VALID_DOMAIN_RE.test(domain);
}

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
  eventsDb?: {
    queryFeed(cursor: string | null, types: string[] | null, limit?: number): Promise<import('../db/catalog-events-db.js').FeedResult | import('../db/catalog-events-db.js').FeedError>;
  };
  profilesDb?: {
    search(query: import('../db/agent-inventory-profiles-db.js').SearchQuery): Promise<import('../db/agent-inventory-profiles-db.js').SearchResponse>;
  };
  requireAuth?: RequestHandler;
  optionalAuth?: RequestHandler;
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
  security: [{ bearerAuth: [] }, { oauth2: [] }],
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
  description: "List all brands in the registry with optional search, pagination, and source filter.",
  tags: ["Brand Resolution"],
  request: {
    query: z.object({
      search: z.string().optional(),
      limit: z.string().optional().openapi({ type: 'integer', example: 100 }),
      offset: z.string().optional().openapi({ type: 'integer', example: 0 }),
      source: z.enum(['hosted', 'brand_json', 'enriched', 'community']).optional().openapi({
        description: 'Filter by source. Values match the per-brand source field in the response: hosted = registered by domain owner via /api/brands; brand_json = crawler-discovered with a live /.well-known/brand.json; enriched = Brandfetch-sourced; community = manually contributed.',
      }),
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
              hosted: z.number().int(),
              brand_json: z.number().int(),
              community: z.number().int(),
              enriched: z.number().int(),
              houses: z.number().int(),
              sub_brands: z.number().int(),
              with_manifest: z.number().int(),
            }),
          }),
        },
      },
    },
    400: {
      description: "Invalid source filter value",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/brands/history",
  operationId: "getBrandHistory",
  summary: "Brand activity history",
  description: "Returns the edit history for a brand in the registry, newest first. Only brands with community or enriched edits have history; brand.json-sourced brands are authoritative and do not generate revisions.",
  tags: ["Brand Resolution"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "acmecorp.com" }),
      limit: z.string().optional().openapi({ type: 'integer', example: 20 }),
      offset: z.string().optional().openapi({ type: 'integer', example: 0 }),
    }),
  },
  responses: {
    200: { description: "Brand activity history", content: { "application/json": { schema: BrandActivitySchema } } },
    400: { description: "domain parameter required", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Brand not found", content: { "application/json": { schema: z.object({ error: z.string(), domain: z.string() }) } } },
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

registry.registerPath({
  method: "get",
  path: "/api/properties/history",
  operationId: "getPropertyHistory",
  summary: "Property activity history",
  description: "Returns the edit history for a property in the registry, newest first.",
  tags: ["Property Resolution"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "examplepub.com" }),
      limit: z.string().optional().openapi({ type: 'integer', example: 20 }),
      offset: z.string().optional().openapi({ type: 'integer', example: 0 }),
    }),
  },
  responses: {
    200: { description: "Property activity history", content: { "application/json": { schema: PropertyActivitySchema } } },
    400: { description: "domain parameter required", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Property not found", content: { "application/json": { schema: z.object({ error: z.string(), domain: z.string() }) } } },
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
      limit: z.string().optional().openapi({ type: 'integer', example: 100 }),
      offset: z.string().optional().openapi({ type: 'integer', example: 0 }),
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
  security: [{ bearerAuth: [] }, { oauth2: [] }],
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

registry.registerPath({
  method: "post",
  path: "/api/properties/check",
  operationId: "checkPropertyList",
  summary: "Check property list",
  description:
    "Check a list of publisher domains against the AAO registry. Normalizes domains (strips www/m prefixes), removes duplicates, flags known ad tech infrastructure, and identifies domains not yet in the registry.\n\nReturns four buckets:\n- **remove**: duplicates or known blocked domains (ad servers, CDNs, trackers, intermediaries)\n- **modify**: domains that were normalized (e.g. www.example.com → example.com)\n- **assess**: unknown domains not in registry, not blocked\n- **ok**: domains found in registry with no changes needed\n\nResults are stored for 7 days and retrievable via the `report_id`.",
  tags: ["Property Resolution"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domains: z.array(z.string()).max(10000).openapi({ example: ["www.nytimes.com", "googlesyndication.com", "wsj.com"] }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Property list check results",
      content: {
        "application/json": {
          schema: z.object({
            summary: z.object({ total: z.number().int(), remove: z.number().int(), modify: z.number().int(), assess: z.number().int(), ok: z.number().int() }),
            remove: z.array(z.object({ input: z.string(), canonical: z.string(), reason: z.enum(["duplicate", "blocked"]), domain_type: z.string().optional(), blocked_reason: z.string().optional() })),
            modify: z.array(z.object({ input: z.string(), canonical: z.string(), reason: z.string() })),
            assess: z.array(z.object({ domain: z.string() })),
            ok: z.array(z.object({ domain: z.string(), source: z.string() })),
            report_id: z.string().openapi({ description: "UUID for retrieving this report later" }),
          }),
        },
      },
    },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/properties/check/{reportId}",
  operationId: "getPropertyCheckReport",
  summary: "Get property check report",
  description: "Retrieve a previously stored property check report by ID. Reports expire after 7 days.",
  tags: ["Property Resolution"],
  request: { params: z.object({ reportId: z.string() }) },
  responses: {
    200: { description: "Property check report", content: { "application/json": { schema: z.object({ summary: z.object({ total: z.number().int(), remove: z.number().int(), modify: z.number().int(), assess: z.number().int(), ok: z.number().int() }) }) } } },
    404: { description: "Report not found or expired", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// Agent Discovery
registry.registerPath({
  method: "get",
  path: "/api/registry/agents",
  operationId: "listAgents",
  summary: "List agents",
  description:
    "List all agents in the registry. Optionally enrich with health checks, capabilities, and property summaries via query parameters. " +
    "Measurement-vendor filters (`metric_id`, `accreditation`, `q`) imply `type=measurement` when `type` is unset; an explicit `type` other than `measurement` returns 400.",
  tags: ["Agent Discovery"],
  request: {
    query: z.object({
      type: z.enum(["brand", "rights", "measurement", "governance", "creative", "sales", "buying", "signals", "unknown"]).optional(),
      health: z.enum(["true"]).optional(),
      capabilities: z.enum(["true"]).optional(),
      properties: z.enum(["true"]).optional(),
      compliance: z.enum(["true"]).optional(),
      metric_id: z.union([z.string(), z.array(z.string())]).optional().openapi({
        description: "Measurement-vendor filter: exact match on `measurement.metrics[].metric_id`. Repeatable (each value is OR'd within the param, AND'd with other filters). Implies `type=measurement`.",
        example: "attention_units",
      }),
      accreditation: z.union([z.string(), z.array(z.string())]).optional().openapi({
        description: "Measurement-vendor filter: exact match on `measurement.metrics[].accreditations[].accrediting_body` (e.g. `MRC`, `JIC`, `ARF`). Repeatable. Implies `type=measurement`. Accreditation claims are vendor-asserted; AAO does not independently verify (`verified_by_aao` is always `false` in the response).",
        example: "MRC",
      }),
      q: z.string().max(64).optional().openapi({
        description: "Measurement-vendor filter: case-insensitive substring match against `measurement.metrics[].metric_id`. v1 scope: metric_id only (description/standard search is a follow-up). Max 64 chars; SQL wildcard characters are escaped. Implies `type=measurement`.",
        example: "attention",
      }),
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
          }),
        },
      },
    },
    400: { description: "Invalid query parameter", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/publishers",
  operationId: "listPublishers",
  summary: "List publishers",
  description: "List all registered publishers.",
  tags: ["Agent Discovery"],
  responses: {
    200: {
      description: "Publisher list",
      content: {
        "application/json": {
          schema: z.object({
            publishers: z.array(FederatedPublisherSchema),
            count: z.number().int(),
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
  tags: ["Authorization Lookups"],
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
  tags: ["Authorization Lookups"],
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
  tags: ["Authorization Lookups"],
  request: { params: z.object({ agentUrl: z.string() }) },
  responses: {
    200: { description: "Domains for the agent", content: { "application/json": { schema: z.object({ agent_url: z.string(), domains: z.array(z.string()), count: z.number().int() }) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/operator",
  operationId: "lookupOperator",
  summary: "Operator lookup",
  description:
    "Given a domain, returns the agents this entity operates and which publishers trust them.\n\n" +
    "**Response shape is auth-aware.** Anonymous callers see only `public` agents. " +
    "Authenticated callers on an AAO membership tier with API access also see `members_only` agents. " +
    "Profile owners (callers whose org owns the queried domain) additionally see `private` agents. " +
    "This is the primary mechanism by which AAO membership unlocks deeper registry visibility.",
  tags: ["Authorization Lookups"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "pubmatic.com" }),
    }),
  },
  responses: {
    200: { description: "Operator lookup result", content: { "application/json": { schema: OperatorLookupResultSchema } } },
    400: { description: "Missing domain", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/publisher",
  operationId: "lookupPublisher",
  summary: "Publisher lookup",
  description:
    "Given a domain, returns the inventory this entity publishes and which agents it authorizes.\n\n" +
    "**This endpoint is unauthenticated and returns the same response shape for every caller.** " +
    "Compare to `/api/registry/operator`, where AAO membership tier and profile ownership unlock " +
    "additional agent visibility (`members_only`, `private`). AAO membership does not change the " +
    "`/publisher` response today.",
  tags: ["Authorization Lookups"],
  request: {
    query: z.object({
      domain: z.string().openapi({ example: "voxmedia.com" }),
    }),
  },
  responses: {
    200: { description: "Publisher lookup result", content: { "application/json": { schema: PublisherLookupResultSchema } } },
    400: { description: "Missing domain", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/validate/product-authorization",
  operationId: "validateProductAuthorization",
  summary: "Validate product authorization",
  description:
    "Check whether an agent is authorized to sell a product based on its publisher_properties.",
  tags: ["Authorization Lookups"],
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
  tags: ["Authorization Lookups"],
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
  tags: ["Authorization Lookups"],
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

// ── Policy Registry ────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/policies/registry",
  operationId: "listPolicies",
  summary: "List policies",
  description:
    "Browse and search the governance policy registry. Returns approved policies with optional filtering by category, enforcement level, jurisdiction, policy category, and governance domain.",
  tags: ["Policy Registry"],
  request: {
    query: z.object({
      search: z.string().optional().openapi({ description: "Full-text search on policy name and description" }),
      category: z.enum(["regulation", "standard"]).optional(),
      enforcement: z.enum(["must", "should", "may"]).optional(),
      jurisdiction: z.string().optional().openapi({ example: "EU", description: "Filter by jurisdiction (includes region alias matching)" }),
      policy_category: z.string().optional().openapi({ example: "age_restricted" }),
      domain: z.string().optional().openapi({ example: "campaign", description: "Filter by governance domain" }),
      limit: z.string().optional().openapi({ type: 'integer', description: "Results per page (default 20, max 1000)" }),
      offset: z.string().optional().openapi({ type: 'integer', description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: {
      description: "Policy listing with facet stats",
      content: {
        "application/json": {
          schema: z.object({
            policies: z.array(PolicySummarySchema),
            stats: z.object({
              total: z.number().int(),
              regulation: z.number().int(),
              standard: z.number().int(),
            }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/policies/resolve",
  operationId: "resolvePolicy",
  summary: "Resolve policy",
  description:
    "Resolve a single policy by ID. Optionally pin to a specific version — returns null if the version does not match.",
  tags: ["Policy Registry"],
  request: {
    query: z.object({
      policy_id: z.string().openapi({ example: "gdpr_consent" }),
      version: z.string().optional().openapi({ description: "Return null if the current version does not match" }),
    }),
  },
  responses: {
    200: { description: "Policy resolved", content: { "application/json": { schema: PolicySchema } } },
    400: { description: "Missing policy_id", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Policy not found", content: { "application/json": { schema: z.object({ error: z.string(), policy_id: z.string() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/policies/resolve/bulk",
  operationId: "resolvePoliciesBulk",
  summary: "Bulk resolve policies",
  description:
    "Resolve up to 100 policies by ID in a single request. Returns a map of policy_id to Policy (or null if not found).\n\n**Rate limit:** 20 requests per minute per IP address.",
  tags: ["Policy Registry"],
  request: {
    body: { content: { "application/json": { schema: z.object({ policy_ids: z.array(z.string()).min(1).max(100).openapi({ example: ["gdpr_consent", "coppa_children"] }) }) } } },
  },
  responses: {
    200: { description: "Bulk resolution results", content: { "application/json": { schema: z.object({ results: z.record(z.string(), PolicySchema.nullable()) }) } } },
    400: { description: "Invalid request", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/policies/history",
  operationId: "getPolicyHistory",
  summary: "Policy revision history",
  description:
    "Retrieve the edit history for a policy. Each revision records who made the change, a summary, and whether it was a rollback.",
  tags: ["Policy Registry"],
  request: {
    query: z.object({
      policy_id: z.string().openapi({ example: "gdpr_consent" }),
      limit: z.string().optional().openapi({ type: 'integer', description: "Results per page (max 100, default 20)" }),
      offset: z.string().optional().openapi({ type: 'integer', description: "Pagination offset (default 0)" }),
    }),
  },
  responses: {
    200: { description: "Revision history", content: { "application/json": { schema: PolicyHistorySchema } } },
    400: { description: "Missing policy_id", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Policy not found", content: { "application/json": { schema: z.object({ error: z.string(), policy_id: z.string() }) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/policies/save",
  operationId: "savePolicy",
  summary: "Save policy",
  description:
    "Create or update a community-contributed policy. Requires authentication. Registry-sourced and pending-review policies cannot be edited (returns 409). Updates automatically create a revision record.",
  tags: ["Policy Registry"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            policy_id: z.string().openapi({ example: "my_brand_safety", description: "Lowercase alphanumeric with underscores" }),
            version: z.string().openapi({ example: "1.0.0" }),
            name: z.string().openapi({ example: "Acme Corp Brand Safety" }),
            category: z.enum(["regulation", "standard"]),
            enforcement: z.enum(["must", "should", "may"]),
            policy: z.string().openapi({ example: "Ads must not appear adjacent to content depicting violence..." }),
            description: z.string().optional(),
            jurisdictions: z.array(z.string()).optional(),
            region_aliases: z.record(z.string(), z.array(z.string())).optional(),
            policy_categories: z.array(z.string()).optional(),
            channels: z.array(z.string()).optional(),
            effective_date: z.string().optional(),
            sunset_date: z.string().optional(),
            governance_domains: z.array(z.string()).optional(),
            source_url: z.string().optional().openapi({ description: "Must use http:// or https://" }),
            source_name: z.string().optional(),
            guidance: z.string().optional(),
            exemplars: z.object({
              pass: z.array(z.object({ scenario: z.string(), explanation: z.string() })).optional(),
              fail: z.array(z.object({ scenario: z.string(), explanation: z.string() })).optional(),
            }).optional(),
            ext: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Policy saved",
      content: {
        "application/json": {
          schema: z.object({
            success: z.literal(true),
            message: z.string(),
            policy_id: z.string(),
            revision_number: z.number().int().nullable(),
          }),
        },
      },
    },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Cannot edit registry-sourced or pending policy", content: { "application/json": { schema: z.object({ error: z.string(), policy_id: z.string() }) } } },
    429: { description: "Rate limit exceeded", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// Change Feed & Sync
registry.registerPath({
  method: "get",
  path: "/api/registry/feed",
  operationId: "getRegistryFeed",
  summary: "Registry change feed",
  description:
    "Poll a cursor-based feed of registry changes. Events are ordered by UUID v7 event_id for monotonic cursor progression. The feed retains events for 90 days.\n\nType filtering supports glob patterns: `property.*` matches `property.created`, `property.updated`, etc.",
  tags: ["Change Feed"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: z.object({
      cursor: z.string().uuid().optional().openapi({ description: "Resume after this event ID" }),
      types: z.string().optional().openapi({ description: "Comma-separated event type filters with glob support (e.g. property.*)", example: "property.*,agent.*" }),
      limit: z.coerce.number().int().min(1).max(10000).optional().openapi({ description: "Max events per page (default 100, max 10,000)" }),
    }),
  },
  responses: {
    200: {
      description: "Feed page",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(z.object({
              event_id: z.string().uuid(),
              event_type: z.string().openapi({ example: "property.created" }),
              entity_type: z.string().openapi({ example: "property" }),
              entity_id: z.string(),
              payload: z.record(z.string(), z.unknown()),
              actor: z.string(),
              created_at: z.string().datetime(),
            })),
            cursor: z.string().uuid().nullable().openapi({ description: "Pass as cursor in the next request to continue polling" }),
            has_more: z.boolean(),
          }),
        },
      },
    },
    400: { description: "Invalid cursor format or type filter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    410: {
      description: "Cursor expired (older than 90-day retention window)",
      content: {
        "application/json": {
          schema: z.object({
            error: z.literal("cursor_expired"),
            message: z.string(),
          }),
        },
      },
    },
  },
});

// ── Authorization sync endpoints (PR 4b-snapshots of #3177) ──────────
// Spec: specs/registry-authorization-model.md:374-401
//
// Two read shapes for verification consumers:
//  1. /api/registry/authorizations — narrow per-agent pull (default for
//     most adopters; one agent's rows fit in a single JSON response).
//  2. /api/registry/authorizations/snapshot — bootstrap for inline
//     verifiers that maintain a local copy. Streams gzipped NDJSON so
//     memory stays bounded as the table grows toward long-run scale
//     (~5M rows, ~150-300 MB on the wire).
//
// X-Sync-Cursor on both responses is the change-feed position consumers
// tail from after applying the response. agent_claim is excluded by
// default (?evidence=adagents_json,agent_claim opt-in) per spec line 391.

const AuthorizationRowSchema = z.object({
  id: z.string().uuid(),
  agent_url: z.string(),
  agent_url_canonical: z.string(),
  property_rid: z.string().uuid().nullable(),
  property_id_slug: z.string().nullable(),
  publisher_domain: z.string().nullable(),
  authorized_for: z.string().nullable(),
  evidence: z.string(),
  disputed: z.boolean(),
  created_by: z.string().nullable(),
  expires_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  override_applied: z.boolean(),
  override_reason: z.string().nullable(),
});

registry.registerPath({
  method: "get",
  path: "/api/registry/authorizations",
  operationId: "getAgentAuthorizations",
  summary: "Per-agent authorization pull",
  description:
    "Default endpoint for verification consumers (DSPs, sales houses, agencies). " +
    "Returns the rows where the requested agent appears as `agent_url` — typically " +
    "≤ a few hundred. Pair with `/api/registry/feed?entity_type=authorization` to " +
    "tail subsequent changes via the `X-Sync-Cursor` header.\n\n" +
    "**evidence** defaults to `adagents_json` only. `agent_claim` is opt-in " +
    "(`?evidence=adagents_json,agent_claim`) to prevent buy-side trust " +
    "misuse — see specs/registry-authorization-model.md.",
  tags: ["Change Feed"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: z.object({
      agent_url: z.string().openapi({ description: "Agent URL to look up. Canonicalized server-side (lowercased, trailing slashes trimmed)." }),
      include: z.enum(["raw", "effective"]).optional().openapi({ description: "`effective` (default) applies override layer; `raw` reads base table." }),
      evidence: z.string().optional().openapi({ description: "Comma-separated evidence allowlist. Defaults to `adagents_json`.", example: "adagents_json,agent_claim" }),
    }),
  },
  responses: {
    200: {
      description: "Authorization rows for the agent.",
      headers: {
        "X-Sync-Cursor": {
          description: "UUIDv7 cursor for the authorization change feed at snapshot time. Pass to /api/registry/feed?entity_type=authorization&cursor=<value>.",
          schema: { type: "string" },
        },
      },
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            evidence: z.array(z.string()),
            include: z.enum(["raw", "effective"]),
            rows: z.array(AuthorizationRowSchema),
            count: z.number().int(),
          }),
        },
      },
    },
    400: { description: "Validation error (missing/empty agent_url, unknown evidence, unknown include)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/authorizations/snapshot",
  operationId: "getAgentAuthorizationsSnapshot",
  summary: "Bootstrap snapshot for inline verifiers",
  description:
    "Streams the full effective authorization set as gzipped NDJSON (one JSON " +
    "object per line). Consumers persist `X-Sync-Cursor` and tail " +
    "`/api/registry/feed?entity_type=authorization&cursor=<value>` for deltas.\n\n" +
    "**ETag** is the hash of the X-Sync-Cursor — clients can `If-None-Match` to " +
    "skip a re-pull when nothing has changed. **evidence** defaults to " +
    "`adagents_json` only; long-run wire size ~150 MB gzipped.",
  tags: ["Change Feed"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: z.object({
      include: z.enum(["raw", "effective"]).optional().openapi({ description: "`effective` (default) applies override layer; `raw` reads base table." }),
      evidence: z.string().optional().openapi({ description: "Comma-separated evidence allowlist. Defaults to `adagents_json`.", example: "adagents_json,agent_claim" }),
    }),
  },
  responses: {
    200: {
      description: "gzipped NDJSON stream — one authorization row per line.",
      headers: {
        "X-Sync-Cursor": {
          description: "UUIDv7 cursor for the authorization change feed at snapshot time.",
          schema: { type: "string" },
        },
        ETag: {
          description: "Hash of X-Sync-Cursor; clients can If-None-Match.",
          schema: { type: "string" },
        },
        "Content-Encoding": {
          description: "gzip",
          schema: { type: "string" },
        },
      },
      content: {
        "application/x-ndjson": {
          schema: z.string().openapi({ description: "Newline-delimited JSON, gzip-compressed." }),
        },
      },
    },
    304: { description: "Not modified — cursor unchanged from If-None-Match." },
    400: { description: "Validation error (unknown evidence, unknown include)", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/search",
  operationId: "searchAgentProfiles",
  summary: "Search agent inventory profiles",
  description:
    "Search agents by inventory profile — channels, markets, content categories, property types, and more. Filters use AND across dimensions and OR within a dimension. Results are ranked by relevance score.",
  tags: ["Agent Discovery"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: z.object({
      channels: z.string().optional().openapi({ description: "Comma-separated channel filter", example: "ctv,olv" }),
      property_types: z.string().optional().openapi({ description: "Comma-separated property type filter", example: "ctv_app,website" }),
      markets: z.string().optional().openapi({ description: "Comma-separated market/country code filter", example: "US,GB" }),
      categories: z.string().optional().openapi({ description: "Comma-separated IAB content category filter", example: "IAB-7,IAB-7-1" }),
      tags: z.string().optional().openapi({ description: "Comma-separated tag filter", example: "premium" }),
      delivery_types: z.string().optional().openapi({ description: "Comma-separated delivery type filter", example: "guaranteed,programmatic" }),
      has_tmp: z.enum(["true", "false"]).optional().openapi({ description: "Require TMP support" }),
      min_properties: z.coerce.number().int().min(0).optional().openapi({ description: "Minimum number of properties in inventory" }),
      cursor: z.string().optional().openapi({ description: "Pagination cursor from a previous response" }),
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ description: "Max results per page (default 50, max 200)" }),
    }),
  },
  responses: {
    200: {
      description: "Search results ranked by relevance",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(z.object({
              agent_url: z.string().url(),
              channels: z.array(z.string()),
              property_types: z.array(z.string()),
              markets: z.array(z.string()),
              categories: z.array(z.string()),
              tags: z.array(z.string()),
              delivery_types: z.array(z.string()),
              format_ids: z.array(z.unknown()).openapi({ description: "Creative format identifiers supported by this agent" }),
              property_count: z.number().int(),
              publisher_count: z.number().int(),
              has_tmp: z.boolean(),
              category_taxonomy: z.string().nullable(),
              relevance_score: z.number(),
              matched_filters: z.array(z.string()),
              updated_at: z.string().datetime(),
            })),
            cursor: z.string().nullable(),
            has_more: z.boolean(),
          }),
        },
      },
    },
    400: { description: "Invalid cursor or parameter", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/crawl-request",
  operationId: "requestCrawl",
  summary: "Request domain re-crawl",
  description:
    "Trigger an immediate re-crawl of a publisher domain after updating adagents.json. The crawl runs asynchronously — returns 202 immediately.\n\n**Rate limits:** 5 minutes per domain, 30 requests per user per hour.",
  tags: ["Agent Discovery"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domain: z.string().openapi({ example: "examplepub.com", description: "Publisher domain to re-crawl" }),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Crawl request accepted",
      content: {
        "application/json": {
          schema: z.object({
            message: z.literal("Crawl request accepted"),
            domain: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid domain format, private IP, or unresolvable domain", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    429: {
      description: "Rate limit exceeded",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            retry_after: z.number().int().openapi({ description: "Seconds to wait before retrying" }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/brand-crawl-request",
  operationId: "requestBrandCrawl",
  summary: "Request brand.json re-crawl",
  description:
    "Trigger an immediate re-crawl of a domain's brand.json. The crawl runs asynchronously — returns 202 immediately.\n\n**Rate limits:** 5 minutes per domain, 30 requests per user per hour (shared with adagents.json crawl requests).",
  tags: ["Brand Discovery"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domain: z.string().openapi({ example: "examplebrand.com", description: "Domain to re-crawl brand.json for" }),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Brand crawl request accepted",
      content: {
        "application/json": {
          schema: z.object({
            message: z.literal("Brand crawl request accepted"),
            domain: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid domain format, private IP, or unresolvable domain", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    429: {
      description: "Rate limit exceeded",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            retry_after: z.number().int().openapi({ description: "Seconds to wait before retrying" }),
          }),
        },
      },
    },
  },
});

// ── Agent Compliance ────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/compliance",
  operationId: "getAgentCompliance",
  summary: "Get agent compliance detail",
  description:
    "Returns detailed compliance status for a single agent, including track-level results, storyboard counts, and timestamps.\n\nIf the agent has opted out of compliance monitoring, returns a minimal response with `status: opted_out`.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL", example: "https%3A%2F%2Fexample.com%2Fmcp" }),
    }),
  },
  responses: {
    200: { description: "Compliance detail", content: { "application/json": { schema: AgentComplianceDetailSchema } } },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/.well-known/jwks.json",
  operationId: "getJwks",
  summary: "AAO public key set",
  description: "Returns the JSON Web Key Set (JWKS) containing AAO's public verification keys. Use these to verify AAO Verified badge tokens without calling AAO's API.",
  tags: ["Agent Compliance"],
  responses: {
    200: {
      description: "JWKS response",
      content: {
        "application/json": {
          schema: z.object({
            keys: z.array(z.record(z.string(), z.any())),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/verification",
  operationId: "getAgentVerification",
  summary: "Get agent AAO Verified status",
  description:
    "Returns AAO Verified badge status for a single agent. Public and cacheable. Includes role badges, verified storyboards, and a link to the agent's registry listing.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL", example: "https%3A%2F%2Fexample.com%2Fmcp" }),
    }),
  },
  responses: {
    200: { description: "Verification status", content: { "application/json": { schema: AgentVerificationSchema } } },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/badge/{role}.svg",
  operationId: "getAgentBadgeSvg",
  summary: "Get agent verification badge SVG",
  description: "Returns an SVG badge image for the specified agent and role. Shows 'AAO Verified | Sales Agent' (teal) when verified, or 'AAO Verified | Not Verified' (grey) when not. Cacheable, suitable for embedding in websites.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      role: z.string().openapi({ description: "Badge role (sales, buying, creative, governance, signals, measurement)" }),
    }),
  },
  responses: {
    200: { description: "SVG badge image", content: { "image/svg+xml": { schema: z.string() } } },
    400: { description: "Invalid agent URL" },
    500: { description: "Server error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/badge/{role}/embed",
  operationId: "getAgentBadgeEmbed",
  summary: "Get embeddable badge code",
  description: "Returns HTML and Markdown embed snippets for displaying an AAO Verified badge on websites, social profiles, and documentation. The badge links to the agent's AAO registry listing.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      role: z.string().openapi({ description: "Badge role" }),
    }),
  },
  responses: {
    200: {
      description: "Embed code",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            role: z.string(),
            badge_svg_url: z.string(),
            registry_url: z.string(),
            html: z.string(),
            markdown: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/badge/{role}/{version}.svg",
  operationId: "getAgentBadgeVersionedSvg",
  summary: "Get version-pinned agent verification badge SVG",
  description: "Returns an SVG badge image scoped to a specific AdCP release (MAJOR.MINOR, e.g. '3.0'). Buyers who want to call out 'verified for 3.0' embed this instead of the legacy `/badge/{role}.svg` (which auto-upgrades to the highest active version). Renders 'Not Verified' when the agent never earned a badge at this version.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      role: z.string().openapi({ description: "Badge role (media-buy, creative, signals, governance, brand, sponsored-intelligence)" }),
      version: z.string().openapi({ description: "AdCP release as MAJOR.MINOR (e.g. '3.0', '3.1')" }),
    }),
  },
  responses: {
    200: { description: "SVG badge image", content: { "image/svg+xml": { schema: z.string() } } },
    400: { description: "Invalid agent URL, role, or version", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/badge/{role}/{version}/embed",
  operationId: "getAgentBadgeVersionedEmbed",
  summary: "Get version-pinned embeddable badge code",
  description: "Returns HTML and Markdown embed snippets that point at the version-pinned SVG. Alt text includes the version (e.g. 'AAO Verified Media Buy Agent 3.0'). Buyers who want to freeze on a specific AdCP release embed these instead of the legacy `/badge/{role}/embed`.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      role: z.string().openapi({ description: "Badge role" }),
      version: z.string().openapi({ description: "AdCP release as MAJOR.MINOR" }),
    }),
  },
  responses: {
    200: {
      description: "Embed code",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            role: z.string(),
            verified: z.boolean(),
            adcp_version: z.string().optional(),
            badge_svg_url: z.string(),
            registry_url: z.string(),
            html: z.string(),
            markdown: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL, role, or version", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/storyboard-status",
  operationId: "getAgentStoryboardStatus",
  summary: "Get agent storyboard status",
  description:
    "Returns per-storyboard test results for an agent. Includes title, category, track, pass/fail status, and step counts.\n\n**Members only** — requires authentication and an active membership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL", example: "https%3A%2F%2Fexample.com%2Fmcp" }),
    }),
  },
  responses: {
    200: {
      description: "Storyboard status for the agent",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            storyboards: z.array(StoryboardStatusSchema),
            passing_count: z.number().int(),
            total_count: z.number().int(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Members only", content: { "application/json": { schema: z.object({ error: z.string(), members_only: z.boolean() }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/agents/storyboard-status",
  operationId: "bulkAgentStoryboardStatus",
  summary: "Bulk storyboard status",
  description:
    "Returns per-storyboard test results for multiple agents in a single request.\n\n**Members only** — requires authentication and an active membership. Maximum 100 agent URLs per request.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agent_urls: z.array(z.string()).max(100).openapi({ description: "Agent URLs to fetch storyboard status for" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Storyboard status keyed by agent URL",
      content: {
        "application/json": {
          schema: z.object({
            agents: z.record(z.string(), z.union([
              z.array(StoryboardStatusSchema),
              z.object({ status: z.literal("opted_out") }),
            ])),
            invalid_urls: z.number().int().optional().openapi({ description: "Count of invalid URLs that were skipped" }),
          }),
        },
      },
    },
    400: { description: "Invalid request body", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Members only", content: { "application/json": { schema: z.object({ error: z.string(), members_only: z.boolean() }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/compliance/history",
  operationId: "getAgentComplianceHistory",
  summary: "Get agent compliance history",
  description:
    "Returns a list of compliance test runs for an agent, ordered most recent first.\n\nIf the agent has opted out, returns an empty list.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    query: z.object({
      limit: z.string().optional().openapi({ description: "Max results (default 30, max 100)" }),
    }),
  },
  responses: {
    200: {
      description: "Compliance run history",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            runs: z.array(ComplianceRunSchema),
            count: z.number().int(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/registry/agents/{encodedUrl}/lifecycle",
  operationId: "updateAgentLifecycle",
  summary: "Update agent lifecycle stage",
  description:
    "Set the lifecycle stage for an agent. Requires authentication and ownership of the agent.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            lifecycle_stage: z.enum(["development", "testing", "production", "deprecated"]),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated metadata", content: { "application/json": { schema: RegistryMetadataSchema } } },
    400: { description: "Invalid agent URL or lifecycle stage", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/registry/agents/{encodedUrl}/compliance/opt-out",
  operationId: "updateAgentComplianceOptOut",
  summary: "Update compliance opt-out",
  description:
    "Opt an agent in or out of public compliance reporting. Requires authentication and ownership of the agent.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            opt_out: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated metadata", content: { "application/json": { schema: RegistryMetadataSchema } } },
    400: { description: "Invalid agent URL or opt_out value", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Agent Monitoring ────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/monitoring/settings",
  operationId: "getAgentMonitoringSettings",
  summary: "Get monitoring settings",
  description:
    "Returns the monitoring configuration for an agent. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
  },
  responses: {
    200: { description: "Monitoring settings", content: { "application/json": { schema: MonitoringSettingsSchema } } },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/registry/agents/{encodedUrl}/monitoring/pause",
  operationId: "updateAgentMonitoringPause",
  summary: "Pause or resume monitoring",
  description:
    "Pause or resume automated compliance monitoring for an agent. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            paused: z.boolean(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated monitoring settings", content: { "application/json": { schema: MonitoringSettingsSchema } } },
    400: { description: "Invalid agent URL or paused value", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/registry/agents/{encodedUrl}/monitoring/interval",
  operationId: "updateAgentMonitoringInterval",
  summary: "Update monitoring interval",
  description:
    "Set the check interval for automated compliance monitoring (6–168 hours). Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            interval_hours: z.number().int().min(6).max(168),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated monitoring settings", content: { "application/json": { schema: MonitoringSettingsSchema } } },
    400: { description: "Invalid agent URL or interval", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/monitoring/requests",
  operationId: "getAgentMonitoringRequests",
  summary: "Get outbound request log",
  description:
    "Returns the outbound request log for an agent (compliance checks, health probes, etc.). Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    query: z.object({
      limit: z.string().optional().openapi({ description: "Max results (default 50, max 200)" }),
      since: z.string().optional().openapi({ description: "ISO 8601 timestamp to filter from" }),
    }),
  },
  responses: {
    200: {
      description: "Outbound request log",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            requests: z.array(OutboundRequestSchema),
            count: z.number().int(),
            total: z.number().int(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Agent Auth & Connect ────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/auth-status",
  operationId: "getAgentAuthStatus",
  summary: "Get agent auth status",
  description:
    "Returns whether an agent has stored authentication credentials and OAuth token status. Requires authentication.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
  },
  responses: {
    200: { description: "Auth status", content: { "application/json": { schema: AgentAuthStatusSchema } } },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/registry/agents/{encodedUrl}/connect",
  operationId: "connectAgent",
  summary: "Connect agent credentials",
  description:
    "Store authentication credentials for an agent. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            auth_token: z.string().max(4096).optional().openapi({ description: "Bearer or basic auth token" }),
            auth_type: z.enum(["bearer", "basic"]).optional().openapi({ description: "Auth type (default: bearer)" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Connection result",
      content: {
        "application/json": {
          schema: z.object({
            connected: z.literal(true),
            has_auth: z.boolean(),
            agent_context_id: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/registry/agents/{encodedUrl}/oauth-client-credentials",
  operationId: "saveAgentOAuthClientCredentials",
  summary: "Save OAuth 2.0 client-credentials for an agent",
  description:
    "Store a machine-to-machine OAuth 2.0 client-credentials configuration (RFC 6749 §4.4) for this agent. The SDK exchanges at the token endpoint before every call and refreshes on 401. `client_secret` may be a `$ENV:VAR_NAME` reference — the SDK resolves at exchange time, the server stores it as written (encrypted uniformly). Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            token_endpoint: z.string().max(2048).openapi({ description: "Token endpoint URL (HTTPS required; localhost allowed in dev)." }),
            client_id: z.string().max(2048).openapi({ description: "OAuth client ID. May be a `$ENV:VAR_NAME` reference." }),
            client_secret: z.string().max(8192).openapi({ description: "OAuth client secret. May be a `$ENV:VAR_NAME` reference. Stored encrypted at rest." }),
            scope: z.string().max(1024).optional().openapi({ description: "Space-separated OAuth scope values." }),
            resource: z.string().max(2048).optional().openapi({ description: "RFC 8707 resource indicator." }),
            audience: z.string().max(2048).optional().openapi({ description: "Audience parameter for audience-validating authorization servers." }),
            auth_method: z.enum(["basic", "body"]).optional().openapi({ description: "Client-credentials placement: basic (HTTP Basic header, RFC 6749 §2.3.1 preferred) or body (form fields). SDK default is basic." }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Credentials saved",
      content: {
        "application/json": {
          schema: z.object({
            connected: z.literal(true),
            has_auth: z.literal(true),
            agent_context_id: z.string(),
            auth_type: z.literal("oauth_client_credentials"),
          }),
        },
      },
    },
    400: {
      description: "Invalid parameters — response carries `code` and `field` pointing to the rejection cause.",
      content: { "application/json": { schema: CredentialSaveValidationErrorSchema } },
    },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/agents/{encodedUrl}/oauth-client-credentials/test",
  operationId: "testAgentOAuthClientCredentials",
  summary: "Dry-run the saved OAuth 2.0 client-credentials config",
  description:
    "Exchange the saved client_credentials at the token endpoint and discard the resulting access token. Returns success + latency on a 2xx exchange, or the SDK's `ClientCredentialsExchangeError` kind (`oauth`, `malformed`, `network`) on failure so operators get same-second feedback instead of waiting for the next compliance heartbeat. Requires authentication and ownership. Requires credentials to already be saved via `PUT /oauth-client-credentials`.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
  },
  responses: {
    200: {
      description:
        "Result of the token exchange. `ok: true` on 2xx from the AS; `ok: false` with a typed error otherwise (HTTP response itself is still 200 — the error payload carries the rejection kind so UI can branch on it).",
      content: {
        "application/json": {
          schema: z.union([
            z.object({
              ok: z.literal(true),
              latency_ms: z.number().int(),
            }),
            z.object({
              ok: z.literal(false),
              latency_ms: z.number().int(),
              error: z.object({
                kind: z.enum(["oauth", "malformed", "network"]).openapi({ description: "Category of failure: `oauth` = AS returned a typed error (e.g. invalid_client), `malformed` = AS returned an unexpected 2xx payload, `network` = couldn't reach the AS." }),
                message: z.string(),
                oauth_error: z.string().optional().openapi({ description: "RFC 6749 `error` field when kind=oauth." }),
                oauth_error_description: z.string().optional().openapi({ description: "RFC 6749 `error_description` field when kind=oauth." }),
                http_status: z.number().int().optional().openapi({ description: "Status code when the AS returned a non-2xx." }),
              }),
            }),
          ]),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "No saved client-credentials config for this agent", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/registry/agents/{encodedUrl}/applicable-storyboards",
  operationId: "getApplicableStoryboards",
  summary: "Get applicable storyboards for agent",
  description:
    "Probe the agent's get_adcp_capabilities and resolve its declared supported_protocols and specialisms to the compliance bundles that will run. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
    }),
  },
  responses: {
    200: {
      description: "Bundles the agent will be tested against, driven by its declared capabilities",
      content: {
        "application/json": {
          schema: z.object({
            agent_url: z.string(),
            agent_name: z.string(),
            supported_protocols: z.array(z.string()),
            specialisms: z.array(z.string()),
            capabilities_probe_error: z.string().optional().openapi({ description: "Agent-reported probe error. Untrusted — sanitized and truncated to 500 chars. Present when get_adcp_capabilities was advertised but failed; empty bundle list usually indicates this, not a v2 agent." }),
            bundles: z.array(z.object({
              kind: z.enum(["universal", "domain", "specialism"]),
              id: z.string(),
              storyboards: z.array(z.object({
                id: z.string(),
                title: z.string(),
                summary: z.string(),
                step_count: z.number().int(),
              })),
            })),
            total_storyboards: z.number().int(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Agent requires authentication, or declares a specialism not in the local compliance cache",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            needs_auth: z.boolean().optional(),
            unknown_specialism: z.boolean().optional(),
            declared_specialisms: z.array(z.string()).optional().openapi({ description: "Specialisms the agent declared, for unknown-specialism errors" }),
            known_specialisms: z.array(z.string()).optional().openapi({ description: "Specialism ids present in this server's local compliance cache" }),
          }),
        },
      },
    },
    500: {
      description: "Server error",
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
            reason: z.enum(["network", "tls", "timeout", "protocol", "unknown"]).optional().openapi({ description: "Coarse error classification for UI differentiation" }),
          }),
        },
      },
    },
    504: { description: "Connection timeout", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Storyboard Catalog ──────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/storyboards",
  operationId: "listStoryboards",
  summary: "List storyboards",
  description:
    "Returns the catalog of compliance storyboards. Optionally filter by category.",
  tags: ["Agent Compliance"],
  request: {
    query: z.object({
      category: z.string().optional().openapi({ description: "Filter by storyboard category" }),
    }),
  },
  responses: {
    200: {
      description: "Storyboard catalog",
      content: {
        "application/json": {
          schema: z.object({
            storyboards: z.array(StoryboardSummarySchema),
            count: z.number().int(),
          }),
        },
      },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/storyboards/{id}",
  operationId: "getStoryboard",
  summary: "Get storyboard detail",
  description:
    "Returns a single storyboard with its full phase and step structure, plus its test kit if available.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Storyboard ID" }),
    }),
  },
  responses: {
    200: {
      description: "Storyboard detail",
      content: {
        "application/json": {
          schema: z.object({
            storyboard: StoryboardDetailSchema,
            test_kit: z.any().nullable(),
          }),
        },
      },
    },
    404: { description: "Storyboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Brand Find & Setup ──────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/brands/find",
  operationId: "findBrand",
  summary: "Find brands by name",
  description:
    "Search for brands by name or domain. Returns matching results with basic identity info.",
  tags: ["Brand Resolution"],
  request: {
    query: z.object({
      q: z.string().min(2).openapi({ description: "Search query (min 2 characters)" }),
      limit: z.string().optional().openapi({ description: "Max results (default 10, max 50)" }),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(FindCompanyResultSchema),
          }),
        },
      },
    },
    400: { description: "Query too short", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/brands/setup-my-brand",
  operationId: "setupMyBrand",
  summary: "Set up a hosted brand.json",
  description:
    "Create or update a hosted brand.json for a domain owned by the authenticated user's organization. Returns the hosted URL and a pointer snippet for DNS setup.",
  tags: ["Brand Resolution"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domain: z.string().openapi({ example: "acmecorp.com" }),
            brand_name: z.string(),
            logo_url: z.string().optional(),
            brand_color: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Brand setup result",
      content: {
        "application/json": {
          schema: z.object({
            domain: z.string(),
            has_brand_json: z.boolean(),
            hosted_brand_json_url: z.string(),
            pointer_snippet: z.string().openapi({ description: "JSON string for brand.json pointer" }),
          }),
        },
      },
    },
    400: { description: "Invalid domain or missing fields", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Domain not owned by user's organization", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Property Checks ─────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/properties/check/bulk",
  operationId: "bulkPropertyCheck",
  summary: "Bulk property identifier check",
  description:
    "Check up to 10,000 property identifiers (domains, app bundle IDs, CTV store URLs) against the registry catalog. Returns a verdict for each identifier and a summary.",
  tags: ["Property Resolution"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            identifiers: z.array(z.string()).max(10000).openapi({ description: "Property identifiers to check" }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Check results with report ID",
      content: {
        "application/json": {
          schema: z.object({
            summary: z.object({
              total: z.number().int(),
              ready: z.number().int(),
              known: z.number().int(),
              ad_infra: z.number().int(),
              unknown: z.number().int(),
              skipped: z.number().int(),
            }),
            entries: z.array(z.object({
              input: z.string(),
              identifier: z.object({ type: z.string(), value: z.string() }),
              verdict: z.string(),
              classification: z.string().nullable(),
              source: z.string().nullable(),
              property_rid: z.string().nullable(),
              action: z.string(),
            })),
            report_id: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid identifiers", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/properties/check/bulk/{reportId}",
  operationId: "getBulkPropertyCheckReport",
  summary: "Get bulk check report",
  description:
    "Retrieve a previously generated bulk property check report by ID.",
  tags: ["Property Resolution"],
  request: {
    params: z.object({
      reportId: z.string().openapi({ description: "Report UUID" }),
    }),
  },
  responses: {
    200: {
      description: "Report data",
      content: {
        "application/json": {
          schema: z.object({
            summary: z.object({
              total: z.number().int(),
              ready: z.number().int(),
              known: z.number().int(),
              ad_infra: z.number().int(),
              unknown: z.number().int(),
              skipped: z.number().int(),
            }),
            entries: z.array(z.object({
              input: z.string(),
              identifier: z.object({ type: z.string(), value: z.string() }),
              verdict: z.string(),
              classification: z.string().nullable(),
              source: z.string().nullable(),
              property_rid: z.string().nullable(),
              action: z.string(),
            })),
          }),
        },
      },
    },
    404: { description: "Report not found or expired", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// ── Storyboard Execution ────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/registry/agents/{encodedUrl}/storyboard/{storyboardId}/step/{stepId}",
  operationId: "runStoryboardStep",
  summary: "Run a single storyboard step",
  description:
    "Execute a single storyboard step against an agent. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      storyboardId: z.string(),
      stepId: z.string(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            context: z.record(z.string(), z.unknown()).optional().openapi({ description: "Optional context object for the step" }),
            dry_run: z.boolean().optional().openapi({ description: "Dry run mode (default: true)" }),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Step execution result", content: { "application/json": { schema: z.any() } } },
    400: { description: "Invalid parameters", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Storyboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/storyboards/{storyboardId}/first-step",
  operationId: "getStoryboardFirstStep",
  summary: "Get first step preview",
  description:
    "Returns a preview of the first step of a storyboard. No agent call needed.",
  tags: ["Agent Compliance"],
  request: {
    params: z.object({
      storyboardId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "First step preview",
      content: {
        "application/json": {
          schema: z.object({
            storyboard: z.object({ id: z.string(), title: z.string() }),
            step: z.any(),
          }),
        },
      },
    },
    404: { description: "Storyboard not found or has no steps", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/agents/{encodedUrl}/storyboard/{storyboardId}/run",
  operationId: "runStoryboard",
  summary: "Run full storyboard evaluation",
  description:
    "Execute all steps of a storyboard against an agent and record the compliance result. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      storyboardId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Storyboard run result with annotated phases",
      content: {
        "application/json": {
          schema: z.object({
            storyboard: z.object({
              id: z.string(),
              title: z.string(),
              category: z.string(),
              narrative: z.string().optional(),
            }),
            agent: z.object({
              url: z.string(),
              profile: z.any(),
            }),
            phases: z.any(),
            summary: z.any(),
            observations: z.any(),
            total_duration_ms: z.number(),
            test_kit: z.any().nullable(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Storyboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/registry/agents/{encodedUrl}/storyboard/{storyboardId}/compare",
  operationId: "compareStoryboard",
  summary: "Compare storyboard against reference agent",
  description:
    "Run a storyboard against both the target agent and the public reference agent, returning side-by-side results. Requires authentication and ownership.",
  tags: ["Agent Compliance"],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    params: z.object({
      encodedUrl: z.string().openapi({ description: "URL-encoded agent URL" }),
      storyboardId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Side-by-side comparison results",
      content: {
        "application/json": {
          schema: z.object({
            storyboard: z.object({ id: z.string(), title: z.string(), category: z.string() }),
            user_agent: z.object({ url: z.string(), profile: z.any(), summary: z.any() }),
            reference_agent: z.object({ url: z.string(), name: z.string(), profile: z.any(), summary: z.any() }),
            phases: z.any(),
            total_duration_ms: z.number(),
          }),
        },
      },
    },
    400: { description: "Invalid agent URL", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Not authorized", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Storyboard not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
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
    crawler,
    registryRequestsDb,
    requireAuth: authMiddleware,
    optionalAuth: optionalAuthMiddleware,
  } = config;
  const noopMiddleware: RequestHandler = (_req, _res, next) => next();
  const optAuth: RequestHandler = optionalAuthMiddleware ?? noopMiddleware;
  const orgDb = new OrganizationDatabase();

  const catalogDb = new CatalogDatabase();

  // Source mapping: catalog sources → legacy source labels for API consumers
  const CATALOG_SOURCE_MAP: Record<string, string> = {
    authoritative: 'adagents_json',
    contributed: 'community',
    enriched: 'enriched',
  };

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
        policies: "/api/policies/registry",
        agents: "/api/registry/agents",
        search: "/api/search",
      },
    });
  });

  // ── Brand Resolution ──────────────────────────────────────────

  const BRAND_SOURCE_VALUES = ['hosted', 'brand_json', 'enriched', 'community'] as const;
  type BrandSourceParam = typeof BRAND_SOURCE_VALUES[number];

  router.get("/brands/registry", async (req, res) => {
    try {
      const search = req.query.search as string | undefined;
      const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string), 5000) : undefined;
      const offset = parseInt(req.query.offset as string) || 0;
      const sourceParam = req.query.source as string | undefined;

      if (sourceParam && !(BRAND_SOURCE_VALUES as readonly string[]).includes(sourceParam)) {
        return res.status(400).json({ error: `Invalid source filter. Valid values: ${BRAND_SOURCE_VALUES.join(', ')}` });
      }

      const source = sourceParam as BrandSourceParam | undefined;

      const [brands, stats] = await Promise.all([
        brandDb.getAllBrandsForRegistry({ search, limit, offset, source }),
        brandDb.getBrandRegistryStats(search),
      ]);

      return res.json({ brands, stats });
    } catch (error) {
      logger.error({ error }, "Failed to list brands");
      return res.status(500).json({ error: "Failed to list brands" });
    }
  });

  router.get("/brands/history", async (req, res) => {
    try {
      const domain = extractDomain((req.query.domain as string) || "");
      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
      const rawOffset = parseInt(req.query.offset as string, 10);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const [revisions, total] = await Promise.all([
        brandDb.getBrandRevisions(domain, { limit, offset }),
        brandDb.getBrandRevisionCount(domain),
      ]);

      if (total === 0) {
        const brand = await brandDb.getDiscoveredBrandByDomain(domain);
        if (!brand) {
          return res.status(404).json({ error: "Brand not found", domain });
        }
      }

      return res.json({
        domain,
        total,
        revisions: revisions.map((r) => ({
          revision_number: r.revision_number,
          editor_name: r.editor_name || "system",
          edit_summary: r.edit_summary,
          source: (r.snapshot as Record<string, unknown>)?.source_type,
          is_rollback: r.is_rollback,
          rolled_back_to: r.rolled_back_to,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (error) {
      logger.error({ error }, "Failed to get brand history");
      return res.status(500).json({ error: "Failed to get brand history" });
    }
  });

  router.get("/brands/find", async (req, res) => {
    try {
      const q = (req.query.q as string | undefined)?.trim();
      if (!q || q.length < 2) {
        return res.status(400).json({ error: "q parameter required (min 2 characters)" });
      }
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, 50) : 10;
      const results = await brandDb.findCompany(q, { limit });
      return res.json({ results });
    } catch (error) {
      logger.error({ error }, "Failed to find company");
      return res.status(500).json({ error: "Failed to find company" });
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
        // Hide orphaned manifests and explicitly non-public rows. The manifest
        // is preserved server-side for adoption-at-claim-time but must not
        // surface on public read paths until the next claim is applied.
        if (discovered && !discovered.manifest_orphaned && discovered.is_public !== false) {
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

  /**
   * Enrich brand.json agent entries with AAO verification status.
   * Scans data for agent URLs and appends an `aao_verification`
   * block where badges exist. The block's shape is the contract
   * documented at {@link buildAaoVerificationBlock} in
   * services/aao-verification-enrichment.ts — the route handler
   * is the I/O layer; the builder is the unit-testable shaping
   * logic.
   */
  async function enrichBrandDataWithVerification(data: unknown): Promise<unknown> {
    if (!data || typeof data !== 'object') return data;

    // Collect all agent URLs from brand.json data
    const agentUrls: string[] = [];
    function collectAgentUrls(obj: unknown) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(collectAgentUrls); return; }
      const rec = obj as Record<string, unknown>;
      if (typeof rec.url === 'string' && typeof rec.type === 'string') {
        agentUrls.push(rec.url as string);
      }
      // Check house.agents and brands[].agents
      if (rec.agents && Array.isArray(rec.agents)) rec.agents.forEach(collectAgentUrls);
      if (rec.brands && Array.isArray(rec.brands)) rec.brands.forEach(collectAgentUrls);
      if (rec.house && typeof rec.house === 'object') collectAgentUrls(rec.house);
    }
    collectAgentUrls(data);

    if (agentUrls.length === 0) return data;

    let badgeMap: Map<string, Awaited<ReturnType<typeof complianceDb.getBadgesForAgent>>>;
    try {
      badgeMap = await complianceDb.bulkGetActiveBadges(agentUrls);
    } catch {
      return data; // Table may not exist yet
    }

    if (badgeMap.size === 0) return data;

    // Deep clone and enrich agent entries
    const enriched = JSON.parse(JSON.stringify(data));
    function enrichAgentEntries(obj: unknown) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(enrichAgentEntries); return; }
      const rec = obj as Record<string, unknown>;
      if (typeof rec.url === 'string' && typeof rec.type === 'string') {
        const badges = badgeMap.get(rec.url as string);
        const block = badges ? buildAaoVerificationBlock(badges) : null;
        if (block) {
          rec.aao_verification = block;
        }
      }
      if (rec.agents && Array.isArray(rec.agents)) rec.agents.forEach(enrichAgentEntries);
      if (rec.brands && Array.isArray(rec.brands)) rec.brands.forEach(enrichAgentEntries);
      if (rec.house && typeof rec.house === 'object') enrichAgentEntries(rec.house);
    }
    enrichAgentEntries(enriched);

    return enriched;
  }

  router.get("/brands/brand-json", async (req, res) => {
    try {
      const domain = ((req.query.domain as string) || "").toLowerCase();
      const fresh = req.query.fresh === "true";
      const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
      if (!domain || !domainPattern.test(domain)) {
        return res.status(400).json({ error: "Invalid domain format" });
      }

      // If fresh=true, fetch live from external domain and update DB cache
      if (fresh) {
        const result = await brandManager.validateDomain(domain, { skipCache: true });
        if (result.valid && result.raw_data) {
          const enrichedData = await enrichBrandDataWithVerification(result.raw_data);
          return res.json({
            domain: result.domain,
            url: result.url,
            variant: result.variant,
            data: enrichedData,
            warnings: result.warnings,
          });
        }
        // Live fetch failed — fall through to DB cache
      }

      // Serve from DB — single brands table
      const brand = await brandDb.getDiscoveredBrandByDomain(domain);
      if (brand && brand.is_public !== false) {
        const manifest = (brand.brand_manifest as Record<string, unknown>) || {};
        const data = { name: brand.brand_name || domain, ...manifest };
        const enrichedData = await enrichBrandDataWithVerification(data);

        const variant = brand.source_type === "brand_json" ? "house_portfolio" : undefined;
        const url = brand.source_type === "brand_json"
          ? `https://${domain}/.well-known/brand.json`
          : `https://agenticadvertising.org/brands/${domain}/brand.json`;

        return res.json({ domain, url, variant, data: enrichedData });
      }

      // Nothing in DB — try live fetch as last resort
      const result = await brandManager.validateDomain(domain);
      if (result.valid && result.raw_data) {
        const enrichedData = await enrichBrandDataWithVerification(result.raw_data);
        return res.json({
          domain: result.domain,
          url: result.url,
          variant: result.variant,
          data: enrichedData,
          warnings: result.warnings,
        });
      }

      return res.status(404).json({
        error: "Brand not found or invalid",
        domain,
        errors: result.errors,
      });
    } catch (error) {
      logger.error({ error }, "Failed to fetch brand.json");
      return res.status(500).json({ error: "Failed to fetch brand data" });
    }
  });

  router.get("/brands/enrich", async (req, res) => {
    try {
      const rawDomain = req.query.domain as string;
      if (!rawDomain) {
        return res.status(400).json({ error: "domain parameter required" });
      }

      const domain = extractDomain(rawDomain);

      // Return cached enrichment if still fresh (avoids Brandfetch API cost)
      const existing = await brandDb.getDiscoveredBrandByDomain(domain);
      if (existing?.has_brand_manifest && existing.brand_manifest && existing.last_validated) {
        const ageMs = Date.now() - new Date(existing.last_validated).getTime();
        if (ageMs < ENRICHMENT_CACHE_MAX_AGE_MS) {
          return res.json({ success: true, domain: existing.domain, cached: true, manifest: existing.brand_manifest });
        }
      }

      if (!isBrandfetchConfigured()) {
        return res.status(503).json({ error: "Brandfetch not configured" });
      }

      const enrichment = await fetchBrandData(domain);

      if (!enrichment.success) {
        return res.status(404).json({ error: enrichment.error, domain });
      }

      if (enrichment.manifest) {
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
        }).catch((err) => logger.warn({ err, domain }, 'Failed to save enrichment result'));
      }

      return res.json({ success: true, domain: enrichment.domain, cached: false, manifest: enrichment.manifest, company: enrichment.company });
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
            // Hide orphaned manifests and explicitly non-public rows; same
            // rationale as the single-resolve route above.
            if (discovered && !discovered.manifest_orphaned && discovered.is_public !== false) {
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

      const domain = extractDomain(rawDomain);
      const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
      if (!domainPattern.test(domain)) {
        return res.status(400).json({ error: "Invalid domain format" });
      }

      // Block edits when a verified member org owns this domain
      const hostedBrand = await brandDb.getHostedBrandByDomain(domain);
      if (hostedBrand?.domain_verified) {
        return res.status(409).json({
          error: "This brand is managed by a verified member organization",
          domain,
        });
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
      const source = req.query.source as string | undefined;

      // Validate and map legacy source filter to catalog source
      const SOURCE_FILTER_MAP: Record<string, string> = {
        adagents_json: 'authoritative',
        community: 'contributed',
        enriched: 'enriched',
      };
      if (source && !(source in SOURCE_FILTER_MAP)) {
        return res.status(400).json({ error: `Invalid source filter. Valid values: ${Object.keys(SOURCE_FILTER_MAP).join(', ')}` });
      }
      const catalogSource = source ? SOURCE_FILTER_MAP[source] : undefined;

      const [properties, catalogStats] = await Promise.all([
        catalogDb.getPropertiesForRegistry({ search, limit, offset, source: catalogSource }),
        catalogDb.getRegistryStats(search),
      ]);

      // Map catalog stats to legacy labels
      const stats = {
        total: catalogStats.total,
        community: (catalogStats.contributed || 0) + (catalogStats.enriched || 0),
        adagents_json: catalogStats.authoritative || 0,
        hosted: 0,
      };

      return res.json({
        properties: properties.map(p => ({
          ...p,
          source: CATALOG_SOURCE_MAP[p.source] || p.source,
        })),
        stats,
      });
    } catch (error) {
      logger.error({ error }, "Failed to list properties");
      return res.status(500).json({ error: "Failed to list properties" });
    }
  });

  router.get("/properties/history", async (req, res) => {
    try {
      const domain = extractDomain((req.query.domain as string) || "");
      if (!domain) {
        return res.status(400).json({ error: "domain parameter required" });
      }
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
      const rawOffset = parseInt(req.query.offset as string, 10);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const [revisions, total] = await Promise.all([
        propertyDb.getPropertyRevisions(domain, { limit, offset }),
        propertyDb.getPropertyRevisionCount(domain),
      ]);

      if (total === 0) {
        const hosted = await propertyDb.getHostedPropertyByDomain(domain);
        const discovered = await propertyDb.getDiscoveredPropertiesByDomain(domain);
        if (!hosted && discovered.length === 0) {
          return res.status(404).json({ error: "Property not found", domain });
        }
      }

      return res.json({
        domain,
        total,
        revisions: revisions.map((r) => ({
          revision_number: r.revision_number,
          editor_name: r.editor_name || "system",
          edit_summary: r.edit_summary,
          source: (r.snapshot as Record<string, unknown>)?.source_type,
          is_rollback: r.is_rollback,
          rolled_back_to: r.rolled_back_to,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (error) {
      logger.error({ error }, "Failed to get property history");
      return res.status(500).json({ error: "Failed to get property history" });
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

      let normalizedDomain: string;
      try {
        normalizedDomain = await validateCrawlDomain(domain);
      } catch (err) {
        return res.status(400).json({ error: `Invalid domain: ${(err as Error).message}` });
      }

      const validation = await adagentsManager.validateDomain(normalizedDomain);
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

      const publisher_domain = extractDomain(rawDomain);
      const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
      if (!domainPattern.test(publisher_domain)) {
        return res.status(400).json({ error: "Invalid domain format" });
      }

      const adagentsJson: Record<string, unknown> = {
        $schema: "https://adcontextprotocol.org/schemas/latest/adagents.json",
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

  // ── Property List Check ────────────────────────────────────────

  router.post("/properties/check", bulkResolveRateLimiter, async (req, res) => {
    try {
      const { domains } = req.body;
      if (!Array.isArray(domains)) {
        return res.status(400).json({ error: "domains array is required" });
      }
      if (domains.length > 10000) {
        return res.status(400).json({ error: "Maximum 10,000 domains per request" });
      }

      const results = await propertyCheckService.check(domains);
      const { id: report_id } = await propertyCheckDb.saveReport(results);

      return res.json({ ...results, report_id });
    } catch (error) {
      logger.error({ error }, "Failed to check property list");
      return res.status(500).json({ error: "Failed to check property list" });
    }
  });

  router.get("/properties/check/:reportId", async (req, res) => {
    try {
      const { reportId } = req.params;
      if (!isUuid(reportId)) {
        return res.status(404).json({ error: "Report not found or expired" });
      }
      const results = await propertyCheckDb.getReport(reportId);
      if (!results) {
        return res.status(404).json({ error: "Report not found or expired" });
      }
      return res.json(results);
    } catch (error) {
      logger.error({ error }, "Failed to retrieve property check report");
      return res.status(500).json({ error: "Failed to retrieve report" });
    }
  });

  // ── Bulk Property Check ─────────────────────────────────────────

  router.post("/properties/check/bulk", bulkResolveRateLimiter, async (req, res) => {
    try {
      const { identifiers } = req.body;
      if (!Array.isArray(identifiers) || !identifiers.every((i: unknown) => typeof i === 'string')) {
        return res.status(400).json({ error: "identifiers must be an array of strings" });
      }
      if (identifiers.length > 10000) {
        return res.status(400).json({ error: "Maximum 10,000 identifiers per request" });
      }

      const results = await bulkCheckService.check(identifiers);
      const reportId = await bulkCheckService.saveReport(results);

      return res.json({ ...results, report_id: reportId });
    } catch (error) {
      logger.error({ error }, "Failed to run bulk property check");
      return res.status(500).json({ error: "Failed to run bulk property check" });
    }
  });

  router.get("/properties/check/bulk/:reportId", async (req, res) => {
    try {
      const { reportId } = req.params;
      if (!isUuid(reportId)) {
        return res.status(404).json({ error: "Report not found or expired" });
      }
      const results = await bulkCheckService.getReport(reportId);
      if (!results) {
        return res.status(404).json({ error: "Report not found or expired" });
      }
      return res.json(results);
    } catch (error) {
      logger.error({ error }, "Failed to retrieve bulk check report");
      return res.status(500).json({ error: "Failed to retrieve report" });
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
      logger.error({ err: error, path: req.path }, "Failed to validate domain");
      return res.status(500).json({
        success: false,
        error: "Failed to validate domain",
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
      logger.error({ err: error, path: req.path }, "Failed to create adagents.json");
      return res.status(500).json({
        success: false,
        error: "Failed to create adagents.json",
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
        catalogDb.getPropertiesForRegistry({ search: q, limit: 5 }),
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

  router.get("/registry/agents", optAuth, async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      let type = req.query.type as AgentType | undefined;
      const withHealth = req.query.health === "true";
      const withCapabilities = req.query.capabilities === "true";
      const withProperties = req.query.properties === "true";
      const withCompliance = req.query.compliance === "true";

      // `?source=` is removed (#3772). The registry surface is registered-only;
      // the parameter no longer has a defined behaviour. Reject explicitly so a
      // caller passing `?source=discovered` gets a clear signal instead of a
      // silently-merged response that happens to look right by coincidence.
      if (typeof req.query.source === "string" && req.query.source.length > 0) {
        return res.status(400).json({
          error: "source query parameter is no longer supported (registry surface is registered-only)",
        });
      }

      // Measurement-vendor filters (#3613). Repeatable params arrive as
      // string|string[]; normalize to arrays. `q` is a single substring.
      // Auto-scope: if any measurement filter is present and `type` is
      // unset, force `type=measurement` so an agent-generated query like
      // `?metric_id=attention_units` doesn't need the redundant `type` hint.
      // An explicit `type` other than `measurement` is a conflict — 400.
      const toArray = (v: unknown): string[] => {
        if (v === undefined) return [];
        if (typeof v === "string") return v ? [v] : [];
        if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
        return [];
      };
      const metricIds = toArray(req.query.metric_id);
      const accreditations = toArray(req.query.accreditation);
      const qParam = typeof req.query.q === "string" ? req.query.q : undefined;
      const hasMeasurementFilter = metricIds.length > 0 || accreditations.length > 0 || (qParam !== undefined && qParam.length > 0);

      if (hasMeasurementFilter) {
        if (type && type !== "measurement") {
          return res.status(400).json({
            error: "metric_id, accreditation, and q filters require type=measurement",
          });
        }
        type = "measurement" as AgentType;
      }

      // Length cap on q. Wildcards (% _) get rejected outright rather than
      // escaped-and-passed — q is a substring search, never a pattern.
      let qFilter: string | undefined;
      if (qParam !== undefined) {
        if (qParam.length === 0) {
          // Empty q is a no-op; treat as absent.
        } else if (qParam.length > 64) {
          return res.status(400).json({ error: "q exceeds 64 characters" });
        } else if (/[%_]/.test(qParam)) {
          return res.status(400).json({ error: "q must not contain SQL wildcard characters (% or _)" });
        } else {
          qFilter = qParam;
        }
      }

      // members_only agents are discoverable to authenticated API-access
      // members (Professional+). Crawlers and anonymous callers only see
      // public agents.
      let includeMembersOnly = false;
      const callerOrgId = await resolveCallerOrgId(req);
      if (callerOrgId) {
        const org = await orgDb.getOrganization(callerOrgId);
        if (org && hasApiAccess(resolveMembershipTier(org))) {
          includeMembersOnly = true;
        }
      }

      let federatedAgents = await federatedIndex.listAllAgents(type, { includeMembersOnly });

      // Apply measurement-vendor filters by intersecting with the snapshot
      // table. The snapshot is the only place metric_id / accreditation /
      // metric_id-substring lookups can be answered without per-agent fan-out.
      if (hasMeasurementFilter) {
        const matchingUrls = await agentSnapshotDb.filterMeasurementAgents({
          metric_ids: metricIds,
          accreditations,
          q: qFilter,
        });
        federatedAgents = federatedAgents.filter((fa) => matchingUrls.has(fa.url));
      }

      const agents = federatedAgents.map((fa) => ({
        name: fa.name || fa.url,
        url: fa.url,
        type: isValidAgentType(fa.type) ? fa.type : ("unknown" as const),
        protocol: fa.protocol || "mcp",
        description: fa.member?.display_name || "",
        mcp_endpoint: fa.url,
        contact: {
          name: fa.member?.display_name || "",
          email: "",
          website: "",
        },
        member: fa.member,
      }));

      if (!withHealth && !withCapabilities && !withProperties && !withCompliance) {
        return res.json({ agents, count: agents.length });
      }

      // Bulk-fetch all enrichment data from DB snapshot tables up front.
      // The crawler materializes health + capabilities into these tables on
      // each cycle, so the registry API never does live MCP/A2A fan-out.
      // Compliance status, metadata, and badges are fetched here too.
      const agentUrls = agents.map(a => a.url);
      const [complianceMap, metadataMap, healthMap, capsMap] = await Promise.all([
        withCompliance ? complianceDb.bulkGetComplianceStatus(agentUrls) : Promise.resolve(null),
        withCompliance ? complianceDb.bulkGetRegistryMetadata(agentUrls) : Promise.resolve(null),
        withHealth ? agentSnapshotDb.bulkGetHealth(agentUrls) : Promise.resolve(null),
        withCapabilities ? agentSnapshotDb.bulkGetCapabilities(agentUrls) : Promise.resolve(null),
      ]);

      let badgeMap: Map<string, Awaited<ReturnType<typeof complianceDb.getBadgesForAgent>>> | null = null;
      if (withCompliance) {
        try {
          badgeMap = await complianceDb.bulkGetActiveBadges(agentUrls);
        } catch (err) {
          logger.warn({ err }, "Badge bulk query failed (table may not exist yet)");
        }
      }

      const enriched = await Promise.all(
        agents.map(async (agent): Promise<AgentWithStats> => {
          const enrichedAgent: AgentWithStats = { ...agent } as AgentWithStats;

          if (capsMap) {
            const cap = capsMap.get(agent.url);
            if (cap) {
              enrichedAgent.capabilities = {
                tools_count: cap.discovered_tools_json?.length || 0,
                tools: cap.discovered_tools_json || [],
                standard_operations: cap.standard_operations_json ?? undefined,
                creative_capabilities: cap.creative_capabilities_json ?? undefined,
                signals_capabilities: cap.signals_capabilities_json ?? undefined,
                measurement_capabilities: cap.measurement_capabilities_json ?? undefined,
                discovery_error: cap.discovery_error ?? undefined,
                oauth_required: cap.oauth_required || undefined,
              };

              if ((!enrichedAgent.type || enrichedAgent.type === "unknown") && cap.inferred_type) {
                if (isValidAgentType(cap.inferred_type)) {
                  enrichedAgent.type = cap.inferred_type;
                }
              }
            }
          }

          if (healthMap) {
            const h = healthMap.get(agent.url);
            if (h) {
              enrichedAgent.health = {
                online: h.online,
                checked_at: h.checked_at instanceof Date ? h.checked_at.toISOString() : String(h.checked_at),
                response_time_ms: h.response_time_ms ?? undefined,
                tools_count: h.tools_count ?? undefined,
                resources_count: h.resources_count ?? undefined,
                error: h.error ?? undefined,
              };
              if (h.stats_json) {
                enrichedAgent.stats = h.stats_json;
              }
            }
          }

          const promises = [];

          if (withProperties && enrichedAgent.type === "sales") {
            promises.push(
              federatedIndex.getPropertiesForAgent(agent.url),
              federatedIndex.getPublisherDomainsForAgent(agent.url)
            );
          }

          const results = await Promise.all(promises);
          let resultIndex = 0;

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

          if (complianceMap && metadataMap) {
            const cs = complianceMap.get(agent.url);
            const meta = metadataMap.get(agent.url);
            const optedOut = meta?.compliance_opt_out ?? false;
            if (cs && !optedOut) {
              const agentBadges = badgeMap?.get(agent.url) || [];
              // Dedupe by role for the registry summary — once an agent
              // holds parallel-version badges, agentBadges has multiple
              // rows per role and verified_roles would silently grow
              // duplicates. Keep one entry per role (any version is
              // sufficient for the boolean "verified for this role").
              const uniqueRoles = Array.from(new Set(agentBadges.map(b => b.role)));
              enrichedAgent.compliance = {
                status: cs.status,
                lifecycle_stage: cs.lifecycle_stage,
                tracks: cs.tracks_summary_json || {},
                streak_days: cs.streak_days,
                last_checked_at: cs.last_checked_at?.toISOString() || null,
                headline: cs.headline,
                monitoring_paused: meta?.monitoring_paused ?? false,
                check_interval_hours: meta?.check_interval_hours ?? 12,
                verified: agentBadges.length > 0,
                verified_roles: uniqueRoles,
              };
            }
          }

          return enrichedAgent;
        })
      );

      res.json({ agents: enriched, count: enriched.length });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to list agents");
      res.status(500).json({ error: "Failed to list agents" });
    }
  });

  // ── Agent Compliance Endpoints ──────────────────────────────────

  router.get("/registry/agents/:encodedUrl/compliance", agentReadRateLimiter, optAuth, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      const status = await complianceDb.getComplianceStatus(agentUrl);
      const metadata = await complianceDb.getRegistryMetadata(agentUrl);

      // If opted out, return minimal response (no ownership check needed —
      // the opt-out preference is enforced uniformly for public endpoints)
      if (metadata?.compliance_opt_out) {
        return res.json({
          agent_url: agentUrl,
          status: "opted_out",
          lifecycle_stage: metadata.lifecycle_stage || "production",
          compliance_opt_out: true,
        });
      }

      if (!status) {
        return res.json({
          agent_url: agentUrl,
          status: "unknown",
          lifecycle_stage: metadata?.lifecycle_stage || "production",
          compliance_opt_out: false,
          tracks: {},
          streak_days: 0,
          last_checked_at: null,
          headline: null,
          storyboards_passing: 0,
          storyboards_total: 0,
        });
      }

      // Storyboard counts are supplementary — don't fail the whole response
      // if the table hasn't been migrated yet
      let sbCounts = { passing: 0, total: 0 };
      try {
        sbCounts = await complianceDb.getStoryboardStatusCounts(agentUrl);
      } catch (err) {
        logger.warn({ err, agentUrl }, "Storyboard status query failed");
      }

      // Verification badges — supplementary, don't fail the response
      let badges: Awaited<ReturnType<typeof complianceDb.getBadgesForAgent>> = [];
      try {
        badges = await complianceDb.getBadgesForAgent(agentUrl);
      } catch (err) {
        logger.warn({ err, agentUrl }, "Badge query failed (table may not exist yet)");
      }

      // Declared specialisms from the latest run — surfaces what the agent
      // told us via get_adcp_capabilities so the dashboard can answer
      // "did my agent declare what I think it did?" without re-running
      // compliance.
      let declaredSpecialisms: string[] = [];
      try {
        declaredSpecialisms = await complianceDb.getLatestDeclaredSpecialisms(agentUrl);
      } catch (err) {
        logger.warn({ err, agentUrl }, "Latest declared specialisms query failed");
      }

      // Per-specialism status — the dashboard renders pass/fail/untested
      // dots so the developer can see which declared specialism is the
      // cause of an overall `failing` status without cross-referencing
      // the storyboard track pills.
      let specialismStatus: Record<string, string> = {};
      if (declaredSpecialisms.length > 0) {
        try {
          const sbStatuses = await complianceDb.getStoryboardStatuses(agentUrl);
          specialismStatus = computeSpecialismStatus(
            declaredSpecialisms,
            sbStatuses.map(s => ({
              storyboard_id: s.storyboard_id,
              // Cast is bounded by the `valid_storyboard_status` CHECK
              // constraint in agent_storyboard_status (migration 390).
              status: s.status as 'passing' | 'failing' | 'partial' | 'untested',
              steps_passed: s.steps_passed,
              steps_total: s.steps_total,
            })),
          );
        } catch (err) {
          logger.warn({ err, agentUrl }, "Per-specialism status query failed");
        }
      }

      // Owner-only diagnostic: surface the agent owner's membership tier so
      // the dashboard can render "Your tier: X — eligible/not eligible"
      // instead of asking the developer to guess. The four fields are
      // always emitted (with `null`/`false` defaults) so a non-owner can't
      // detect ownership via `Object.keys()` shape comparison.
      const userId = req.user?.id;
      let ownerMembership;
      try {
        ownerMembership = await resolveOwnerMembership(userId, agentUrl, {
          resolveOwnerOrgId: resolveAgentOwnerOrg,
          fetchOrgMembership: async (orgId) => {
            const orgRow = await query<{ membership_tier: string | null; subscription_status: string | null }>(
              `SELECT membership_tier, subscription_status
               FROM organizations
               WHERE workos_organization_id = $1
               LIMIT 1`,
              [orgId],
            );
            return orgRow.rows[0] ?? null;
          },
        });
      } catch (err) {
        logger.warn({ err, agentUrl, userId }, "Owner membership lookup failed");
        ownerMembership = {
          membership_tier: null,
          membership_tier_label: null,
          subscription_status: null,
          is_api_access_tier: false,
        };
      }

      const encodedUrl = encodeURIComponent(agentUrl);

      res.json({
        agent_url: agentUrl,
        status: status.status,
        lifecycle_stage: metadata?.lifecycle_stage || "production",
        compliance_opt_out: metadata?.compliance_opt_out ?? false,
        tracks: status.tracks_summary_json || {},
        streak_days: status.streak_days,
        last_checked_at: status.last_checked_at?.toISOString() || null,
        last_passed_at: status.last_passed_at?.toISOString() || null,
        last_failed_at: status.last_failed_at?.toISOString() || null,
        headline: status.headline,
        status_changed_at: status.status_changed_at?.toISOString() || null,
        storyboards_passing: sbCounts.passing,
        storyboards_total: sbCounts.total,
        check_interval_hours: metadata?.check_interval_hours ?? 12,
        declared_specialisms: declaredSpecialisms,
        specialism_status: specialismStatus,
        // Owner-scoped: content is null/false for anonymous and cross-org
        // viewers, populated only when the authenticated viewer owns the
        // agent. Keys are always present so non-owners can't detect
        // ownership via response shape. See `resolveOwnerMembership`.
        membership_tier: ownerMembership.membership_tier,
        membership_tier_label: ownerMembership.membership_tier_label,
        subscription_status: ownerMembership.subscription_status,
        is_api_access_tier: ownerMembership.is_api_access_tier,
        verified: badges.length > 0,
        verified_badges: badges.map(b => ({
          role: b.role,
          // adcp_version is the load-bearing badge identity field — pairs
          // with `(agent_url, role, adcp_version)` PK. Clients render
          // version-pinned SVG/embed URLs from this. The legacy
          // `badge_url` below auto-upgrades to the highest version per
          // role (Stage 1 contract); a version-pinned URL can be derived
          // client-side as `/badge/{role}/{adcp_version}.svg`.
          //
          // Defense-in-depth: validate shape at the API serialization
          // boundary even though the DB CHECK already constrains the
          // column. A hand-edited row or a relaxed CHECK can't push
          // a malformed value into clients that trust the field.
          adcp_version: isValidAdcpVersionShape(b.adcp_version) ? b.adcp_version : null,
          verified_at: b.verified_at.toISOString(),
          verified_specialisms: b.verified_specialisms,
          verification_modes: b.verification_modes,
          verified_protocol_version: b.verified_protocol_version,
          badge_url: `/api/registry/agents/${encodedUrl}/badge/${b.role}.svg`,
        })),
      });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get compliance status");
      res.status(500).json({ error: "Failed to get compliance status" });
    }
  });

  router.get("/registry/agents/:encodedUrl/compliance/history", agentReadRateLimiter, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      // If opted out, return empty history (no ownership check needed —
      // the opt-out preference is enforced uniformly for public endpoints)
      const metadata = await complianceDb.getRegistryMetadata(agentUrl);
      if (metadata?.compliance_opt_out) {
        return res.json({ agent_url: agentUrl, runs: [], count: 0 });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const history = await complianceDb.getComplianceHistory(agentUrl, limit);

      res.json({
        agent_url: agentUrl,
        runs: history.map(run => ({
          id: run.id,
          overall_status: run.overall_status,
          headline: run.headline,
          tracks_passed: run.tracks_passed,
          tracks_failed: run.tracks_failed,
          tracks_skipped: run.tracks_skipped,
          tracks_partial: run.tracks_partial,
          tracks_json: run.tracks_json,
          total_duration_ms: run.total_duration_ms,
          triggered_by: run.triggered_by,
          tested_at: run.tested_at,
        })),
        count: history.length,
      });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get compliance history");
      res.status(500).json({ error: "Failed to get compliance history" });
    }
  });

  // ── JWKS (public) ────────────────────────────────────────────────

  router.get("/.well-known/jwks.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(getPublicJwks());
  });

  // ── Agent Verification (public) ──────────────────────────────────

  router.get("/registry/agents/:encodedUrl/verification", bulkResolveRateLimiter, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }

      let badges: Awaited<ReturnType<typeof complianceDb.getBadgesForAgent>> = [];
      try {
        badges = await complianceDb.getBadgesForAgent(agentUrl);
      } catch (err) {
        logger.warn({ err, agentUrl }, "Badge query failed (table may not exist yet)");
      }

      const encodedUrl = encodeURIComponent(agentUrl);

      res.json({
        agent_url: agentUrl,
        verified: badges.length > 0,
        badges: badges.map(b => ({
          role: b.role,
          adcp_version: isValidAdcpVersionShape(b.adcp_version) ? b.adcp_version : null,
          verified_at: b.verified_at.toISOString(),
          verified_specialisms: b.verified_specialisms,
          verification_modes: b.verification_modes,
          verified_protocol_version: b.verified_protocol_version,
          badge_url: `/api/registry/agents/${encodedUrl}/badge/${b.role}.svg`,
        })),
        registry_url: `${process.env.PUBLIC_BASE_URL || 'https://agenticadvertising.org'}/registry/agents/${encodedUrl}`,
      });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get verification status");
      res.status(500).json({ error: "Failed to get verification status" });
    }
  });

  // ── Badge SVG (public) ──────────────────────────────────────────

  // Same shape constraint the JWT signer and DB CHECK use. Routes that
  // accept a :version path segment validate before hitting the DB so we
  // don't 404-vs-400 distinguish between "no badge at this version" and
  // "this isn't a version string." Hard cap on length defends against
  // pathological URLs filling logs.
  const VALID_ADCP_VERSION_RE = /^[1-9][0-9]{0,3}\.[0-9]{1,3}$/;

  function setBadgeSvgHeaders(res: import("express").Response, etag: string) {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Security-Policy", "script-src 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60");
    // ETag covers role, version, and the mode set so a transition (e.g.
    // add 'live', upgrade to 3.1) invalidates caches for the badge URL.
    res.setHeader("ETag", etag);
  }

  router.get("/registry/agents/:encodedUrl/badge/:role.svg", agentReadRateLimiter, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      const role = req.params.role;
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!VALID_BADGE_ROLES.includes(role as any)) {
        return res.status(400).json({ error: `Invalid role "${role}". Valid roles: ${VALID_BADGE_ROLES.join(', ')}` });
      }

      // Legacy URL: serves the highest-version active+degraded badge.
      // Embedded badges in the wild auto-upgrade to the most recent
      // version the agent has earned without changing the URL. The
      // version-pinned URL `/badge/:role/:version.svg` (below) lets
      // buyers freeze a specific version.
      let modes: string[] = [];
      let adcpVersion: string | undefined;
      try {
        const badge = await complianceDb.getHighestVersionActiveBadge(agentUrl, role as any);
        if (badge) {
          modes = badge.verification_modes;
          adcpVersion = badge.adcp_version;
        }
      } catch {
        // Table may not exist yet
      }

      const svg = renderBadgeSvg(role, modes, { adcpVersion });
      // ETag-safe version: filter the DB value through the same shape
      // regex renderBadgeSvg uses. A poisoned row with control characters
      // (CR/LF, NUL) would otherwise crash the response with
      // ERR_INVALID_CHAR when Node serializes the header. Falls back to
      // 'nv' (matching the modes-empty sentinel) for missing/malformed.
      const etagVersion = adcpVersion && /^[1-9][0-9]*\.[0-9]+$/.test(adcpVersion) ? adcpVersion : 'nv';
      const etag = `"${role}-${etagVersion}-${modes.slice().sort().join('-') || 'nv'}"`;
      setBadgeSvgHeaders(res, etag);
      res.send(svg);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to render badge SVG");
      res.status(500).send("Failed to render badge");
    }
  });

  // Version-pinned badge URL — buyers who want to freeze on a specific
  // AdCP release embed this instead of the legacy `/badge/:role.svg`.
  // Returns the (Spec)/(Live) qualifier earned at exactly this version,
  // or "Not Verified" if the agent never earned a badge at this version.
  router.get("/registry/agents/:encodedUrl/badge/:role/:version.svg", agentReadRateLimiter, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      const role = req.params.role;
      const version = req.params.version;
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!VALID_BADGE_ROLES.includes(role as any)) {
        return res.status(400).json({ error: `Invalid role "${role}". Valid roles: ${VALID_BADGE_ROLES.join(', ')}` });
      }
      if (!VALID_ADCP_VERSION_RE.test(version)) {
        return res.status(400).json({ error: `Invalid version "${version}". Expected MAJOR.MINOR (e.g. "3.0").` });
      }

      let modes: string[] = [];
      try {
        const badge = await complianceDb.getActiveBadge(agentUrl, role as any, version);
        if (badge) modes = badge.verification_modes;
      } catch {
        // Table may not exist yet
      }

      const svg = renderBadgeSvg(role, modes, { adcpVersion: version });
      const etag = `"${role}-${version}-${modes.slice().sort().join('-') || 'nv'}"`;
      setBadgeSvgHeaders(res, etag);
      res.send(svg);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to render version-pinned badge SVG");
      res.status(500).send("Failed to render badge");
    }
  });

  // ── Embeddable Badge (public) ──────────────────────────────────

  // Escape URLs for safe interpolation into markdown (parens/brackets break link syntax)
  const escapeMdUrl = (url: string) => url.replace(/[()[\]]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  // Escape markdown alt text. Today altText is built from kebab-cased
  // role + numeric version so it's safe — but a future caller that
  // incorporates user-controlled text would otherwise be one
  // unescaped `]` away from breaking the link syntax. Forward defense.
  const escapeMdAltText = (text: string) => text.replace(/([\\\[\]])/g, '\\$1');
  // Convert kebab-case role ("media-buy") to Title Case ("Media Buy") for embed alt text.
  const roleLabelForEmbed = (role: string) =>
    role.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  function buildEmbedResponse(args: {
    agentUrl: string;
    role: string;
    badgeSvgUrl: string;
    altText: string;
    verified: boolean;
    adcpVersion?: string;
  }) {
    const baseUrl = process.env.PUBLIC_BASE_URL || 'https://agenticadvertising.org';
    const encodedUrl = encodeURIComponent(args.agentUrl);
    const registryUrl = `${baseUrl}/registry/agents/${encodedUrl}`;
    const html = `<a href="${escapeHtml(registryUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(args.badgeSvgUrl)}" alt="${escapeHtml(args.altText)}" loading="lazy" height="20" /></a>`;
    const markdown = `[![${escapeMdAltText(args.altText)}](${escapeMdUrl(args.badgeSvgUrl)})](${escapeMdUrl(registryUrl)})`;
    return {
      agent_url: args.agentUrl,
      role: args.role,
      verified: args.verified,
      ...(args.adcpVersion && { adcp_version: args.adcpVersion }),
      badge_svg_url: args.badgeSvgUrl,
      registry_url: registryUrl,
      html,
      markdown,
    };
  }

  router.get("/registry/agents/:encodedUrl/badge/:role/embed", agentReadRateLimiter, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      const role = req.params.role;
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!VALID_BADGE_ROLES.includes(role as any)) {
        return res.status(400).json({ error: `Invalid role "${role}". Valid roles: ${VALID_BADGE_ROLES.join(', ')}` });
      }

      let verified = false;
      let adcpVersion: string | undefined;
      try {
        const badge = await complianceDb.getHighestVersionActiveBadge(agentUrl, role as any);
        verified = !!badge;
        adcpVersion = badge?.adcp_version;
      } catch {
        // Table may not exist yet
      }

      const baseUrl = process.env.PUBLIC_BASE_URL || 'https://agenticadvertising.org';
      const encodedUrl = encodeURIComponent(agentUrl);
      const badgeSvgUrl = `${baseUrl}/api/registry/agents/${encodedUrl}/badge/${role}.svg`;
      // Embed alt text omits the version segment intentionally — the
      // legacy URL auto-upgrades, so a buyer who copies this snippet
      // gets the newest version's image without changing the alt text
      // they pasted into their site.
      const altText = `AAO Verified ${roleLabelForEmbed(role)} Agent`;

      res.json(buildEmbedResponse({ agentUrl, role, badgeSvgUrl, altText, verified, adcpVersion }));
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to generate embed code");
      res.status(500).json({ error: "Failed to generate embed code" });
    }
  });

  // Version-pinned embed — renders snippets that point at the
  // version-specific SVG URL. Buyers who want to call out "verified
  // for AdCP 3.0" specifically (e.g., during a 3.1 transition) embed
  // this instead of the legacy `/badge/:role/embed`.
  router.get("/registry/agents/:encodedUrl/badge/:role/:version/embed", agentReadRateLimiter, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      const role = req.params.role;
      const version = req.params.version;
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!VALID_BADGE_ROLES.includes(role as any)) {
        return res.status(400).json({ error: `Invalid role "${role}". Valid roles: ${VALID_BADGE_ROLES.join(', ')}` });
      }
      if (!VALID_ADCP_VERSION_RE.test(version)) {
        return res.status(400).json({ error: `Invalid version "${version}". Expected MAJOR.MINOR (e.g. "3.0").` });
      }

      let verified = false;
      try {
        const badge = await complianceDb.getActiveBadge(agentUrl, role as any, version);
        verified = !!badge;
      } catch {
        // Table may not exist yet
      }

      const baseUrl = process.env.PUBLIC_BASE_URL || 'https://agenticadvertising.org';
      const encodedUrl = encodeURIComponent(agentUrl);
      const badgeSvgUrl = `${baseUrl}/api/registry/agents/${encodedUrl}/badge/${role}/${version}.svg`;
      const altText = `AAO Verified ${roleLabelForEmbed(role)} Agent ${version}`;

      res.json(buildEmbedResponse({ agentUrl, role, badgeSvgUrl, altText, verified, adcpVersion: version }));
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to generate version-pinned embed code");
      res.status(500).json({ error: "Failed to generate embed code" });
    }
  });

  // ── Storyboard Status (members-only) ─────────────────────────────

  const memberReadMiddleware = authMiddleware ? [authMiddleware] : [];

  router.get(
    "/registry/agents/:encodedUrl/storyboard-status",
    ...memberReadMiddleware,
    async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.encodedUrl);
        if (!validateAgentUrlParam(agentUrl)) {
          return res.status(400).json({ error: "Invalid agent URL" });
        }

        if (!req.user) {
          return res.status(401).json({ error: "Authentication required. Storyboard detail is available to members." });
        }

        await enrichUserWithMembership(req.user as any);
        if (!(req.user as any).isMember) {
          return res.status(403).json({
            error: "Storyboard compliance detail is available to members only",
            members_only: true,
          });
        }

        const metadata = await complianceDb.getRegistryMetadata(agentUrl);
        if (metadata?.compliance_opt_out) {
          return res.json({ agent_url: agentUrl, status: "opted_out", storyboards: [] });
        }

        let statuses: Awaited<ReturnType<typeof complianceDb.getStoryboardStatuses>> = [];
        try {
          statuses = await complianceDb.getStoryboardStatuses(agentUrl);
        } catch (err) {
          logger.warn({ err, agentUrl }, "Storyboard status query failed (table may not exist)");
        }

        const enriched = statuses.map(s => {
          const sb = getStoryboard(s.storyboard_id);
          return {
            storyboard_id: s.storyboard_id,
            title: sb?.title || s.storyboard_id,
            category: sb?.category || null,
            track: sb?.track || null,
            status: s.status,
            steps_passed: s.steps_passed,
            steps_total: s.steps_total,
            last_tested_at: s.last_tested_at?.toISOString() || null,
            last_passed_at: s.last_passed_at?.toISOString() || null,
          };
        });

        res.json({
          agent_url: agentUrl,
          storyboards: enriched,
          passing_count: enriched.filter(s => s.status === "passing").length,
          total_count: enriched.length,
        });
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to get storyboard status");
        res.status(500).json({ error: "Failed to get storyboard status" });
      }
    },
  );

  router.post(
    "/registry/agents/storyboard-status",
    bulkResolveRateLimiter,
    ...memberReadMiddleware,
    async (req, res) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        await enrichUserWithMembership(req.user as any);
        if (!(req.user as any).isMember) {
          return res.status(403).json({
            error: "Batch storyboard status is available to members only",
            members_only: true,
          });
        }

        const { agent_urls } = req.body;
        if (!Array.isArray(agent_urls) || agent_urls.length === 0) {
          return res.status(400).json({ error: "agent_urls must be a non-empty array" });
        }
        if (agent_urls.length > 100) {
          return res.status(400).json({ error: "Maximum 100 agent URLs per request" });
        }

        const validUrls = agent_urls.filter((u: unknown) => typeof u === "string" && validateAgentUrlParam(u as string));

        const metadataMap = await complianceDb.bulkGetRegistryMetadata(validUrls);
        const nonOptedOut = validUrls.filter((u: string) => !metadataMap.get(u)?.compliance_opt_out);
        const optedOut = new Set(validUrls.filter((u: string) => metadataMap.get(u)?.compliance_opt_out));

        let statusMap: Awaited<ReturnType<typeof complianceDb.bulkGetStoryboardStatuses>> = new Map();
        try {
          statusMap = await complianceDb.bulkGetStoryboardStatuses(nonOptedOut);
        } catch (err) {
          logger.warn({ err }, "Bulk storyboard status query failed (table may not exist)");
        }

        const results: Record<string, any> = {};
        for (const url of validUrls) {
          if (optedOut.has(url)) {
            results[url] = { status: "opted_out" };
            continue;
          }
          const statuses = statusMap.get(url) || [];
          results[url] = statuses.map(s => {
            const sb = getStoryboard(s.storyboard_id);
            return {
              storyboard_id: s.storyboard_id,
              title: sb?.title || s.storyboard_id,
              category: sb?.category || null,
              track: sb?.track || null,
              status: s.status,
              steps_passed: s.steps_passed,
              steps_total: s.steps_total,
              last_tested_at: s.last_tested_at?.toISOString() || null,
              last_passed_at: s.last_passed_at?.toISOString() || null,
            };
          });
        }

        const invalidCount = agent_urls.length - validUrls.length;
        res.json({
          agents: results,
          ...(invalidCount > 0 && { invalid_urls: invalidCount }),
        });
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to get batch storyboard status");
        res.status(500).json({ error: "Failed to get batch storyboard status" });
      }
    },
  );

  const complianceWriteMiddleware = authMiddleware ? [authMiddleware] : [];

  /**
   * Resolve the workos_organization_id of the org that owns this agent,
   * for the authenticated user. Returns null if the user is not a member
   * of any org whose member_profile lists the agent (403 case).
   *
   * Mirrors the query driving the `auth-status` endpoint so the org id the
   * UI surfaces ("Auth configured via OAuth") is the one we consult for
   * Test-your-agent credentials.
   */
  async function resolveAgentOwnerOrg(userId: string, agentUrl: string): Promise<string | null> {
    try {
      const result = await query<{ workos_organization_id: string }>(
        `SELECT mp.workos_organization_id
         FROM member_profiles mp
         JOIN organization_memberships om
           ON om.workos_organization_id = mp.workos_organization_id
         WHERE mp.agents @> $1::jsonb
           AND om.workos_user_id = $2
         LIMIT 1`,
        [JSON.stringify([{ url: agentUrl }]), userId],
      );
      return result.rows[0]?.workos_organization_id ?? null;
    } catch {
      return null;
    }
  }

  async function verifyAgentOwnership(userId: string, agentUrl: string): Promise<boolean> {
    return (await resolveAgentOwnerOrg(userId, agentUrl)) !== null;
  }

  // Shared SSRF-resistant URL validator lives in utils/url-security.ts so the
  // Addie tool handler (save_agent) can apply identical rules to OAuth
  // token_endpoint values — any divergence reopens the cloud-metadata
  // / private-IP exfiltration surface we closed here.
  const validateAgentUrlParam = validateExternalUrl;

  /**
   * Ensure an agent_context exists so the UI can hand the user a working
   * `/api/oauth/agent/start?agent_context_id=...` link even if they never
   * opened the connect form. Idempotent.
   */
  async function ensureAgentContextId(orgId: string, agentUrl: string, userId: string): Promise<string | null> {
    try {
      let context = await agentContextDb.getByOrgAndUrl(orgId, agentUrl);
      if (!context) {
        context = await agentContextDb.create({
          organization_id: orgId,
          agent_url: agentUrl,
          created_by: userId,
        });
      }
      return context.id;
    } catch (err) {
      logger.warn({ err, orgId, agentUrl }, "Failed to ensure agent context for OAuth challenge");
      return null;
    }
  }

  router.put("/registry/agents/:encodedUrl/lifecycle", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }

      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const isOwner = await verifyAgentOwnership(req.user.id, agentUrl);
      if (!isOwner) {
        return res.status(403).json({ error: "You do not have permission to modify this agent" });
      }

      const { lifecycle_stage } = req.body;

      const validStages = ["development", "testing", "production", "deprecated"];
      if (!lifecycle_stage || !validStages.includes(lifecycle_stage)) {
        return res.status(400).json({ error: `lifecycle_stage must be one of: ${validStages.join(", ")}` });
      }

      const metadata = await complianceDb.upsertRegistryMetadata(agentUrl, {
        lifecycle_stage: lifecycle_stage as LifecycleStage,
      });

      res.json(metadata);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to update lifecycle stage");
      res.status(500).json({ error: "Failed to update lifecycle stage" });
    }
  });

  router.put("/registry/agents/:encodedUrl/compliance/opt-out", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }

      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const isOwner = await verifyAgentOwnership(req.user.id, agentUrl);
      if (!isOwner) {
        return res.status(403).json({ error: "You do not have permission to modify this agent" });
      }

      const { opt_out } = req.body;

      if (typeof opt_out !== "boolean") {
        return res.status(400).json({ error: "opt_out must be a boolean" });
      }

      const metadata = await complianceDb.upsertRegistryMetadata(agentUrl, {
        compliance_opt_out: opt_out,
      });

      res.json(metadata);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to update compliance opt-out");
      res.status(500).json({ error: "Failed to update compliance opt-out" });
    }
  });

  // ── Agent Monitoring Controls ──────────────────────────────────

  router.get("/registry/agents/:encodedUrl/monitoring/settings", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const isOwner = await verifyAgentOwnership(req.user.id, agentUrl);
      if (!isOwner) {
        return res.status(403).json({ error: "You do not have permission to view this agent" });
      }

      const settings = await complianceDb.getMonitoringSettings(agentUrl);
      res.json(settings);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get monitoring settings");
      res.status(500).json({ error: "Failed to get monitoring settings" });
    }
  });

  router.put("/registry/agents/:encodedUrl/monitoring/pause", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const isOwner = await verifyAgentOwnership(req.user.id, agentUrl);
      if (!isOwner) {
        return res.status(403).json({ error: "You do not have permission to modify this agent" });
      }

      const { paused } = req.body;
      if (typeof paused !== "boolean") {
        return res.status(400).json({ error: "paused must be a boolean" });
      }

      await complianceDb.updateMonitoringPaused(agentUrl, paused);
      const settings = await complianceDb.getMonitoringSettings(agentUrl);
      res.json(settings);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to update monitoring pause");
      res.status(500).json({ error: "Failed to update monitoring pause" });
    }
  });

  router.put("/registry/agents/:encodedUrl/monitoring/interval", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const isOwner = await verifyAgentOwnership(req.user.id, agentUrl);
      if (!isOwner) {
        return res.status(403).json({ error: "You do not have permission to modify this agent" });
      }

      const { interval_hours } = req.body;
      if (typeof interval_hours !== "number" || !Number.isInteger(interval_hours) || interval_hours < 6 || interval_hours > 168) {
        return res.status(400).json({ error: "interval_hours must be an integer between 6 and 168" });
      }

      await complianceDb.updateCheckInterval(agentUrl, interval_hours);
      const settings = await complianceDb.getMonitoringSettings(agentUrl);
      res.json(settings);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to update check interval");
      res.status(500).json({ error: "Failed to update check interval" });
    }
  });

  router.get("/registry/agents/:encodedUrl/monitoring/requests", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const isOwner = await verifyAgentOwnership(req.user.id, agentUrl);
      if (!isOwner) {
        return res.status(403).json({ error: "You do not have permission to view this agent" });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const since = typeof req.query.since === "string" ? req.query.since : undefined;

      const [requests, total] = await Promise.all([
        getRequestLog(agentUrl, { limit, since }),
        getRequestCount(agentUrl),
      ]);

      res.json({ agent_url: agentUrl, requests, count: requests.length, total });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get monitoring requests");
      res.status(500).json({ error: "Failed to get monitoring requests" });
    }
  });

  router.get("/registry/agents/:encodedUrl/auth-status", ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }

      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      // Verify ownership and get org ID in one query
      const orgResult = await query(
        `SELECT mp.workos_organization_id
         FROM member_profiles mp
         JOIN organization_memberships om
           ON om.workos_organization_id = mp.workos_organization_id
         WHERE mp.agents @> $1::jsonb
           AND om.workos_user_id = $2
         LIMIT 1`,
        [JSON.stringify([{ url: agentUrl }]), req.user.id],
      );

      const noAuthResponse = {
        has_auth: false,
        agent_context_id: null,
        auth_type: null,
        has_oauth_token: false,
        has_valid_oauth: false,
        oauth_token_expires_at: null,
        has_oauth_client_credentials: false,
      };

      if (orgResult.rows.length === 0) {
        return res.json(noAuthResponse);
      }

      const orgId = orgResult.rows[0].workos_organization_id;
      const context = await agentContextDb.getByOrgAndUrl(orgId, agentUrl);

      if (!context) {
        return res.json(noAuthResponse);
      }

      const hasValidOAuth = agentContextDb.hasValidOAuthTokens(context);
      const hasCC = context.has_oauth_client_credentials;

      res.json({
        has_auth: context.has_auth_token || hasValidOAuth || hasCC,
        agent_context_id: context.id,
        auth_type: context.has_auth_token
          ? context.auth_type
          : hasValidOAuth
            ? "oauth"
            : hasCC
              ? "oauth_client_credentials"
              : null,
        has_oauth_token: context.has_oauth_token,
        has_valid_oauth: hasValidOAuth,
        oauth_token_expires_at: context.oauth_token_expires_at?.toISOString() || null,
        has_oauth_client_credentials: hasCC,
      });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get agent auth status");
      res.status(500).json({ error: "Failed to get agent auth status" });
    }
  });

  router.put("/registry/agents/:encodedUrl/connect", brandCreationRateLimiter, ...complianceWriteMiddleware, async (req, res) => {
    try {
      const agentUrl = decodeURIComponent(req.params.encodedUrl);
      if (!validateAgentUrlParam(agentUrl)) {
        return res.status(400).json({ error: "Invalid agent URL" });
      }

      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const { auth_token, auth_type } = req.body;

      if (auth_token && typeof auth_token !== "string") {
        return res.status(400).json({ error: "auth_token must be a string" });
      }
      if (auth_token && auth_token.length > 4096) {
        return res.status(400).json({ error: "auth_token exceeds maximum length" });
      }

      const validAuthTypes = ["bearer", "basic"];
      if (auth_token && auth_type && !validAuthTypes.includes(auth_type)) {
        return res.status(400).json({ error: `Invalid auth_type. Valid types: ${validAuthTypes.join(", ")}` });
      }
      const resolvedAuthType = validAuthTypes.includes(auth_type) ? auth_type : "bearer";

      // Verify ownership and get org ID in a single query
      const orgResult = await query(
        `SELECT mp.workos_organization_id
         FROM member_profiles mp
         JOIN organization_memberships om
           ON om.workos_organization_id = mp.workos_organization_id
         WHERE mp.agents @> $1::jsonb
           AND om.workos_user_id = $2
         LIMIT 1`,
        [JSON.stringify([{ url: agentUrl }]), req.user.id],
      );

      if (orgResult.rows.length === 0) {
        return res.status(403).json({ error: "You do not have permission to modify this agent" });
      }

      const orgId = orgResult.rows[0].workos_organization_id;

      // Get or create agent context
      let context = await agentContextDb.getByOrgAndUrl(orgId, agentUrl);
      if (!context) {
        context = await agentContextDb.create({
          organization_id: orgId,
          agent_url: agentUrl,
          created_by: req.user.id,
        });
      }

      // Save auth token if provided
      if (auth_token) {
        await agentContextDb.saveAuthToken(context.id, auth_token, resolvedAuthType);
      }

      res.json({
        connected: true,
        has_auth: !!auth_token || context.has_auth_token,
        agent_context_id: context.id,
      });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to connect agent");
      res.status(500).json({ error: "Failed to connect agent" });
    }
  });

  /**
   * Save OAuth 2.0 client-credentials (RFC 6749 §4.4) for an agent. Parallel
   * to /connect but for the machine-to-machine flow. Stored encrypted at
   * rest; the SDK exchanges at `token_endpoint` before every call and
   * refreshes on 401. `client_secret` may be a `$ENV:VAR_NAME` reference —
   * the SDK resolves at exchange time, the server just stores the value as
   * written (encrypted uniformly either way).
   */
  router.put(
    "/registry/agents/:encodedUrl/oauth-client-credentials",
    brandCreationRateLimiter,
    ...complianceWriteMiddleware,
    async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.encodedUrl);
        if (!validateAgentUrlParam(agentUrl)) {
          return res.status(400).json({ error: "Invalid agent URL" });
        }
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const parsed = parseOAuthClientCredentialsInput(req.body, {
          validateTokenEndpoint: validateExternalUrl,
        });
        if (!parsed.ok) {
          return res.status(400).json({ error: parsed.error, code: parsed.code, field: parsed.field });
        }

        const orgResult = await query<{ workos_organization_id: string }>(
          `SELECT mp.workos_organization_id
           FROM member_profiles mp
           JOIN organization_memberships om
             ON om.workos_organization_id = mp.workos_organization_id
           WHERE mp.agents @> $1::jsonb
             AND om.workos_user_id = $2
           LIMIT 1`,
          [JSON.stringify([{ url: agentUrl }]), req.user.id],
        );
        if (orgResult.rows.length === 0) {
          return res.status(403).json({ error: "You do not have permission to modify this agent" });
        }
        const orgId = orgResult.rows[0].workos_organization_id;

        let context = await agentContextDb.getByOrgAndUrl(orgId, agentUrl);
        if (!context) {
          context = await agentContextDb.create({
            organization_id: orgId,
            agent_url: agentUrl,
            created_by: req.user.id,
          });
        }

        await agentContextDb.saveOAuthClientCredentials(context.id, parsed.creds);

        res.json({
          connected: true,
          has_auth: true,
          agent_context_id: context.id,
          auth_type: "oauth_client_credentials",
        });
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to save oauth client credentials");
        res.status(500).json({ error: "Failed to save OAuth client credentials" });
      }
    },
  );

  /**
   * Dry-run the saved client-credentials config by exchanging at the token
   * endpoint and discarding the result. Converts the dashboard's "save and
   * pray and wait for the next heartbeat" flow into "save and verify in
   * under 2s" — see #2809. Returns `{ok: true, latency_ms}` on a successful
   * exchange, or `{ok: false, error: {kind, message, ...}}` mapping the
   * SDK's ClientCredentialsExchangeError kinds (oauth / malformed / network).
   */
  router.post(
    "/registry/agents/:encodedUrl/oauth-client-credentials/test",
    brandCreationRateLimiter,
    ...complianceWriteMiddleware,
    async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.encodedUrl);
        if (!validateAgentUrlParam(agentUrl)) {
          return res.status(400).json({ error: "Invalid agent URL" });
        }
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const orgId = await resolveAgentOwnerOrg(req.user.id, agentUrl);
        if (!orgId) {
          return res.status(403).json({ error: "You do not have permission to test this agent" });
        }

        const creds = await agentContextDb.getOAuthClientCredentialsByOrgAndUrl(orgId, agentUrl);
        if (!creds) {
          return res.status(404).json({ error: "No client-credentials config saved for this agent. Save credentials first, then test." });
        }

        const start = Date.now();
        try {
          await exchangeClientCredentials(creds);
          return res.json({ ok: true, latency_ms: Date.now() - start });
        } catch (err) {
          if (err instanceof ClientCredentialsExchangeError) {
            const body: Record<string, unknown> = {
              ok: false,
              error: {
                kind: err.kind,
                message: err.message,
              },
              latency_ms: Date.now() - start,
            };
            const errorRec = body.error as Record<string, unknown>;
            if (err.oauthError) errorRec.oauth_error = err.oauthError;
            if (err.oauthErrorDescription) errorRec.oauth_error_description = err.oauthErrorDescription;
            if (err.httpStatus) errorRec.http_status = err.httpStatus;
            return res.json(body);
          }
          throw err;
        }
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to test oauth client credentials");
        res.status(500).json({ error: "Failed to test OAuth client credentials" });
      }
    },
  );

  // ── Storyboards ────────────────────────────────────────────────

  router.get("/storyboards", async (req, res) => {
    try {
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const results = listStoryboards(category);
      res.json({ storyboards: results, count: results.length });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to list storyboards");
      res.status(500).json({ error: "Failed to list storyboards" });
    }
  });

  router.get("/storyboards/:id", async (req, res) => {
    try {
      const storyboard = getStoryboard(req.params.id);
      if (!storyboard) {
        return res.status(404).json({ error: "Storyboard not found" });
      }

      const testKit = getTestKitForStoryboard(req.params.id);
      res.json({ storyboard, test_kit: testKit || null });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Failed to get storyboard");
      res.status(500).json({ error: "Failed to get storyboard" });
    }
  });

  router.get("/registry/agents/:encodedUrl/applicable-storyboards", storyboardEvalRateLimiter, ...complianceWriteMiddleware, async (req, res) => {
    const agentUrl = decodeURIComponent(req.params.encodedUrl);
    if (!validateAgentUrlParam(agentUrl)) {
      return res.status(400).json({ error: "Invalid agent URL" });
    }

    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const orgId = await resolveAgentOwnerOrg(req.user.id, agentUrl);
    if (!orgId) {
      return res.status(403).json({ error: "You do not have permission to test this agent" });
    }

    try {
      const auth = await resolveUserAgentAuth(agentContextDb, orgId, agentUrl, logger);
      const sdkAuth = await adaptAuthForSdk(auth, { tokenEndpointLabel: `test-agent:${agentUrl}` });

      let profile;
      try {
        const caps = await testCapabilityDiscovery(agentUrl, { ...(sdkAuth && { auth: sdkAuth }) });
        profile = caps.profile;

        // The SDK swallows the agent's 401 into steps[0].error; surface it as
        // a structured challenge so the UI can route the user to the OAuth
        // flow instead of rendering a storyboard list they can't run.
        const probeStep = caps.steps?.[0];
        if (probeStep && !probeStep.passed && isOAuthRequiredErrorMessage(probeStep.error)) {
          const agentContextId = await ensureAgentContextId(orgId, agentUrl, req.user.id);
          return res.status(422).json({
            error: "This agent requires OAuth authorization. Connect via OAuth to run storyboards.",
            needs_oauth: true,
            ...(agentContextId && { agent_context_id: agentContextId }),
          });
        }
      } catch (connectErr) {
        if (!auth) {
          return res.status(422).json({
            error: "Agent requires authentication. Save an auth token first using the connect form.",
            needs_auth: true,
          });
        }
        throw connectErr;
      }

      const supportedProtocols = profile?.supported_protocols ?? [];
      const specialisms = profile?.specialisms ?? [];

      let resolved;
      try {
        resolved = resolveStoryboardsForCapabilities({
          supported_protocols: supportedProtocols,
          specialisms,
        });
      } catch (resolveErr) {
        // Fail-closed: agent capabilities are malformed. Distinguish the two
        // concrete cases the resolver throws for — parent-protocol-missing vs
        // unknown-specialism — via the shared presenter so the response
        // envelope stays consistent. Consumers switch on `error_kind`.
        const capsError = classifyCapabilityResolutionError(resolveErr);
        let knownSpecialisms: string[] = [];
        try {
          knownSpecialisms = loadComplianceIndex().specialisms.map(s => s.id).sort();
        } catch (indexErr) {
          logger.warn({ err: indexErr }, "Failed to load compliance index for 422 response");
        }

        if (capsError) {
          const presentation = presentCapabilityResolutionError(capsError);
          logger.warn(
            { agentUrl, ...presentation.logFields, supportedProtocols, specialisms },
            presentation.logMsg,
          );
          const legacyFlag =
            capsError.kind === 'specialism_parent_protocol_missing'
              ? { specialism_parent_protocol_missing: true }
              : { unknown_specialism: true };
          return res.status(422).json({
            error: presentation.headline,
            ...presentation.restBody,
            ...legacyFlag,
            declared_specialisms: specialisms,
            declared_protocols: supportedProtocols,
            known_specialisms: knownSpecialisms,
          });
        }

        logger.warn({ err: resolveErr, agentUrl, supportedProtocols, specialisms }, "Capability resolution failed with unclassified error");
        return res.status(422).json({
          error: "Agent capability resolution failed. The cache may be stale, or the agent's response is malformed.",
          declared_specialisms: specialisms,
          declared_protocols: supportedProtocols,
          known_specialisms: knownSpecialisms,
        });
      }

      // Drop empty bundles — upstream catalog occasionally ships stubs.
      const bundles = resolved.bundles
        .filter(b => b.storyboards.length > 0)
        .map(b => ({
          kind: b.ref.kind,
          id: b.ref.id,
          storyboards: b.storyboards.map(sb => ({
            id: sb.id,
            title: sb.title,
            summary: sb.summary,
            step_count: sb.phases.reduce((sum, p) => sum + p.steps.length, 0),
          })),
        }));

      const responseBody: Record<string, unknown> = {
        agent_url: agentUrl,
        agent_name: profile?.name || "Unknown",
        supported_protocols: supportedProtocols,
        specialisms,
        bundles,
        total_storyboards: bundles.reduce((n, b) => n + b.storyboards.length, 0),
      };
      if (profile?.capabilities_probe_error) {
        // Cap length + strip control chars. The string is agent-reported and
        // therefore untrusted — consumers should treat it as informational
        // only (documented on the OpenAPI description).
        responseBody.capabilities_probe_error = String(profile.capabilities_probe_error)
          .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
          .slice(0, 500);
      }

      res.json(responseBody);
    } catch (error) {
      logger.warn({ err: error, agentUrl }, "Failed to resolve applicable storyboards");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout" });
      }

      return res.status(500).json({
        error: "Failed to probe agent capabilities",
        reason: classifyProbeError(error),
      });
    }
  });

  // Step-by-step storyboard execution
  router.post(
    "/registry/agents/:encodedUrl/storyboard/:storyboardId/step/:stepId",
    storyboardStepRateLimiter,
    ...complianceWriteMiddleware,
    async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.encodedUrl);
        if (!validateAgentUrlParam(agentUrl)) {
          return res.status(400).json({ error: "Invalid agent URL" });
        }

        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const orgId = await resolveAgentOwnerOrg(req.user.id, agentUrl);
        if (!orgId) {
          return res.status(403).json({ error: "You do not have permission to test this agent" });
        }

        const storyboard = getComplianceStoryboardById(req.params.storyboardId);
        if (!storyboard) {
          return res.status(404).json({ error: "Storyboard not found" });
        }

        const auth = await resolveUserAgentAuth(agentContextDb, orgId, agentUrl, logger);

        const { context, dry_run } = req.body;
        if (context && (typeof context !== "object" || Array.isArray(context))) {
          return res.status(400).json({ error: "context must be a JSON object" });
        }
        if (context && JSON.stringify(context).length > 50_000) {
          return res.status(400).json({ error: "context too large" });
        }

        const result = await runStoryboardStep(agentUrl, storyboard, req.params.stepId, {
          ...(auth && { auth }),
          ...(context && { context }),
        });

        if (!result.passed && isOAuthRequiredErrorMessage(result.error)) {
          const agentContextId = await ensureAgentContextId(orgId, agentUrl, req.user.id);
          return res.json({
            ...result,
            needs_oauth: true,
            ...(agentContextId && { agent_context_id: agentContextId }),
          });
        }

        res.json(result);
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to run storyboard step");
        res.status(500).json({ error: "Failed to run storyboard step" });
      }
    },
  );

  // Get first step preview for a storyboard (no agent call needed)
  router.get(
    "/storyboards/:storyboardId/first-step",
    async (req, res) => {
      try {
        const storyboard = getComplianceStoryboardById(req.params.storyboardId);
        if (!storyboard) {
          return res.status(404).json({ error: "Storyboard not found" });
        }

        const preview = getFirstStepPreview(storyboard);
        if (!preview) {
          return res.status(404).json({ error: "Storyboard has no steps" });
        }

        res.json({ storyboard: { id: storyboard.id, title: storyboard.title }, step: preview });
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to get first step preview");
        res.status(500).json({ error: "Failed to get first step preview" });
      }
    },
  );

  router.post(
    "/registry/agents/:encodedUrl/storyboard/:storyboardId/run",
    storyboardEvalRateLimiter,
    ...complianceWriteMiddleware,
    async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.encodedUrl);
        if (!validateAgentUrlParam(agentUrl)) {
          return res.status(400).json({ error: "Invalid agent URL" });
        }

        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const orgId = await resolveAgentOwnerOrg(req.user.id, agentUrl);
        if (!orgId) {
          return res.status(403).json({ error: "You do not have permission to test this agent" });
        }

        const storyboard = getStoryboard(req.params.storyboardId);
        if (!storyboard) {
          return res.status(404).json({ error: "Storyboard not found" });
        }

        const auth = await resolveUserAgentAuth(agentContextDb, orgId, agentUrl, logger);
        const sdkAuth = await adaptAuthForSdk(auth, { tokenEndpointLabel: `run-storyboard:${agentUrl}` });

        const complyResult = await comply(agentUrl, {
          timeout_ms: 90_000,
          storyboards: [req.params.storyboardId],
          ...(sdkAuth && { auth: sdkAuth }),
        });

        if (complyResult.overall_status === 'auth_required') {
          const agentContextId = await ensureAgentContextId(orgId, agentUrl, req.user.id);
          return res.status(422).json({
            error: "Agent requires OAuth authorization. Connect via OAuth to run this storyboard.",
            needs_oauth: true,
            ...(agentContextId && { agent_context_id: agentContextId }),
          });
        }

        // Record the run (pass storyboard ID for per-storyboard status materialization)
        const metadata = await complianceDb.getRegistryMetadata(agentUrl);
        await complianceDb.recordComplianceRun(
          complianceResultToDbInput(complyResult, agentUrl, metadata?.lifecycle_stage || "development", "manual", [req.params.storyboardId]),
        );

        // Annotate storyboard phases with comply results
        const annotatedPhases = storyboard.phases.map((phase) => ({
          ...phase,
          steps: phase.steps.map((step) => {
            // Find matching comply scenario results
            const matchingScenarios = step.comply_scenario
              ? complyResult.tracks.flatMap((t) =>
                  t.scenarios.filter((s) => s.scenario === step.comply_scenario),
                )
              : [];

            const passed = matchingScenarios.length > 0
              ? matchingScenarios.every((s) => s.overall_passed)
              : null;

            return {
              ...step,
              result: {
                passed,
                scenarios: matchingScenarios,
              },
            };
          }),
        }));

        const testKit = getTestKitForStoryboard(req.params.storyboardId);

        res.json({
          storyboard: {
            id: storyboard.id,
            title: storyboard.title,
            category: storyboard.category,
            narrative: storyboard.narrative,
          },
          agent: {
            url: agentUrl,
            profile: complyResult.agent_profile,
          },
          phases: annotatedPhases,
          summary: complyResult.summary,
          observations: complyResult.observations,
          total_duration_ms: complyResult.total_duration_ms,
          test_kit: testKit || null,
        });
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to run storyboard");
        res.status(500).json({ error: "Failed to run storyboard evaluation" });
      }
    },
  );

  router.post(
    "/registry/agents/:encodedUrl/storyboard/:storyboardId/compare",
    storyboardEvalRateLimiter,
    ...complianceWriteMiddleware,
    async (req, res) => {
      try {
        const agentUrl = decodeURIComponent(req.params.encodedUrl);
        if (!validateAgentUrlParam(agentUrl)) {
          return res.status(400).json({ error: "Invalid agent URL" });
        }

        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }

        const orgId = await resolveAgentOwnerOrg(req.user.id, agentUrl);
        if (!orgId) {
          return res.status(403).json({ error: "You do not have permission to test this agent" });
        }

        const storyboard = getStoryboard(req.params.storyboardId);
        if (!storyboard) {
          return res.status(404).json({ error: "Storyboard not found" });
        }

        const auth = await resolveUserAgentAuth(agentContextDb, orgId, agentUrl, logger);
        const sdkAuth = await adaptAuthForSdk(auth, { tokenEndpointLabel: `run-storyboard-compare:${agentUrl}` });
        const storyboardIds = [req.params.storyboardId];

        const [userResult, referenceResult] = await Promise.all([
          comply(agentUrl, {
            timeout_ms: 90_000,
            storyboards: storyboardIds,
            ...(sdkAuth && { auth: sdkAuth }),
          }),
          comply(PUBLIC_TEST_AGENT.url, {
            timeout_ms: 90_000,
            storyboards: storyboardIds,
            auth: { type: "bearer", token: PUBLIC_TEST_AGENT.token },
          }),
        ]);

        if (userResult.overall_status === 'auth_required') {
          const agentContextId = await ensureAgentContextId(orgId, agentUrl, req.user.id);
          return res.status(422).json({
            error: "Agent requires OAuth authorization. Connect via OAuth to compare against the reference agent.",
            needs_oauth: true,
            ...(agentContextId && { agent_context_id: agentContextId }),
          });
        }

        // Annotate storyboard steps with both results
        const comparisonPhases = storyboard.phases.map((phase) => ({
          ...phase,
          steps: phase.steps.map((step) => {
            const findScenarios = (result: typeof userResult) =>
              step.comply_scenario
                ? result.tracks.flatMap((t) =>
                    t.scenarios.filter((s) => s.scenario === step.comply_scenario),
                  )
                : [];

            const userScenarios = findScenarios(userResult);
            const refScenarios = findScenarios(referenceResult);

            return {
              ...step,
              user_result: {
                passed: userScenarios.length > 0 ? userScenarios.every((s) => s.overall_passed) : null,
                scenarios: userScenarios,
              },
              reference_result: {
                passed: refScenarios.length > 0 ? refScenarios.every((s) => s.overall_passed) : null,
                scenarios: refScenarios,
              },
            };
          }),
        }));

        res.json({
          storyboard: {
            id: storyboard.id,
            title: storyboard.title,
            category: storyboard.category,
          },
          user_agent: {
            url: agentUrl,
            profile: userResult.agent_profile,
            summary: userResult.summary,
          },
          reference_agent: {
            url: PUBLIC_TEST_AGENT.url,
            name: PUBLIC_TEST_AGENT.name,
            profile: referenceResult.agent_profile,
            summary: referenceResult.summary,
          },
          phases: comparisonPhases,
          total_duration_ms: Math.max(userResult.total_duration_ms, referenceResult.total_duration_ms),
        });
      } catch (error) {
        logger.error({ err: error, path: req.path }, "Failed to run storyboard comparison");
        res.status(500).json({ error: "Failed to run storyboard comparison" });
      }
    },
  );

  // ── Publishers ──────────────────────────────────────────────────

  router.get("/registry/publishers", async (_req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const publishers = await federatedIndex.listAllPublishers();
      res.json({ publishers, count: publishers.length });
    } catch (error) {
      logger.error({ err: error, path: _req.path }, "Failed to list publishers");
      res.status(500).json({ error: "Failed to list publishers" });
    }
  });

  router.get("/registry/stats", async (_req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const stats = await federatedIndex.getStats();
      res.json(stats);
    } catch (error) {
      logger.error({ err: error, path: _req.path }, "Failed to get registry stats");
      res.status(500).json({ error: "Failed to get registry stats" });
    }
  });

  // ── Lookups & Authorization ───────────────────────────────────

  router.get("/registry/operator", optAuth, async (req, res) => {
    const rawDomain = req.query.domain as string;
    if (!rawDomain) {
      return res.status(400).json({ error: "Missing required query param: domain" });
    }

    try {
      const domain = extractDomain(rawDomain);
      if (!isValidDomain(domain)) {
        return res.status(400).json({ error: "Invalid domain" });
      }
      const memberDb = new MemberDatabase();
      const federatedIndex = crawler.getFederatedIndex();

      const profile = await memberDb.getProfileByDomain(domain);
      const member = profile
        ? { slug: profile.slug, display_name: profile.display_name }
        : null;

      const callerOrgId = await resolveCallerOrgId(req);

      let includeMembersOnly = false;
      if (callerOrgId) {
        const org = await orgDb.getOrganization(callerOrgId);
        if (org && hasApiAccess(resolveMembershipTier(org))) {
          includeMembersOnly = true;
        }
      }

      const isProfileOwner = !!(
        callerOrgId && profile?.workos_organization_id && profile.workos_organization_id === callerOrgId
      );

      const displayName = profile?.display_name || domain;
      const agentConfigs = (profile?.agents || []).filter(a => {
        if (a.visibility === 'public') return true;
        if (includeMembersOnly && a.visibility === 'members_only') return true;
        if (isProfileOwner && a.visibility === 'private') return true;
        return false;
      }).slice(0, 20);

      const agents = await Promise.all(
        agentConfigs.map(async (ac) => {
          const auths = await federatedIndex.getAuthorizationsForAgent(ac.url);
          return {
            url: ac.url,
            name: ac.name || displayName,
            type: ac.type || "unknown",
            authorized_by: auths.map(a => ({
              publisher_domain: a.publisher_domain,
              authorized_for: a.authorized_for,
              source: a.source,
            })),
          };
        })
      );

      res.json({ domain, member, agents });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Operator lookup failed");
      res.status(500).json({ error: "Operator lookup failed" });
    }
  });

  router.get("/registry/publisher", async (req, res) => {
    const rawDomain = req.query.domain as string;
    if (!rawDomain) {
      return res.status(400).json({ error: "Missing required query param: domain" });
    }

    try {
      const domain = extractDomain(rawDomain);
      if (!isValidDomain(domain)) {
        return res.status(400).json({ error: "Invalid domain" });
      }
      const memberDb = new MemberDatabase();
      const federatedIndex = crawler.getFederatedIndex();

      const [profile, properties, authorizations, adagentsValid] = await Promise.all([
        memberDb.getProfileByDomain(domain),
        federatedIndex.getPropertiesForDomain(domain),
        federatedIndex.getAuthorizationsForDomain(domain),
        federatedIndex.hasValidAdagents(domain),
      ]);

      const member = profile
        ? { slug: profile.slug, display_name: profile.display_name }
        : null;

      res.json({
        domain,
        member,
        adagents_valid: adagentsValid,
        properties: properties.map(p => ({
          id: p.property_id,
          type: p.property_type,
          name: p.name,
          identifiers: p.identifiers,
          tags: p.tags,
        })),
        authorized_agents: authorizations.map(a => ({
          url: a.agent_url,
          authorized_for: a.authorized_for,
          source: a.source,
        })),
      });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Publisher lookup failed");
      res.status(500).json({ error: "Publisher lookup failed" });
    }
  });

  router.get("/registry/lookup/domain/:domain", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const domain = req.params.domain;
      const result = await federatedIndex.lookupDomain(domain);
      res.json(result);
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Domain lookup failed");
      res.status(500).json({ error: "Domain lookup failed" });
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
      logger.error({ err: error, path: req.path }, "Property lookup failed");
      res.status(500).json({ error: "Property lookup failed" });
    }
  });

  router.get("/registry/lookup/agent/:agentUrl/domains", async (req, res) => {
    try {
      const federatedIndex = crawler.getFederatedIndex();
      const agentUrl = decodeURIComponent(req.params.agentUrl);
      const domains = await federatedIndex.getDomainsForAgent(agentUrl);
      res.json({ agent_url: agentUrl, domains, count: domains.length });
    } catch (error) {
      logger.error({ err: error, path: req.path }, "Agent domain lookup failed");
      res.status(500).json({ error: "Agent domain lookup failed" });
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
      logger.error({ err: error, path: req.path }, "Product authorization validation failed");
      res.status(500).json({ error: "Product authorization validation failed" });
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
      logger.error({ err: error, path: req.path }, "Property expansion failed");
      // codeql[js/user-controlled-bypass] - static error message, no user input in response
      res.status(500).json({ error: "Property expansion failed" });
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
      logger.error({ err: error, path: req.path }, "Property authorization check failed");
      res.status(500).json({ error: "Property authorization check failed" });
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

      // Diagnostic agent-type inference. Shared helper between this
      // endpoint and the equivalent in http.ts so polarity stays in sync
      // across both. Pre-#3540 returned 'buying' for sales-tool exposure;
      // #3774 corrected polarity and consolidated.
      const agentType = inferDiagnosticAgentType(
        tools.map((t: { name: string }) => t.name),
      );

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
          const result = await client.getProducts({ buying_mode: 'wholesale' });
          if (result.data?.products) {
            stats.product_count = result.data.products.length;
          }
        } catch (statsError) {
          logger.debug({ err: statsError, url }, "Failed to fetch products");
        }
      }

      return res.json({ name: agentName, description: agentInfo.description, protocols, type: agentType, stats });
    } catch (error) {
      logger.warn({ err: error, url }, "Public agent discovery error");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout", message: "Agent did not respond within 10 seconds" });
      }

      return res.status(500).json({ error: "Agent discovery failed" });
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
          return {
            format_id: format.format_id,
            name: format.name,
            description: format.description,
            example_url: format.example_url,
            renders: format.renders,
            assets: format.assets,
            output_format_ids: format.output_format_ids,
            agent_url: format.agent_url,
          };
        }),
      });
    } catch (error) {
      logger.warn({ err: error, url }, "Agent formats fetch failed");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout", message: "Agent did not respond within the timeout period" });
      }

      return res.status(502).json({ error: "Failed to fetch formats" });
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

      const result = await client.getProducts({ buying_mode: 'wholesale' });
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
      logger.warn({ err: error, url }, "Agent products fetch failed");

      if (error instanceof Error && error.name === "TimeoutError") {
        return res.status(504).json({ error: "Connection timeout", message: "Agent did not respond within the timeout period" });
      }

      return res.status(502).json({ error: "Failed to fetch products" });
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

      return res.status(500).json({ error: "Publisher validation failed" });
    }
  });

  // ── Brand hosting: serve brand.json for hosted members ─────────
  // Public endpoint — target of authoritative_location pointer files.
  // Members place {"authoritative_location":"<this URL>"} at /.well-known/brand.json.

  // brand.json served at /brands/:domain/brand.json (in http.ts, not here)

  // ── Brand setup: link member to brand registry ───────────────────
  // Creates (or updates) a hosted brand entry and links it to the authenticated member's profile.
  // Returns the pointer snippet for the member to place at /.well-known/brand.json on their domain.

  const setupBrandMiddleware = authMiddleware ? [authMiddleware, brandCreationRateLimiter] : [brandCreationRateLimiter];

  router.post("/brands/setup-my-brand", ...setupBrandMiddleware, async (req, res) => {
    const { brand_name, logo_url, brand_color } = req.body;
    const rawDomain = req.body.domain as string;

    if (!rawDomain || typeof rawDomain !== "string") {
      return res.status(400).json({ error: "domain is required" });
    }
    if (!brand_name || typeof brand_name !== "string") {
      return res.status(400).json({ error: "brand_name is required" });
    }

    const domain = extractDomain(rawDomain).replace(/^www\./, "");

    const domainPattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
    if (!domainPattern.test(domain)) {
      return res.status(400).json({ error: "Invalid domain format" });
    }

    try {
      // Check whether brand.json is already live on their domain
      let hasBrandJson = false;
      try {
        const validation = await brandManager.validateDomain(domain);
        hasBrandJson = validation.valid;
      } catch {
        // Validation failure is non-fatal — domain just doesn't have brand.json yet
      }

      // Look up the user's primary org once — used for both hosted brand creation and profile linking
      const orgId = await resolvePrimaryOrganization(req.user!.id);

      // Verify the requested domain belongs to this org (matches a WorkOS-verified domain or subdomain).
      // Skipped in dev mode (DEV_USER_EMAIL set) since dev orgs are not in WorkOS.
      const devMode = !!(process.env.DEV_USER_EMAIL && process.env.DEV_USER_ID);
      if (!devMode && orgId) {
        const orgDomainsResult = await query<{ domain: string }>(
          'SELECT domain FROM organization_domains WHERE workos_organization_id = $1 AND verified = true',
          [orgId]
        );
        const orgDomains = orgDomainsResult.rows.map(r => r.domain.toLowerCase());
        const domainBelongsToOrg = orgDomains.some(
          od => domain === od || domain.endsWith(`.${od}`)
        );
        if (!domainBelongsToOrg) {
          return res.status(403).json({
            error: 'This domain is not associated with your organization',
          });
        }
      }

      // Only create a hosted entry if they don't already self-host brand.json
      if (!hasBrandJson) {
        const discovered = await brandDb.getDiscoveredBrandByDomain(domain);

        // If the community has already built out approved brand data, adopt it directly.
        // Otherwise build a minimal entry from the request params.
        let brandJson: Record<string, unknown>;
        const manifest = discovered?.brand_manifest as Record<string, unknown> | undefined;
        if (manifest && discovered!.review_status !== 'pending' && typeof manifest.house === 'object' && manifest.house !== null) {
          brandJson = manifest;
        } else {
          const brandId = brand_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          const brandEntry: Record<string, unknown> = {
            id: brandId,
            keller_type: 'master',
            names: [{ en: brand_name }],
          };
          if (logo_url) brandEntry.logos = [{ url: logo_url }];
          if (brand_color) brandEntry.colors = { primary: brand_color };
          brandJson = {
            house: { domain, name: brand_name },
            brands: [brandEntry],
          };
        }

        const existing = await brandDb.getHostedBrandByDomain(domain);
        if (existing) {
          // Only lock once domain_verified=true — unverified claims can be overwritten.
          // A verified domain with no org (e.g. crawler-verified before setup) is also locked.
          if (existing.domain_verified && existing.workos_organization_id !== orgId) {
            return res.status(403).json({ error: 'This domain is managed by another organization' });
          }
          // Update org attribution alongside brand data — keeps ownership current when
          // an unverified entry is overwritten. WorkOS organization_domains uniqueness
          // ensures only one org can hold a given domain, so this is safe.
          await brandDb.updateHostedBrand(existing.id, {
            brand_json: brandJson,
            workos_organization_id: orgId || undefined,
          });
        } else {
          await brandDb.createHostedBrand({
            workos_organization_id: orgId || undefined,
            created_by_user_id: req.user!.id,
            created_by_email: req.user!.email,
            brand_domain: domain,
            brand_json: brandJson,
            is_public: true,
          });
        }
      }

      // Link the member profile to this brand domain using authenticated user's org
      const memberDb = new MemberDatabase();
      if (orgId) {
        await memberDb.updateProfileByOrgId(orgId, {
          primary_brand_domain: domain,
        });
      }

      const hostedBrandJsonUrl = aaoHostedBrandJsonUrl(domain);
      const pointerSnippet = JSON.stringify(
        { authoritative_location: hostedBrandJsonUrl },
        null,
        2
      );

      return res.json({
        domain,
        has_brand_json: hasBrandJson,
        hosted_brand_json_url: hostedBrandJsonUrl,
        pointer_snippet: pointerSnippet,
      });
    } catch (error) {
      logger.error({ err: error, domain }, "Failed to set up brand");
      return res.status(500).json({ error: "Failed to set up brand" });
    }
  });

  // ── Policy Registry ────────────────────────────────────────────

  router.get("/policies/registry", async (req, res) => {
    try {
      const options: policiesDb.ListPoliciesOptions = {
        search: req.query.search as string,
        category: req.query.category as any,
        enforcement: req.query.enforcement as any,
        jurisdiction: req.query.jurisdiction as string,
        policy_category: typeof (req.query.policy_category ?? req.query.vertical) === 'string'
          ? (req.query.policy_category ?? req.query.vertical) as string : undefined,
        domain: req.query.domain as string,
        limit: req.query.limit ? Math.min(parseInt(req.query.limit as string), 1000) : undefined,
        offset: parseInt(req.query.offset as string) || 0,
      };

      const { policies, total, regulation, standard } = await policiesDb.listPolicies(options);

      return res.json({ policies, stats: { total, regulation, standard } });
    } catch (error) {
      logger.error({ error }, "Failed to list policies");
      return res.status(500).json({ error: "Failed to list policies" });
    }
  });

  router.get("/policies/resolve", async (req, res) => {
    try {
      const policyId = req.query.policy_id as string;
      if (!policyId) {
        return res.status(400).json({ error: "policy_id parameter required" });
      }
      const version = req.query.version as string | undefined;
      const policy = await policiesDb.resolvePolicy(policyId, version);
      if (!policy) {
        return res.status(404).json({ error: "Policy not found", policy_id: policyId });
      }
      return res.json(policy);
    } catch (error) {
      logger.error({ error }, "Failed to resolve policy");
      return res.status(500).json({ error: "Failed to resolve policy" });
    }
  });

  router.post("/policies/resolve/bulk", bulkResolveRateLimiter, async (req, res) => {
    try {
      const { policy_ids } = req.body;
      if (!Array.isArray(policy_ids) || policy_ids.length === 0) {
        return res.status(400).json({ error: "policy_ids array required" });
      }
      if (policy_ids.length > 100) {
        return res.status(400).json({ error: "Maximum 100 policy IDs per request" });
      }
      const results = await policiesDb.bulkResolve(policy_ids);
      return res.json({ results });
    } catch (error) {
      logger.error({ error }, "Failed to bulk resolve policies");
      return res.status(500).json({ error: "Failed to bulk resolve policies" });
    }
  });

  router.get("/policies/history", async (req, res) => {
    try {
      const policyId = req.query.policy_id as string;
      if (!policyId) {
        return res.status(400).json({ error: "policy_id parameter required" });
      }
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
      const rawOffset = parseInt(req.query.offset as string, 10);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      const { revisions, total } = await policiesDb.getPolicyHistory(policyId, { limit, offset });

      if (total === 0) {
        const policy = await policiesDb.resolvePolicy(policyId);
        if (!policy) {
          return res.status(404).json({ error: "Policy not found", policy_id: policyId });
        }
      }

      return res.json({
        policy_id: policyId,
        total,
        revisions: revisions.map((r) => ({
          revision_number: r.revision_number,
          editor_name: r.editor_name || "system",
          edit_summary: r.edit_summary,
          is_rollback: r.is_rollback,
          rolled_back_to: r.rolled_back_to,
          created_at: r.created_at.toISOString(),
        })),
      });
    } catch (error) {
      logger.error({ error }, "Failed to get policy history");
      return res.status(500).json({ error: "Failed to get policy history" });
    }
  });

  const policySaveMiddleware = authMiddleware ? [authMiddleware, brandCreationRateLimiter] : [brandCreationRateLimiter];

  router.post("/policies/save", ...policySaveMiddleware, async (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required to save policies" });
      }

      const { policy_id, version, name, category, enforcement, policy: policyText } = req.body;

      if (!policy_id || typeof policy_id !== "string") {
        return res.status(400).json({ error: "policy_id is required" });
      }
      if (!version || typeof version !== "string") {
        return res.status(400).json({ error: "version is required" });
      }
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name is required" });
      }
      if (!["regulation", "standard"].includes(category)) {
        return res.status(400).json({ error: "category must be 'regulation' or 'standard'" });
      }
      if (!["must", "should", "may"].includes(enforcement)) {
        return res.status(400).json({ error: "enforcement must be 'must', 'should', or 'may'" });
      }
      if (!policyText || typeof policyText !== "string") {
        return res.status(400).json({ error: "policy text is required" });
      }

      const policyIdPattern = /^[a-z][a-z0-9_]*$/;
      if (!policyIdPattern.test(policy_id)) {
        return res.status(400).json({ error: "policy_id must be lowercase alphanumeric with underscores" });
      }

      // Validate source_url scheme to prevent XSS via javascript: URIs
      if (req.body.source_url && typeof req.body.source_url === "string") {
        if (!/^https?:\/\//i.test(req.body.source_url)) {
          return res.status(400).json({ error: "source_url must use http:// or https:// scheme" });
        }
      }

      // Bridge deprecated field name: verticals → policy_categories
      if (req.body.verticals !== undefined && req.body.policy_categories === undefined) {
        req.body.policy_categories = req.body.verticals;
      }

      // Validate JSONB array fields
      if (req.body.jurisdictions !== undefined && !Array.isArray(req.body.jurisdictions)) {
        return res.status(400).json({ error: "jurisdictions must be an array" });
      }
      if (req.body.policy_categories !== undefined) {
        if (!Array.isArray(req.body.policy_categories)) {
          return res.status(400).json({ error: "policy_categories must be an array" });
        }
        if (!req.body.policy_categories.every((v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100)) {
          return res.status(400).json({ error: "policy_categories must be an array of non-empty strings" });
        }
      }
      if (req.body.channels !== undefined && req.body.channels !== null && !Array.isArray(req.body.channels)) {
        return res.status(400).json({ error: "channels must be an array" });
      }
      if (req.body.governance_domains !== undefined && !Array.isArray(req.body.governance_domains)) {
        return res.status(400).json({ error: "governance_domains must be an array" });
      }
      if (req.body.region_aliases !== undefined && (typeof req.body.region_aliases !== "object" || Array.isArray(req.body.region_aliases))) {
        return res.status(400).json({ error: "region_aliases must be an object" });
      }
      if (req.body.exemplars !== undefined && (typeof req.body.exemplars !== "object" || Array.isArray(req.body.exemplars))) {
        return res.status(400).json({ error: "exemplars must be an object" });
      }

      const { policy: saved, revision_number } = await policiesDb.savePolicy(
        {
          policy_id,
          version,
          name,
          description: req.body.description,
          category,
          enforcement,
          jurisdictions: req.body.jurisdictions,
          region_aliases: req.body.region_aliases,
          policy_categories: req.body.policy_categories,
          channels: req.body.channels,
          effective_date: req.body.effective_date,
          sunset_date: req.body.sunset_date,
          governance_domains: req.body.governance_domains,
          source_url: req.body.source_url,
          source_name: req.body.source_name,
          policy: policyText,
          guidance: req.body.guidance,
          exemplars: req.body.exemplars,
          ext: req.body.ext,
        },
        {
          user_id: req.user!.id,
          email: req.user!.email,
          name: `${req.user!.firstName || ""} ${req.user!.lastName || ""}`.trim() || req.user!.email,
        }
      );

      return res.json({
        success: true,
        message: revision_number
          ? `Policy "${name}" updated (revision ${revision_number})`
          : `Policy "${name}" created`,
        policy_id: saved.policy_id,
        revision_number,
      });
    } catch (error: any) {
      if (error.message?.includes("Cannot edit authoritative")) {
        logger.error({ err: error, policy_id: req.body.policy_id }, "Policy conflict");
        return res.status(409).json({ error: "Policy conflict", policy_id: req.body.policy_id });
      }
      if (error.message?.includes("pending review")) {
        logger.error({ err: error, policy_id: req.body.policy_id }, "Policy conflict");
        return res.status(409).json({ error: "Policy conflict", policy_id: req.body.policy_id });
      }
      logger.error({ error }, "Failed to save policy");
      return res.status(500).json({ error: "Failed to save policy" });
    }
  });

  // ── Registry Feed ───────────────────────────────────────────────

  if (config.eventsDb) {
    if (!authMiddleware) throw new Error('requireAuth middleware is required when eventsDb is provided');
    const eventsDb = config.eventsDb;

    router.get("/registry/feed", authMiddleware, async (req, res) => {
      try {
        const cursor = (req.query.cursor as string) || null;
        const typesParam = req.query.types as string | undefined;
        const types = typesParam ? typesParam.split(',').map(t => t.trim()).filter(Boolean) : null;
        const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

        // Validate cursor format (should be a UUID if provided)
        if (cursor && !isUuid(cursor)) {
          return res.status(400).json({ error: "Invalid cursor format. Must be a UUID." });
        }

        if (rawLimit !== undefined && isNaN(rawLimit)) {
          return res.status(400).json({ error: "limit must be a number" });
        }

        // Validate type filter values — only allow safe glob patterns
        const VALID_TYPE = /^[a-z][a-z0-9_.]*(\*)?$/;
        if (types) {
          for (const t of types) {
            if (!VALID_TYPE.test(t)) {
              return res.status(400).json({ error: `Invalid type filter: ${t}` });
            }
          }
        }

        const result = await eventsDb.queryFeed(cursor, types, rawLimit);

        if ('error' in result) {
          return res.status(410).json(result);
        }

        return res.json(result);
      } catch (error) {
        logger.error({ error }, "Failed to query registry feed");
        return res.status(500).json({ error: "Failed to query registry feed" });
      }
    });
  }

  // ── Authorization sync endpoints (PR 4b-snapshots of #3177) ──────
  // Spec: specs/registry-authorization-model.md:374-401
  //
  // Auth: gated by the same authMiddleware as /registry/feed — admin
  // API key + member tokens both flow through. No new permissions.
  // Match the /registry/feed pattern (line ~5604) of throwing on missing
  // auth rather than silently skipping route registration; this surfaces
  // misconfiguration at startup instead of at first request.
  if (!authMiddleware) {
    throw new Error('requireAuth middleware is required for /registry/authorizations endpoints');
  }
  {
    const authSnapshotDb = new AuthorizationSnapshotDatabase();

    /**
     * Translate parse errors into a single 400 path. Catches the typed
     * errors from authorization-snapshot-db and returns the same shape
     * for consumers regardless of which param failed validation.
     */
    function handleParseError(err: unknown, res: import("express").Response): boolean {
      if (err instanceof EvidenceValidationError) {
        res.status(400).json({ error: err.message });
        return true;
      }
      if (err instanceof IncludeValidationError) {
        res.status(400).json({ error: err.message });
        return true;
      }
      return false;
    }

    // include=raw bypasses v_effective_agent_authorizations and can surface
    // moderator-suppressed rows (e.g. takedown of a phishing relationship).
    // Per spec line 471 raw mode is an audit path; gate it on admin to
    // prevent any-member exfiltration of moderation state.
    function isAdminRequest(req: import('express').Request): boolean {
      return Boolean((req as unknown as { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey);
    }

    router.get("/registry/authorizations", authMiddleware, async (req, res) => {
      try {
        const rawAgentUrl = req.query.agent_url;
        if (typeof rawAgentUrl !== 'string' || rawAgentUrl.trim() === '') {
          return res.status(400).json({ error: "agent_url query parameter is required" });
        }

        // canonicalizeAgentUrl rejects whitespace, embedded wildcards, and
        // empty-after-trim. Use the same function the writer uses so a
        // narrow lookup matches stored rows even when the caller submits
        // a non-canonical URL.
        const agentUrlCanonical = canonicalizeAgentUrl(rawAgentUrl);
        if (!agentUrlCanonical) {
          return res.status(400).json({ error: "agent_url is not a valid URL after canonicalization" });
        }

        let evidence: ReadonlyArray<string>;
        let include: 'raw' | 'effective';
        try {
          evidence = parseEvidenceParam(req.query.evidence as string | undefined);
          include = parseIncludeParam(req.query.include as string | undefined);
        } catch (err) {
          if (handleParseError(err, res)) return;
          throw err;
        }

        if (include === 'raw' && !isAdminRequest(req)) {
          return res.status(403).json({ error: "include=raw requires admin access" });
        }

        const { rows, cursor } = await authSnapshotDb.getNarrow({
          agentUrlCanonical,
          evidence,
          include,
        });

        res.setHeader('X-Sync-Cursor', cursor);
        return res.json({
          agent_url: agentUrlCanonical,
          evidence: [...evidence],
          include,
          rows,
          count: rows.length,
        });
      } catch (error) {
        logger.error({ error }, "Failed to query authorizations");
        return res.status(500).json({ error: "Failed to query authorizations" });
      }
    });

    router.get("/registry/authorizations/snapshot", bulkResolveRateLimiter, authMiddleware, async (req, res) => {
      let evidence: ReadonlyArray<string>;
      let include: 'raw' | 'effective';
      try {
        evidence = parseEvidenceParam(req.query.evidence as string | undefined);
        include = parseIncludeParam(req.query.include as string | undefined);
      } catch (err) {
        if (handleParseError(err, res)) return;
        throw err;
      }

      if (include === 'raw' && !isAdminRequest(req)) {
        return res.status(403).json({ error: "include=raw requires admin access" });
      }

      // Open the snapshot transaction — captures the X-Sync-Cursor
      // value before declaring the data cursor. If the request
      // short-circuits on If-None-Match below, we still need to
      // release the connection via rows.return().
      let snapshot: { cursor: string; rows: AsyncIterableIterator<import("../db/authorization-snapshot-db.js").AuthRow[]> };
      try {
        snapshot = await authSnapshotDb.openSnapshot({ evidence, include });
      } catch (err) {
        logger.error({ err }, "Failed to open authorizations snapshot");
        return res.status(500).json({ error: "Failed to open authorizations snapshot" });
      }

      const { cursor, rows } = snapshot;
      // ETag must change with the response body. Two clients passing
      // different evidence/include filters get different bodies — hash
      // the cursor + filters so If-None-Match doesn't return 304 for a
      // payload the client hasn't actually seen.
      const etagInput = `${cursor}|${[...evidence].sort().join(',')}|${include}`;
      const etag = `"${createHash('sha256').update(etagInput).digest('hex').slice(0, 32)}"`;
      const ifNoneMatch = req.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
        try { await rows.return?.(undefined as never); } catch { /* ignored */ }
        res.setHeader('ETag', etag);
        res.setHeader('X-Sync-Cursor', cursor);
        return res.status(304).end();
      }

      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('X-Sync-Cursor', cursor);
      res.setHeader('ETag', etag);

      const gzip = createGzip();
      gzip.pipe(res);

      // Release the cursor/transaction the moment the client disconnects.
      // Without this, the gzip pipe only learns of the closed socket on
      // the next write — a holding pattern that pins one pooled DB
      // connection per aborted request and can DoS the pool when many
      // clients abort.
      let aborted = false;
      const onClose = (): void => {
        if (aborted) return;
        aborted = true;
        rows.return?.(undefined as never).catch(() => { /* iterator already closed */ });
      };
      req.on('close', onClose);

      // Z_SYNC_FLUSH after each chunk so the gzip layer emits bytes
      // incrementally — without it, the deflate buffer holds the
      // response server-side until .end() and the consumer can't parse
      // NDJSON line-by-line as advertised.
      const writeRows = (chunk: import("../db/authorization-snapshot-db.js").AuthRow[]): Promise<void> => {
        return new Promise((resolve, reject) => {
          const buf: string[] = [];
          for (const row of chunk) buf.push(JSON.stringify(row) + '\n');
          gzip.write(buf.join(''), (writeErr) => {
            if (writeErr) return reject(writeErr);
            gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve());
          });
        });
      };

      try {
        for await (const chunk of rows) {
          if (aborted) break;
          await writeRows(chunk);
        }
        gzip.end();
      } catch (err) {
        logger.error({ err }, "Snapshot streaming aborted");
        try { await rows.return?.(undefined as never); } catch { /* ignored */ }
        // Headers + Content-Encoding are already set; we can't switch to
        // a JSON 500 response. End the gzip stream so the client at
        // least gets a clean EOF and surfaces a parse error rather than
        // a hang.
        gzip.end();
      } finally {
        req.removeListener('close', onClose);
      }
    });
  }

  // ── Agent Search ──────────────────────────────────────────────

  if (config.profilesDb) {
    if (!authMiddleware) throw new Error('requireAuth middleware is required when profilesDb is provided');
    const profilesDb = config.profilesDb;

    router.get("/registry/agents/search", authMiddleware, async (req, res) => {
      try {
        const MAX_FILTER_VALUES = 100;
        const parseCSV = (param: string | undefined): string[] | undefined => {
          if (!param) return undefined;
          const values = param.split(',').map(v => v.trim()).filter(Boolean);
          if (values.length === 0) return undefined;
          return values.slice(0, MAX_FILTER_VALUES);
        };

        const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
        if (rawLimit !== undefined && isNaN(rawLimit)) {
          return res.status(400).json({ error: "limit must be a number" });
        }

        const rawMinProps = req.query.min_properties ? parseInt(req.query.min_properties as string, 10) : undefined;
        if (rawMinProps !== undefined && isNaN(rawMinProps)) {
          return res.status(400).json({ error: "min_properties must be a number" });
        }

        const searchQuery = {
          channels: parseCSV(req.query.channels as string),
          property_types: parseCSV(req.query.property_types as string),
          markets: parseCSV(req.query.markets as string),
          categories: parseCSV(req.query.categories as string),
          tags: parseCSV(req.query.tags as string),
          delivery_types: parseCSV(req.query.delivery_types as string),
          has_tmp: req.query.has_tmp !== undefined ? req.query.has_tmp === 'true' : undefined,
          min_properties: rawMinProps,
          cursor: (req.query.cursor as string) || undefined,
          limit: rawLimit,
        };

        const response = await profilesDb.search(searchQuery);

        return res.json(response);
      } catch (error: any) {
        if (error?.message?.includes('Invalid cursor')) {
          return res.status(400).json({ error: "Invalid cursor format" });
        }
        logger.error({ error }, "Failed to search agent profiles");
        return res.status(500).json({ error: "Failed to search agent profiles" });
      }
    });
  }

  // ── Crawl Request ─────────────────────────────────────────────

  // In-memory rate limits: reset on deploy, not shared across instances.
  // Move to Redis or Postgres before scaling to multiple instances.
  const crawlRequestRateLimits = new Map<string, number>();  // domain -> last request timestamp
  const memberCrawlCounts = new Map<string, { count: number; windowStart: number }>();
  const CRAWL_RATE_LIMIT_MS = 5 * 60 * 1000;  // 5 minutes per domain
  const MEMBER_CRAWL_LIMIT = 30;               // 30 requests per member per hour
  const MEMBER_CRAWL_WINDOW_MS = 60 * 60 * 1000;
  // Periodic cleanup of stale rate limit entries to prevent memory growth
  const rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [domain, timestamp] of crawlRequestRateLimits) {
      if (now - timestamp > CRAWL_RATE_LIMIT_MS) crawlRequestRateLimits.delete(domain);
    }
    for (const [member, state] of memberCrawlCounts) {
      if (now - state.windowStart > MEMBER_CRAWL_WINDOW_MS) memberCrawlCounts.delete(member);
    }
  }, CRAWL_RATE_LIMIT_MS);
  rateLimitCleanupInterval.unref(); // Don't prevent process exit

  /**
   * Validate domain and apply rate limits for crawl requests.
   * Returns the normalized domain on success, or sends an error response.
   */
  async function validateAndRateLimitCrawl(
    req: import('express').Request,
    res: import('express').Response,
    rateLimitKey: string,
  ): Promise<string | null> {
    const { domain } = req.body;
    if (!domain || typeof domain !== 'string') {
      res.status(400).json({ error: "domain is required" });
      return null;
    }

    let normalizedDomain: string;
    try {
      normalizedDomain = await validateCrawlDomain(domain);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid domain';
      res.status(400).json({ error: message });
      return null;
    }

    const memberId = req.user?.id || 'anonymous';

    // Per-domain rate limit (shared key space for all crawl types on same domain)
    const lastCrawl = crawlRequestRateLimits.get(rateLimitKey);
    if (lastCrawl && Date.now() - lastCrawl < CRAWL_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((CRAWL_RATE_LIMIT_MS - (Date.now() - lastCrawl)) / 1000);
      res.status(429).json({ error: "Rate limit exceeded for this domain", retry_after: retryAfter });
      return null;
    }

    // Per-member hourly rate limit
    const memberState = memberCrawlCounts.get(memberId);
    const now = Date.now();
    if (memberState && now - memberState.windowStart < MEMBER_CRAWL_WINDOW_MS) {
      if (memberState.count >= MEMBER_CRAWL_LIMIT) {
        res.status(429).json({
          error: "Hourly crawl request limit exceeded",
          retry_after: Math.ceil((MEMBER_CRAWL_WINDOW_MS - (now - memberState.windowStart)) / 1000),
        });
        return null;
      }
      memberState.count++;
    } else {
      memberCrawlCounts.set(memberId, { count: 1, windowStart: now });
    }

    crawlRequestRateLimits.set(rateLimitKey, now);
    return normalizedDomain;
  }

  if (!authMiddleware) throw new Error('requireAuth middleware is required for crawl-request endpoint');
  router.post("/registry/crawl-request", authMiddleware, async (req, res) => {
    try {
      const normalizedDomain = await validateAndRateLimitCrawl(req, res, req.body?.domain?.toLowerCase?.()?.trim?.() || '');
      if (!normalizedDomain) return;

      crawler.crawlSingleDomain(normalizedDomain).catch((err: Error) => {
        logger.error({ err, domain: normalizedDomain }, "Crawl request failed");
      });

      return res.status(202).json({ message: "Crawl request accepted", domain: normalizedDomain });
    } catch (error) {
      logger.error({ error }, "Failed to process crawl request");
      return res.status(500).json({ error: "Failed to process crawl request" });
    }
  });

  router.post("/registry/brand-crawl-request", authMiddleware, async (req, res) => {
    try {
      const normalizedDomain = await validateAndRateLimitCrawl(req, res, req.body?.domain?.toLowerCase?.()?.trim?.() || '');
      if (!normalizedDomain) return;

      crawler.scanBrandForDomain(normalizedDomain).catch((err: Error) => {
        logger.error({ err, domain: normalizedDomain }, "Brand crawl request failed");
      });

      return res.status(202).json({ message: "Brand crawl request accepted", domain: normalizedDomain });
    } catch (error) {
      logger.error({ error }, "Failed to process brand crawl request");
      return res.status(500).json({ error: "Failed to process brand crawl request" });
    }
  });

  return router;
}
