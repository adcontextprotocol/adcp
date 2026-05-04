/**
 * Zod schemas for the public Registry API.
 *
 * These schemas serve two purposes:
 * 1. Runtime validation of request parameters
 * 2. OpenAPI spec generation via @asteasolutions/zod-to-openapi
 */

import { z } from "zod";
import { ADCP_PROTOCOLS, ADCP_SPECIALISMS, VERIFICATION_MODES } from "../services/adcp-taxonomy.js";
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

/**
 * Extended error shape for endpoints whose parser can tag rejections with
 * a stable `code` + `field` pointer (see `parseOAuthClientCredentialsInput`).
 * Consumers map codes to localized prose and highlight the offending field.
 * Generic 500s / non-parser 400s still use `ErrorSchema`.
 */
export const CredentialSaveValidationErrorSchema = z
  .object({
    error: z.string(),
    code: z
      .enum([
        "invalid_blob_shape",
        "missing_field",
        "invalid_field_type",
        "field_too_long",
        "invalid_url",
        "invalid_env_reference",
        "invalid_auth_method_value",
      ])
      .openapi({ description: "Stable rejection tag. UI maps this to operator-friendly prose." }),
    field: z
      .enum([
        "oauth_client_credentials",
        "token_endpoint",
        "client_id",
        "client_secret",
        "scope",
        "resource",
        "audience",
        "auth_method",
      ])
      .openapi({ description: "Field the UI should scroll to + highlight." }),
  })
  .openapi("CredentialSaveValidationError");

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
    signals_capabilities: z
      .object({
        audience_types: z.array(z.string()),
        can_match: z.boolean(),
        can_activate: z.boolean(),
        can_get_signals: z.boolean(),
      })
      .optional(),
    measurement_capabilities: z
      .object({
        metrics: z.array(
          z.object({
            metric_id: z.string(),
            standard_reference: z.string().optional(),
            accreditations: z
              .array(
                z.object({
                  accrediting_body: z.string(),
                  certification_id: z.string().optional(),
                  valid_until: z.string().optional(),
                  evidence_url: z.string().optional(),
                  verified_by_aao: z.literal(false).openapi({
                    description:
                      "Always `false` — accreditation claims are vendor-asserted. AAO does not independently verify; renderers should mark these as vendor claims.",
                  }),
                })
              )
              .optional(),
            unit: z.string().optional(),
            description: z.string().optional(),
            methodology_url: z.string().optional(),
            methodology_version: z.string().optional(),
          })
        ),
      })
      .optional()
      .openapi({
        description:
          "Vendor-published per-metric catalog for measurement agents. Populated when the crawler successfully fetched and validated `get_adcp_capabilities.measurement` (AdCP 3.x). Mirrors the protocol shape — see the AdCP `get_adcp_capabilities` reference for field semantics.",
      }),
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

export const AgentComplianceSchema = z
  .object({
    status: z.enum(["passing", "degraded", "failing", "unknown"]),
    lifecycle_stage: z.enum(["development", "testing", "production", "deprecated"]),
    tracks: z.record(z.string(), z.string()).openapi({ example: { core: "pass", products: "fail" } }),
    streak_days: z.number().int(),
    last_checked_at: z.string().nullable(),
    headline: z.string().nullable(),
    monitoring_paused: z.boolean().optional(),
    check_interval_hours: z.number().int().optional(),
    verified: z.boolean().optional(),
    verified_roles: z.array(z.enum(ADCP_PROTOCOLS as [string, ...string[]])).optional()
      .openapi({ description: "AdCP protocols the agent is AAO Verified for (e.g. media-buy, creative). Matches enums/adcp-protocol.json." }),
  })
  .openapi("AgentCompliance");

