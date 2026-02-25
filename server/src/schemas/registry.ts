/**
 * Zod schemas for the public Registry API.
 *
 * These schemas serve two purposes:
 * 1. Runtime validation of request parameters
 * 2. OpenAPI spec generation via @asteasolutions/zod-to-openapi
 */

import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ── Reusable component schemas ──────────────────────────────────

export const ErrorSchema = z
  .object({ error: z.string() })
  .openapi("Error");

export const LocalizedNameSchema = z
  .record(z.string(), z.string())
  .openapi("LocalizedName");

export const PropertyIdentifierSchema = z
  .object({
    type: z.string().openapi({ example: "domain" }),
    value: z.string().openapi({ example: "examplepub.com" }),
  })
  .openapi("PropertyIdentifier");

export const PublisherPropertySelectorSchema = z
  .object({
    publisher_domain: z.string().optional().openapi({ example: "examplepub.com" }),
    property_types: z.array(z.string()).optional(),
    property_ids: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .openapi("PublisherPropertySelector");

export const AgentHealthSchema = z
  .object({
    online: z.boolean(),
    checked_at: z.string(),
    response_time_ms: z.number().optional(),
    tools_count: z.number().int().optional(),
    resources_count: z.number().int().optional(),
    error: z.string().optional(),
  })
  .openapi("AgentHealth");

export const AgentStatsSchema = z
  .object({
    property_count: z.number().int().optional(),
    publisher_count: z.number().int().optional(),
    publishers: z.array(z.string()).optional(),
    creative_formats: z.number().int().optional(),
  })
  .openapi("AgentStats");

export const AgentCapabilitiesSchema = z
  .object({
    tools_count: z.number().int(),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
        })
      )
      .optional(),
    standard_operations: z
      .object({
        can_search_inventory: z.boolean(),
        can_get_availability: z.boolean(),
        can_reserve_inventory: z.boolean(),
        can_get_pricing: z.boolean(),
        can_create_order: z.boolean(),
        can_list_properties: z.boolean(),
      })
      .optional(),
    creative_capabilities: z
      .object({
        formats_supported: z.array(z.string()),
        can_generate: z.boolean(),
        can_validate: z.boolean(),
        can_preview: z.boolean(),
      })
      .optional(),
  })
  .openapi("AgentCapabilities");

export const PropertySummarySchema = z
  .object({
    total_count: z.number().int(),
    count_by_type: z.record(z.string(), z.number().int()),
    tags: z.array(z.string()),
    publisher_count: z.number().int(),
  })
  .openapi("PropertySummary");

const MemberRefSchema = z.object({
  slug: z.string().optional(),
  display_name: z.string().optional(),
});

const DiscoveredFromSchema = z.object({
  publisher_domain: z.string().optional(),
  authorized_for: z.string().optional(),
});

export const ResolvedBrandSchema = z
  .object({
    canonical_id: z.string().openapi({ example: "acmecorp.com" }),
    canonical_domain: z.string().openapi({ example: "acmecorp.com" }),
    brand_name: z.string().openapi({ example: "Acme Corp" }),
    names: z.array(LocalizedNameSchema).optional(),
    keller_type: z
      .enum(["master", "sub_brand", "endorsed", "independent"])
      .optional(),
    parent_brand: z.string().optional(),
    house_domain: z.string().optional(),
    house_name: z.string().optional(),
    brand_agent_url: z.string().optional(),
    brand_manifest: z.record(z.string(), z.unknown()).optional(),
    source: z.enum(["brand_json", "community", "enriched"]),
  })
  .openapi("ResolvedBrand");

export const CompanySearchResultSchema = z
  .object({
    domain: z.string().openapi({ example: "coca-cola.com" }),
    canonical_domain: z.string().openapi({ example: "coca-cola.com" }),
    brand_name: z.string().openapi({ example: "The Coca-Cola Company" }),
    house_domain: z.string().optional().openapi({ example: "coca-cola.com" }),
    keller_type: z
      .enum(["master", "sub_brand", "endorsed", "independent"])
      .optional(),
    parent_brand: z.string().optional(),
    brand_agent_url: z.string().optional(),
    source: z.string().openapi({ example: "community" }),
  })
  .openapi("CompanySearchResult");

