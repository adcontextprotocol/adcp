/**
 * Zod schemas for the public Registry API.
 *
 * These schemas serve two purposes:
 * 1. Runtime validation of request parameters
 * 2. OpenAPI spec generation via @asteasolutions/zod-to-openapi
 */
import { z } from "zod";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
export declare const registry: OpenAPIRegistry;
export declare const ErrorSchema: z.ZodObject<{
    error: z.ZodString;
}, z.core.$strip>;
export declare const LocalizedNameSchema: z.ZodRecord<z.ZodString, z.ZodString>;
export declare const PropertyIdentifierSchema: z.ZodObject<{
    type: z.ZodString;
    value: z.ZodString;
}, z.core.$strip>;
export declare const PublisherPropertySelectorSchema: z.ZodObject<{
    publisher_domain: z.ZodOptional<z.ZodString>;
    property_types: z.ZodOptional<z.ZodArray<z.ZodString>>;
    property_ids: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const AgentHealthSchema: z.ZodObject<{
    online: z.ZodBoolean;
    checked_at: z.ZodString;
    response_time_ms: z.ZodOptional<z.ZodNumber>;
    tools_count: z.ZodOptional<z.ZodNumber>;
    resources_count: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const AgentStatsSchema: z.ZodObject<{
    property_count: z.ZodOptional<z.ZodNumber>;
    publisher_count: z.ZodOptional<z.ZodNumber>;
    publishers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    creative_formats: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export declare const AgentCapabilitiesSchema: z.ZodObject<{
    tools_count: z.ZodNumber;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
    }, z.core.$strip>>>;
    standard_operations: z.ZodOptional<z.ZodObject<{
        can_search_inventory: z.ZodBoolean;
        can_get_availability: z.ZodBoolean;
        can_reserve_inventory: z.ZodBoolean;
        can_get_pricing: z.ZodBoolean;
        can_create_order: z.ZodBoolean;
        can_list_properties: z.ZodBoolean;
    }, z.core.$strip>>;
    creative_capabilities: z.ZodOptional<z.ZodObject<{
        formats_supported: z.ZodArray<z.ZodString>;
        can_generate: z.ZodBoolean;
        can_validate: z.ZodBoolean;
        can_preview: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const PropertySummarySchema: z.ZodObject<{
    total_count: z.ZodNumber;
    count_by_type: z.ZodRecord<z.ZodString, z.ZodNumber>;
    tags: z.ZodArray<z.ZodString>;
    publisher_count: z.ZodNumber;
}, z.core.$strip>;
export declare const ResolvedBrandSchema: z.ZodObject<{
    canonical_id: z.ZodString;
    canonical_domain: z.ZodString;
    brand_name: z.ZodString;
    names: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodString>>>;
    keller_type: z.ZodOptional<z.ZodEnum<{
        master: "master";
        sub_brand: "sub_brand";
        endorsed: "endorsed";
        independent: "independent";
    }>>;
    parent_brand: z.ZodOptional<z.ZodString>;
    house_domain: z.ZodOptional<z.ZodString>;
    house_name: z.ZodOptional<z.ZodString>;
    brand_agent_url: z.ZodOptional<z.ZodString>;
    brand_manifest: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    source: z.ZodEnum<{
        brand_json: "brand_json";
        community: "community";
        enriched: "enriched";
    }>;
}, z.core.$strip>;
export declare const ResolvedPropertySchema: z.ZodObject<{
    publisher_domain: z.ZodString;
    source: z.ZodEnum<{
        adagents_json: "adagents_json";
        hosted: "hosted";
        discovered: "discovered";
    }>;
    authorized_agents: z.ZodOptional<z.ZodArray<z.ZodObject<{
        url: z.ZodString;
        authorized_for: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    properties: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        type: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        identifiers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            type: z.ZodString;
            value: z.ZodString;
        }, z.core.$strip>>>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    contact: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        email: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    verified: z.ZodBoolean;
}, z.core.$strip>;
export declare const BrandRegistryItemSchema: z.ZodObject<{
    domain: z.ZodString;
    brand_name: z.ZodOptional<z.ZodString>;
    source: z.ZodEnum<{
        brand_json: "brand_json";
        community: "community";
        enriched: "enriched";
        hosted: "hosted";
    }>;
    has_manifest: z.ZodBoolean;
    verified: z.ZodBoolean;
    house_domain: z.ZodOptional<z.ZodString>;
    keller_type: z.ZodOptional<z.ZodEnum<{
        master: "master";
        sub_brand: "sub_brand";
        endorsed: "endorsed";
        independent: "independent";
    }>>;
}, z.core.$strip>;
export declare const PropertyRegistryItemSchema: z.ZodObject<{
    domain: z.ZodString;
    source: z.ZodEnum<{
        community: "community";
        enriched: "enriched";
        adagents_json: "adagents_json";
        hosted: "hosted";
        discovered: "discovered";
    }>;
    property_count: z.ZodNumber;
    agent_count: z.ZodNumber;
    verified: z.ZodBoolean;
}, z.core.$strip>;
export declare const FederatedAgentWithDetailsSchema: z.ZodObject<{
    url: z.ZodString;
    name: z.ZodString;
    type: z.ZodEnum<{
        unknown: "unknown";
        signals: "signals";
        governance: "governance";
        creative: "creative";
        sales: "sales";
        si: "si";
    }>;
    protocol: z.ZodOptional<z.ZodEnum<{
        mcp: "mcp";
        a2a: "a2a";
    }>>;
    description: z.ZodOptional<z.ZodString>;
    mcp_endpoint: z.ZodOptional<z.ZodString>;
    contact: z.ZodOptional<z.ZodObject<{
        name: z.ZodString;
        email: z.ZodString;
        website: z.ZodString;
    }, z.core.$strip>>;
    added_date: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodEnum<{
        discovered: "discovered";
        registered: "registered";
    }>>;
    member: z.ZodOptional<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        display_name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    discovered_from: z.ZodOptional<z.ZodObject<{
        publisher_domain: z.ZodOptional<z.ZodString>;
        authorized_for: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    health: z.ZodOptional<z.ZodObject<{
        online: z.ZodBoolean;
        checked_at: z.ZodString;
        response_time_ms: z.ZodOptional<z.ZodNumber>;
        tools_count: z.ZodOptional<z.ZodNumber>;
        resources_count: z.ZodOptional<z.ZodNumber>;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    stats: z.ZodOptional<z.ZodObject<{
        property_count: z.ZodOptional<z.ZodNumber>;
        publisher_count: z.ZodOptional<z.ZodNumber>;
        publishers: z.ZodOptional<z.ZodArray<z.ZodString>>;
        creative_formats: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    capabilities: z.ZodOptional<z.ZodObject<{
        tools_count: z.ZodNumber;
        tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodString;
        }, z.core.$strip>>>;
        standard_operations: z.ZodOptional<z.ZodObject<{
            can_search_inventory: z.ZodBoolean;
            can_get_availability: z.ZodBoolean;
            can_reserve_inventory: z.ZodBoolean;
            can_get_pricing: z.ZodBoolean;
            can_create_order: z.ZodBoolean;
            can_list_properties: z.ZodBoolean;
        }, z.core.$strip>>;
        creative_capabilities: z.ZodOptional<z.ZodObject<{
            formats_supported: z.ZodArray<z.ZodString>;
            can_generate: z.ZodBoolean;
            can_validate: z.ZodBoolean;
            can_preview: z.ZodBoolean;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    publisher_domains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    property_summary: z.ZodOptional<z.ZodObject<{
        total_count: z.ZodNumber;
        count_by_type: z.ZodRecord<z.ZodString, z.ZodNumber>;
        tags: z.ZodArray<z.ZodString>;
        publisher_count: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const FederatedPublisherSchema: z.ZodObject<{
    domain: z.ZodString;
    source: z.ZodOptional<z.ZodEnum<{
        discovered: "discovered";
        registered: "registered";
    }>>;
    member: z.ZodOptional<z.ZodObject<{
        slug: z.ZodOptional<z.ZodString>;
        display_name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    agent_count: z.ZodOptional<z.ZodNumber>;
    last_validated: z.ZodOptional<z.ZodString>;
    discovered_from: z.ZodOptional<z.ZodObject<{
        agent_url: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    has_valid_adagents: z.ZodOptional<z.ZodBoolean>;
    discovered_at: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const DomainLookupResultSchema: z.ZodObject<{
    domain: z.ZodString;
    authorized_agents: z.ZodArray<z.ZodObject<{
        url: z.ZodString;
        authorized_for: z.ZodOptional<z.ZodString>;
        source: z.ZodOptional<z.ZodEnum<{
            discovered: "discovered";
            registered: "registered";
        }>>;
        member: z.ZodOptional<z.ZodObject<{
            slug: z.ZodOptional<z.ZodString>;
            display_name: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    sales_agents_claiming: z.ZodArray<z.ZodObject<{
        url: z.ZodString;
        source: z.ZodOptional<z.ZodEnum<{
            discovered: "discovered";
            registered: "registered";
        }>>;
        member: z.ZodOptional<z.ZodObject<{
            slug: z.ZodOptional<z.ZodString>;
            display_name: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ValidationResultSchema: z.ZodObject<{
    valid: z.ZodBoolean;
    domain: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodString>;
    errors: z.ZodOptional<z.ZodArray<z.ZodString>>;
    warnings: z.ZodOptional<z.ZodArray<z.ZodString>>;
    status_code: z.ZodOptional<z.ZodNumber>;
    raw_data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
//# sourceMappingURL=registry.d.ts.map