export const VerificationBadgeSchema = z
  .object({
    role: z.enum(ADCP_PROTOCOLS as [string, ...string[]])
      .openapi({ description: "AdCP protocol this badge covers (enums/adcp-protocol.json)." }),
    adcp_version: z.string()
      .openapi({ description: "AdCP release this badge was issued against, MAJOR.MINOR (e.g. '3.0', '3.1'). Load-bearing for badge identity — pairs with the (agent_url, role, adcp_version) PK." }),
    verified_at: z.string(),
    verified_specialisms: z.array(z.enum(ADCP_SPECIALISMS as [string, ...string[]]))
      .openapi({ description: "Specialisms demonstrably passed (enums/specialism.json). Preview specialisms are excluded from stable badges." }),
    verification_modes: z.array(z.enum(VERIFICATION_MODES as readonly [string, ...string[]])).min(1)
      .openapi({ description: "Verification axes earned. 'spec' = AdCP storyboards pass for the declared specialisms. 'live' = AAO has observed real production traffic via canonical campaigns. Always non-empty when a badge is present; an absent badge is conveyed by the parent record being omitted, not by an empty array." }),
    verified_protocol_version: z.string().nullable(),
    badge_url: z.string().optional()
      .openapi({ description: "Legacy URL — auto-upgrades to the highest active version. For version-pinned embedding, derive `/api/registry/agents/{encoded_url}/badge/{role}/{adcp_version}.svg` where `{encoded_url}` is `encodeURIComponent(agent_url)`." }),
  })
  .openapi("VerificationBadge");

export const AgentComplianceDetailSchema = z
  .object({
    agent_url: z.string(),
    status: z.enum(["passing", "degraded", "failing", "unknown", "opted_out"]),
    lifecycle_stage: z.enum(["development", "testing", "production", "deprecated"]),
    compliance_opt_out: z.boolean().optional(),
    tracks: z.record(z.string(), z.string()).optional(),
    streak_days: z.number().int().optional(),
    last_checked_at: z.string().nullable().optional(),
    last_passed_at: z.string().nullable().optional(),
    last_failed_at: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    status_changed_at: z.string().nullable().optional(),
    storyboards_passing: z.number().int().optional(),
    storyboards_total: z.number().int().optional(),
    check_interval_hours: z.number().int().optional().openapi({ description: "How often the heartbeat re-tests this agent, in hours" }),
    declared_specialisms: z.array(z.string()).optional().openapi({ description: "Specialisms the agent declared in get_adcp_capabilities, from the latest run" }),
    specialism_status: z.record(z.string(), z.enum(['passing', 'failing', 'untested', 'unknown'])).optional().openapi({ description: "Per-specialism pass/fail/untested status — keyed on declared specialism, derived from the matching storyboard's status" }),
    membership_tier: z.string().nullable().optional().openapi({ description: "Owner-scoped: the agent owner's membership tier. Populated only when the authenticated viewer owns the agent; null otherwise. Field is always present so response shape doesn't reveal ownership." }),
    membership_tier_label: z.string().nullable().optional().openapi({ description: "Owner-scoped: human-readable label for membership_tier (e.g. 'Builder'). Null for non-owners." }),
    subscription_status: z.string().nullable().optional().openapi({ description: "Owner-scoped: the agent owner's subscription status (active, past_due, trialing, etc.). Null for non-owners." }),
    is_api_access_tier: z.boolean().optional().openapi({ description: "Owner-scoped: true when the owner's tier and subscription status grant badge eligibility. False for non-owners. Single source of truth — UI should not re-derive." }),
    verified: z.boolean().optional(),
    verified_badges: z.array(VerificationBadgeSchema).optional(),
  })
  .openapi("AgentComplianceDetail");

export const AgentVerificationSchema = z
  .object({
    agent_url: z.string(),
    verified: z.boolean(),
    badges: z.array(VerificationBadgeSchema),
    registry_url: z.string().optional(),
  })
  .openapi("AgentVerification");

export const StoryboardStatusSchema = z
  .object({
    storyboard_id: z.string(),
    title: z.string(),
    category: z.string().nullable(),
    track: z.string().nullable(),
    status: z.enum(["passing", "failing", "partial", "untested"]),
    steps_passed: z.number().int(),
    steps_total: z.number().int(),
    last_tested_at: z.string().nullable(),
    last_passed_at: z.string().nullable(),
  })
  .openapi("StoryboardStatus");