export const FindCompanyResultSchema = z
  .object({
    results: z.array(CompanySearchResultSchema),
  })
  .openapi("FindCompanyResult");

export const ResolvedPropertySchema = z
  .object({
    publisher_domain: z.string().openapi({ example: "examplepub.com" }),
    source: z.enum(["adagents_json", "hosted", "discovered"]),
    authorized_agents: z
      .array(
        z.object({
          url: z.string(),
          authorized_for: z.string().optional(),
        })
      )
      .optional(),
    properties: z
      .array(
        z.object({
          id: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
          identifiers: z.array(PropertyIdentifierSchema).optional(),
          tags: z.array(z.string()).optional(),
        })
      )
      .optional(),
    contact: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
    verified: z.boolean(),
  })
  .openapi("ResolvedProperty");

export const BrandRegistryItemSchema = z
  .object({
    domain: z.string().openapi({ example: "acmecorp.com" }),
    brand_name: z.string().optional().openapi({ example: "Acme Corp" }),
    source: z.enum(["hosted", "brand_json", "community", "enriched"]),
    has_manifest: z.boolean(),
    verified: z.boolean(),
    house_domain: z.string().optional(),
    keller_type: z
      .enum(["master", "sub_brand", "endorsed", "independent"])
      .optional(),
  })
  .openapi("BrandRegistryItem");

export const PropertyRegistryItemSchema = z
  .object({
    domain: z.string().openapi({ example: "examplepub.com" }),
    source: z.enum([
      "adagents_json",
      "hosted",
      "community",
      "discovered",
      "enriched",
    ]),
    property_count: z.number().int(),
    agent_count: z.number().int(),
    verified: z.boolean(),
  })
  .openapi("PropertyRegistryItem");

export const FederatedAgentWithDetailsSchema = z
  .object({
    url: z.string(),
    name: z.string(),
    type: z.enum([
      "creative",
      "signals",
      "sales",
      "governance",
      "si",
      "unknown",
    ]),
    protocol: z.enum(["mcp", "a2a"]).optional(),
    description: z.string().optional(),
    mcp_endpoint: z.string().optional(),
    contact: z
      .object({
        name: z.string(),
        email: z.string(),
        website: z.string(),
      })
      .optional(),
    added_date: z.string().optional(),
    source: z.enum(["registered", "discovered"]).optional(),
    member: MemberRefSchema.optional(),
    discovered_from: DiscoveredFromSchema.optional(),
    health: AgentHealthSchema.optional(),
    stats: AgentStatsSchema.optional(),
    capabilities: AgentCapabilitiesSchema.optional(),
    publisher_domains: z.array(z.string()).optional(),
    property_summary: PropertySummarySchema.optional(),
  })
  .openapi("FederatedAgentWithDetails");

export const FederatedPublisherSchema = z
  .object({
    domain: z.string(),
    source: z.enum(["registered", "discovered"]).optional(),
    member: MemberRefSchema.optional(),
    agent_count: z.number().int().optional(),
    last_validated: z.string().optional(),
    discovered_from: z
      .object({ agent_url: z.string().optional() })
      .optional(),
    has_valid_adagents: z.boolean().optional(),
    discovered_at: z.string().optional(),
  })
  .openapi("FederatedPublisher");

const DomainAgentRefSchema = z.object({
  url: z.string(),
  authorized_for: z.string().optional(),
  source: z.enum(["registered", "discovered"]).optional(),
  member: MemberRefSchema.optional(),
});

export const DomainLookupResultSchema = z
  .object({
    domain: z.string().openapi({ example: "examplepub.com" }),
    authorized_agents: z.array(DomainAgentRefSchema),
    sales_agents_claiming: z.array(
      z.object({
        url: z.string(),
        source: z.enum(["registered", "discovered"]).optional(),
        member: MemberRefSchema.optional(),
      })
    ),
  })
  .openapi("DomainLookupResult");

export const ValidationResultSchema = z
  .object({
    valid: z.boolean(),
    domain: z.string().optional(),
    url: z.string().optional(),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    status_code: z.number().int().optional(),
    raw_data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ValidationResult");

