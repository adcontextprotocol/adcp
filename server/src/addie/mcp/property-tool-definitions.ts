// PROPERTY_TOOLS: the tool definitions of property-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

/**
 * Property tool definitions for Addie
 */
export const PROPERTY_TOOLS: AddieTool[] = [
  {
    name: 'validate_adagents',
    description: 'Validate a domain\'s /.well-known/adagents.json file with a live fetch. Returns validation results including any errors or warnings.',
    usage_hints: 'Use when asked to check if a publisher has set up adagents.json, or to validate a domain\'s agent authorizations. If check_publisher_authorization disagrees after a recent file update, rerun that tool with force_refresh: true because it uses a short authorization cache.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain to validate (e.g., "nytimes.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'resolve_property',
    description: 'Resolve a publisher domain to its property information. Checks hosted properties, discovered properties, and live adagents.json.',
    usage_hints: 'Use when asked about a publisher\'s property setup, authorized agents, or inventory.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain to resolve (e.g., "cnn.com")',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'save_property',
    description: 'Save or approve a hosted property in the registry. Creates new properties, approves pending ones, or updates existing ones.',
    usage_hints: 'Use to create, update, or approve hosted properties. For pending properties from enhance_property, calling save_property approves and publishes them.',
    input_schema: {
      type: 'object',
      properties: {
        publisher_domain: {
          type: 'string',
          description: 'Publisher domain',
        },
        properties: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              name: { type: 'string' },
            },
          },
          description: 'Array of properties (inventory types)',
        },
        catalog_etag: {
          type: 'string',
          description: 'Optional adagents.json catalog_etag cache/version token',
        },
        formats: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional adagents.json formats[] publisher catalog entries',
        },
        placements: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional adagents.json placements[] entries',
        },
        contact: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          description: 'Contact information',
        },
        source_type: {
          type: 'string',
          enum: ['community', 'enriched'],
          description: 'Source type - "community" for manually contributed',
        },
      },
      required: ['publisher_domain'],
    },
  },
  {
    name: 'list_properties',
    description: 'List publisher properties in the registry. Can filter by source type and search by domain.',
    usage_hints: 'Use when asked about publishers in the registry, or to find properties by domain.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['adagents_json', 'hosted', 'discovered'],
          description: 'Filter by source type',
        },
        search: {
          type: 'string',
          description: 'Search term for publisher domain',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
        },
      },
    },
  },
  {
    name: 'list_missing_properties',
    description: 'List the most-requested publisher domains that are not yet in the registry. Shows demand signals — which properties people are looking for but we don\'t have.',
    usage_hints: 'Use when asked about gaps in the property registry, or to find publishers worth onboarding. Pair with save_property to fill gaps.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20)',
        },
      },
    },
  },
  {
    name: 'check_property_list',
    description: 'Check a list of publisher domains against the AAO registry. Returns a summary of issues and a report URL for full details. Domains are automatically normalized (www/m stripped), duplicates removed, and known ad tech infrastructure flagged.',
    usage_hints: 'Use when a member wants to validate their property include/exclude list, or after receiving a property list to audit before use in targeting. Returns a compact summary to avoid overwhelming the context window — full details are in the report_url.',
    input_schema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Publisher domains to check (up to 10,000)',
        },
      },
      required: ['domains'],
    },
  },
  {
    name: 'enhance_property',
    description: 'Analyze an unknown publisher domain and submit it to the registry as a pending entry for review. Checks domain age (flags < 90 days as high risk), validates adagents.json presence, and uses AI to assess whether it\'s a real publisher and its likely inventory types.',
    usage_hints: 'Use for domains in the assess bucket from check_property_list that a member wants added to the registry. Run one domain at a time.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Publisher domain to analyze and submit to the registry',
        },
      },
      required: ['domain'],
    },
  },
  {
    name: 'resolve_catalog',
    description: 'Resolve identifiers (domains, app bundles, store IDs) to stable property_rids in the catalog. Auto-creates missing properties. Excludes known ad infrastructure and publisher masks. Returns property_rid for each identifier.',
    usage_hints: 'Use when a buyer agent or member needs to map a list of domains/identifiers to catalog property_rids for property lists or TMP. Supports up to 10,000 identifiers per call.',
    input_schema: {
      type: 'object',
      properties: {
        identifiers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Identifier type (domain, ios_bundle, android_package, etc.)' },
              value: { type: 'string', description: 'Identifier value' },
            },
            required: ['type', 'value'],
          },
          description: 'Array of identifiers to resolve',
        },
        provenance: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'How the caller knows about these identifiers (agency_allowlist, impression_log, ssp_inventory, deal_history, data_partner, member_assertion)' },
            context: { type: 'string', description: 'Optional context annotation' },
          },
          required: ['type'],
          description: 'Provenance of these identifiers',
        },
        mode: {
          type: 'string',
          enum: ['resolve', 'lookup'],
          description: 'resolve (default): create missing, log activity. lookup: read-only, no creates.',
        },
      },
      required: ['identifiers', 'provenance'],
    },
  },
  {
    name: 'browse_catalog',
    description: 'Browse the property catalog. Returns properties with their identifiers, classification, and source. Supports filtering and search.',
    usage_hints: 'Use when someone wants to explore what properties are in the catalog, search for specific domains, or understand catalog coverage.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term for identifier values' },
        classification: { type: 'string', enum: ['property', 'ad_infra', 'publisher_mask', 'network'], description: 'Filter by classification' },
        source: { type: 'string', enum: ['authoritative', 'enriched', 'contributed'], description: 'Filter by source' },
        limit: { type: 'number', description: 'Maximum results (default: 20)' },
      },
    },
  },
  {
    name: 'dispute_catalog_entry',
    description: 'File a dispute against a catalog entry. For identifier link disputes on medium/weak confidence, the link is suspended immediately pending review. For authoritative/strong links, the dispute is queued for review without suspension.',
    usage_hints: 'Use when a member believes a catalog entry is wrong — a false identifier link, incorrect classification, or bad property data. Provide clear evidence to support the claim.',
    input_schema: {
      type: 'object',
      properties: {
        dispute_type: {
          type: 'string',
          enum: ['identifier_link', 'classification', 'property_data', 'false_merge'],
          description: 'What is being disputed',
        },
        subject_type: { type: 'string', description: 'Type of subject (identifier, property_rid, link)' },
        subject_value: { type: 'string', description: 'The identifier or property_rid being disputed (e.g., "domain:example.com")' },
        claim: { type: 'string', description: 'What the reporter asserts is wrong (min 10 chars)' },
        evidence: { type: 'string', description: 'Supporting evidence (optional)' },
        reported_by: { type: 'string', description: 'Member ID filing the dispute (injected from session if omitted)' },
      },
      required: ['dispute_type', 'subject_type', 'subject_value', 'claim'],
    },
  },
];