export const FederatedAgentWithDetailsSchema = z
  .object({
    url: z.string(),
    name: z.string(),
    type: z.enum([
      "brand",
      "rights",
      "measurement",
      "governance",
      "creative",
      "sales",
      "buying",
      "signals",
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
    member: MemberRefSchema.optional().openapi({
      description:
        "AAO member that owns this agent record. The registry contains only agents that members have explicitly enrolled on their member profile.",
    }),
    health: AgentHealthSchema.optional(),
    stats: AgentStatsSchema.optional(),
    capabilities: AgentCapabilitiesSchema.optional(),
    compliance: AgentComplianceSchema.optional(),
    publisher_domains: z.array(z.string()).optional(),
    property_summary: PropertySummarySchema.optional(),
  })
  .openapi("FederatedAgentWithDetails");

export const FederatedPublisherSchema = z
  .object({
    domain: z.string(),
    member: MemberRefSchema.optional(),
    agent_count: z.number().int().optional(),
    last_validated: z.string().optional(),
    has_valid_adagents: z.boolean().optional(),
  })
  .openapi("FederatedPublisher");

const DomainAgentRefSchema = z.object({
  url: z.string(),
  authorized_for: z.string().optional(),
  member: MemberRefSchema.optional(),
});

export const DomainLookupResultSchema = z
  .object({
    domain: z.string().openapi({ example: "examplepub.com" }),
    authorized_agents: z.array(DomainAgentRefSchema),
    sales_agents_claiming: z.array(
      z.object({
        url: z.string(),
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

const ActivityEntrySchema = z.object({
  revision_number: z.number().int().openapi({ example: 3 }),
  editor_name: z.string().openapi({ example: "Pinnacle Media" }),
  edit_summary: z.string().openapi({ example: "Updated logo and brand colors" }),
  source: z.string().optional().openapi({ description: "Source type of the record at the time of this revision (brand_json, enriched, community)" }),
  is_rollback: z.boolean(),
  rolled_back_to: z.number().int().optional().openapi({ description: "Revision number that was restored; only present when is_rollback is true" }),
  created_at: z.string().openapi({ example: "2026-03-01T12:34:56Z" }),
});

export const BrandActivitySchema = z
  .object({
    domain: z.string().openapi({ example: "acmecorp.com" }),
    total: z.number().int().openapi({ example: 3 }),
    revisions: z.array(ActivityEntrySchema),
  })
  .openapi("BrandActivity");

export const PropertyActivitySchema = z
  .object({
    domain: z.string().openapi({ example: "examplepub.com" }),
    total: z.number().int().openapi({ example: 3 }),
    revisions: z.array(ActivityEntrySchema),
  })
  .openapi("PropertyActivity");

// ── Policy Registry ────────────────────────────────────────────

const PolicyExemplarSchema = z.object({
  scenario: z.string().openapi({ example: "Ad for alcohol shown during children's programming" }),
  explanation: z.string().openapi({ example: "Violates watershed timing rules for alcohol advertising" }),
});

export const PolicySchema = z
  .object({
    policy_id: z.string().openapi({ example: "gdpr_consent" }),
    version: z.string().openapi({ example: "1.0.0" }),
    name: z.string().openapi({ example: "GDPR Consent Requirements" }),
    description: z.string().nullable().openapi({ example: "Requirements for valid consent under GDPR" }),
    category: z.enum(["regulation", "standard"]),
    enforcement: z.enum(["must", "should", "may"]),
    jurisdictions: z.array(z.string()).openapi({ example: ["EU", "EEA"] }),
    region_aliases: z.record(z.string(), z.array(z.string())).openapi({ example: { EU: ["DE", "FR", "IT"] } }),
    policy_categories: z.array(z.string()).openapi({ example: ["age_restricted", "pharmaceutical_advertising"] }),
    channels: z.array(z.string()).nullable().openapi({ example: ["display", "video"] }),
    governance_domains: z.array(z.string()).openapi({ example: ["campaign", "creative"] }),
    effective_date: z.string().nullable().openapi({ example: "2025-05-25" }),
    sunset_date: z.string().nullable(),
    source_url: z.string().nullable().openapi({ example: "https://eur-lex.europa.eu/eli/reg/2016/679/oj" }),
    source_name: z.string().nullable().openapi({ example: "EUR-Lex" }),
    policy: z.string().openapi({ example: "Data subjects must provide freely given, specific, informed and unambiguous consent..." }),
    guidance: z.string().nullable(),
    exemplars: z
      .object({
        pass: z.array(PolicyExemplarSchema).optional(),
        fail: z.array(PolicyExemplarSchema).optional(),
      })
      .nullable(),
    ext: z.record(z.string(), z.unknown()).nullable(),
    source_type: z.enum(["registry", "community"]),
    review_status: z.enum(["pending", "approved"]),
    created_at: z.string().openapi({ example: "2026-03-01T12:00:00.000Z" }),
    updated_at: z.string().openapi({ example: "2026-03-01T12:00:00.000Z" }),
  })
  .openapi("Policy");

export const PolicySummarySchema = PolicySchema
  .omit({ policy: true, guidance: true, exemplars: true, ext: true })
  .openapi("PolicySummary");

const PolicyRevisionEntrySchema = z.object({
  revision_number: z.number().int().openapi({ example: 2 }),
  editor_name: z.string().openapi({ example: "Pinnacle Media" }),
  edit_summary: z.string().openapi({ example: "Clarified consent requirements for minors" }),
  is_rollback: z.boolean(),
  rolled_back_to: z.number().int().optional().openapi({ description: "Revision number that was restored; only present when is_rollback is true" }),
  created_at: z.string().openapi({ example: "2026-03-01T12:34:56Z" }),
});

export const PolicyHistorySchema = z
  .object({
    policy_id: z.string().openapi({ example: "gdpr_consent" }),
    total: z.number().int().openapi({ example: 3 }),
    revisions: z.array(PolicyRevisionEntrySchema),
  })
  .openapi("PolicyHistory");

// ── Operator & Publisher Lookup ────────────────────────────────

const AgentAuthorizationSummarySchema = z.object({
  publisher_domain: z.string(),
  authorized_for: z.string().optional(),
  source: z.enum(["adagents_json", "agent_claim"]),
});

const OperatorAgentSchema = z.object({
  url: z.string(),
  name: z.string(),
  type: z.enum(["brand", "rights", "measurement", "governance", "creative", "sales", "buying", "signals", "unknown"]),
  authorized_by: z.array(AgentAuthorizationSummarySchema),
});

export const OperatorLookupResultSchema = z
  .object({
    domain: z.string().openapi({ example: "pubmatic.com" }),
    member: MemberRefSchema.nullable(),
    agents: z.array(OperatorAgentSchema),
  })
  .openapi("OperatorLookupResult");

const PublisherPropertySchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  identifiers: z.array(PropertyIdentifierSchema).optional(),
  tags: z.array(z.string()).optional(),
  source: z.enum(["adagents_json", "discovered", "brand_json"]).optional().openapi({
    description:
      "Where this property came from. `adagents_json`/`discovered` come from the federated index (publisher's own adagents.json or crawler discovery). `brand_json` is hydrated from the publisher's brand.json when no federated-index data exists yet.",
  }),
});

const PublisherAuthorizedAgentSchema = z.object({
  url: z.string(),
  authorized_for: z.string().optional(),
  source: z.enum(["adagents_json", "agent_claim"]),
  properties_authorized: z.number().int().nonnegative().optional().openapi({
    description:
      "Count of this publisher's properties the agent is authorized to sell. When property-level authorizations exist, this is the intersection; otherwise it equals `properties_total` (publisher-wide authorization).",
  }),
  properties_total: z.number().int().nonnegative().optional().openapi({
    description: "Total number of properties this publisher exposes through the registry. Same value across all agents in the response.",
  }),
});

const PublisherHostingSchema = z.object({
  mode: z.enum(["self", "aao_hosted", "none"]).openapi({
    description:
      "Where this publisher's adagents.json lives. `self` = publisher hosts at their own /.well-known. `aao_hosted` = AAO serves the canonical document. `none` = no adagents.json configured yet.",
  }),
  hosted_url: z.string().optional().openapi({
    description: "Canonical AAO-hosted adagents.json URL when mode is `aao_hosted`.",
  }),
  expected_url: z.string().openapi({
    description: "Where adagents.json *should* live for this domain — the publisher's own /.well-known path.",
  }),
});

export const PublisherLookupResultSchema = z
  .object({
    domain: z.string().openapi({ example: "voxmedia.com" }),
    member: MemberRefSchema.nullable(),
    adagents_valid: z.boolean().nullable(),
    hosting: PublisherHostingSchema,
    properties: z.array(PublisherPropertySchema),
    authorized_agents: z.array(PublisherAuthorizedAgentSchema),
    rollup_truncated: z.boolean().optional().openapi({
      description:
        "Set to `true` when the publisher has more authorized agents than the per-agent rollup cap. Above the cap, agents are returned without `properties_authorized` / `properties_total`; call `/api/registry/publisher/authorization?domain=X&agent=Y` for the per-agent count.",
    }),
  })
  .openapi("PublisherLookupResult");

export const RegistryMetadataSchema = z
  .object({
    agent_url: z.string(),
    lifecycle_stage: z.enum(["development", "testing", "production", "deprecated"]),
    compliance_opt_out: z.boolean(),
    monitoring_paused: z.boolean(),
    check_interval_hours: z.number().int(),
    monitoring_paused_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RegistryMetadata");

export const MonitoringSettingsSchema = z
  .object({
    monitoring_paused: z.boolean(),
    check_interval_hours: z.number().int(),
    monitoring_paused_at: z.string().nullable(),
  })
  .openapi("MonitoringSettings");

export const ComplianceRunSchema = z
  .object({
    id: z.string(),
    overall_status: z.string(),
    headline: z.string().nullable(),
    tracks_passed: z.number().int(),
    tracks_failed: z.number().int(),
    tracks_skipped: z.number().int(),
    tracks_partial: z.number().int(),
    tracks_json: z.any(),
    total_duration_ms: z.number().nullable(),
    triggered_by: z.string(),
    tested_at: z.string(),
  })
  .openapi("ComplianceRun");

export const OutboundRequestSchema = z
  .object({
    id: z.string(),
    agent_url: z.string(),
    request_type: z.string(),
    user_agent: z.string(),
    response_time_ms: z.number().nullable(),
    success: z.boolean(),
    error_message: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("OutboundRequest");

export const AgentAuthStatusSchema = z
  .object({
    has_auth: z.boolean(),
    agent_context_id: z.string().nullable(),
    auth_type: z.enum(["bearer", "basic", "oauth", "oauth_client_credentials"]).nullable(),
    has_oauth_token: z.boolean(),
    has_valid_oauth: z.boolean(),
    oauth_token_expires_at: z.string().nullable(),
    has_oauth_client_credentials: z.boolean(),
  })
  .openapi("AgentAuthStatus");

export const StoryboardSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    category: z.string(),
    summary: z.string(),
    interaction_model: z.string(),
    examples: z.array(z.string()),
    phase_count: z.number().int(),
    step_count: z.number().int(),
  })
  .openapi("StoryboardSummary");

export const StoryboardDetailSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    category: z.string(),
    summary: z.string(),
    agent: z.object({
      interaction_model: z.string(),
      examples: z.array(z.string()).optional(),
    }),
    phases: z.array(
      z.object({
        title: z.string(),
        steps: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            expected_output: z.string(),
          }),
        ),
      }),
    ),
    prerequisites: z.any().optional(),
    required_tools: z.array(z.string()).optional(),
    track: z.string().optional(),
  })
  .openapi("StoryboardDetail");

