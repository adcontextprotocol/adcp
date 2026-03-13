/**
 * AdCP Protocol Tools
 *
 * Standard MCP tools that match the AdCP protocol specification.
 * Each tool has a typed schema that helps Claude understand the parameters.
 * Use debug=true to see protocol-level details (requests, responses, schema validation).
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { AgentContextDatabase } from '../../db/agent-context-db.js';
import { AuthenticationRequiredError } from '@adcp/client';

// Tool handler type (matches claude-client.ts internal type)
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * Base URL for OAuth redirect URLs
 * Uses BASE_URL env var in production, falls back to localhost for development
 */
function getBaseUrl(): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const port = process.env.PORT || process.env.CONDUCTOR_PORT || '3000';
  return `http://localhost:${port}`;
}

// ============================================
// MEDIA BUY TOOLS
// ============================================

export const ADCP_MEDIA_BUY_TOOLS: AddieTool[] = [
  {
    name: 'get_products',
    description:
      'Discover advertising products from a sales agent using natural language briefs. Returns available inventory with pricing, targeting, and creative format options.',
    usage_hints:
      'use when the user wants to find ad inventory, discover products, search for advertising opportunities, or start a media buying workflow',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        brief: {
          type: 'string',
          description:
            'Natural language description of campaign requirements (e.g., "Looking for premium video inventory targeting tech professionals")',
        },
        brand: {
          type: 'object',
          description: 'Brand reference — resolved to full brand identity at execution time',
          properties: {
            domain: { type: 'string', description: "Domain where /.well-known/brand.json is hosted, or the brand's operating domain" },
            brand_id: { type: 'string', description: 'Brand identifier within the house portfolio. Optional for single-brand domains.' },
          },
          required: ['domain'],
        },
        buying_mode: {
          type: 'string',
          enum: ['brief', 'wholesale', 'refine'],
          description: "Buyer intent: 'brief' for curated discovery, 'wholesale' for raw catalog access, 'refine' to iterate on previous results.",
        },
        refine: {
          type: 'array',
          description: 'Change requests for iterating on a previous get_products response. Each entry has scope (request/product/proposal), an action, and an ask.',
          items: { type: 'object' },
        },
        catalog: {
          type: 'object',
          description: 'Catalog of items the buyer wants to promote. Reference by catalog_id or provide inline items.',
        },
        account: {
          type: 'object',
          description: 'Account for product lookup. Returns pricing specific to this account.',
          properties: {
            account_id: { type: 'string', description: 'Seller-assigned account identifier' },
            brand: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
              },
              required: ['domain'],
            },
            operator: { type: 'string', description: 'Domain of the operating entity' },
          },
        },
        buyer_campaign_ref: {
          type: 'string',
          description: "Buyer's campaign reference label for CRM correlation.",
        },
        filters: {
          type: 'object',
          description: 'Optional filters to narrow results',
          properties: {
            channels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by channel types (video, display, audio, ctv, dooh, etc.)',
            },
            budget_range: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
            },
            delivery_type: {
              type: 'string',
              enum: ['guaranteed', 'non-guaranteed'],
            },
            format_types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by format types',
            },
          },
        },
        property_list: {
          type: 'object',
          description: 'Reference to an externally managed property list for filtering products.',
          properties: {
            agent_url: { type: 'string', description: 'URL of the agent managing the list' },
            list_id: { type: 'string', description: 'Property list identifier' },
          },
          required: ['agent_url', 'list_id'],
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific product fields to include in the response. Omit for all fields.',
        },
        time_budget: {
          type: 'object',
          description: 'Maximum time the buyer will commit to this request. Seller returns best results within this budget.',
          properties: {
            value: { type: 'number', description: 'Duration value' },
            unit: { type: 'string', enum: ['seconds', 'minutes', 'hours', 'days'], description: 'Duration unit' },
          },
        },
        pagination: {
          type: 'object',
          description: 'Cursor-based pagination parameters.',
          properties: {
            max_results: { type: 'integer', description: 'Max items per page (1-100)' },
            cursor: { type: 'string', description: 'Cursor from previous response' },
          },
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details (requests, responses, schema validation)',
        },
      },
      required: ['agent_url', 'brief'],
    },
  },
  {
    name: 'create_media_buy',
    description:
      'Create an advertising campaign from selected products. Returns media_buy_id and initial status.',
    usage_hints:
      'use after get_products when the user wants to create a campaign, buy ads, or place an order',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        buyer_ref: {
          type: 'string',
          description: 'Your unique identifier for this campaign',
        },
        buyer_campaign_ref: {
          type: 'string',
          description: "Buyer's campaign reference label for CRM correlation.",
        },
        account: {
          type: 'object',
          description: 'Account to bill for this media buy.',
          properties: {
            account_id: { type: 'string', description: 'Seller-assigned account identifier' },
            brand: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
              },
              required: ['domain'],
            },
            operator: { type: 'string', description: 'Domain of the operating entity' },
          },
        },
        proposal_id: {
          type: 'string',
          description: 'ID of a proposal from get_products to execute instead of providing packages.',
        },
        total_budget: {
          type: 'object',
          description: 'Total budget when executing a proposal. Publisher derives package budgets from allocation percentages.',
          properties: {
            amount: { type: 'number', description: 'Total budget amount' },
            currency: { type: 'string', description: 'ISO 4217 currency code' },
          },
          required: ['amount', 'currency'],
        },
        brand: {
          type: 'object',
          description: 'Brand reference — resolved to full brand identity at execution time',
          properties: {
            domain: { type: 'string', description: "Domain where /.well-known/brand.json is hosted, or the brand's operating domain" },
            brand_id: { type: 'string', description: 'Brand identifier within the house portfolio. Optional for single-brand domains.' },
          },
          required: ['domain'],
        },
        po_number: {
          type: 'string',
          description: 'Purchase order number for tracking.',
        },
        packages: {
          type: 'array',
          description: 'Products to purchase',
          items: {
            type: 'object',
            properties: {
              buyer_ref: { type: 'string', description: 'Your identifier for this package' },
              product_id: { type: 'string', description: 'From get_products response' },
              pricing_option_id: { type: 'string', description: "From product's pricing_options" },
              budget: { type: 'number', description: 'Budget amount in dollars' },
              bid_price: { type: 'number', description: 'Required for auction pricing' },
              targeting_overlay: { type: 'object', description: 'Additional targeting constraints' },
              creative_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'References to existing creatives',
              },
            },
            required: ['buyer_ref', 'product_id', 'pricing_option_id', 'budget'],
          },
        },
        start_time: {
          type: 'object',
          description: 'When to start - { type: "asap" } or { type: "scheduled", datetime: "ISO-8601" }',
          properties: {
            type: { type: 'string', enum: ['asap', 'scheduled'] },
            datetime: { type: 'string' },
          },
          required: ['type'],
        },
        end_time: {
          type: 'string',
          description: 'ISO 8601 datetime when campaign ends',
        },
        push_notification_config: {
          type: 'object',
          description: 'Webhook configuration for async task status notifications.',
        },
        reporting_webhook: {
          type: 'object',
          description: 'Webhook configuration for automated reporting delivery.',
        },
        artifact_webhook: {
          type: 'object',
          description: 'Webhook configuration for content artifact delivery (governance validation).',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'buyer_ref', 'brand', 'packages', 'start_time', 'end_time'],
    },
  },
  {
    name: 'sync_creatives',
    description:
      'Upload and manage creative assets for a campaign. Supports upsert semantics with optional assignment to packages.',
    usage_hints:
      'use when the user wants to upload creatives, add creative assets, or assign creatives to campaign packages',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        account: {
          type: 'object',
          description: 'Account that owns these creatives.',
          properties: {
            account_id: { type: 'string', description: 'Seller-assigned account identifier' },
            brand: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
              },
              required: ['domain'],
            },
            operator: { type: 'string', description: 'Domain of the operating entity' },
          },
        },
        creatives: {
          type: 'array',
          description: 'Creative assets to sync',
          items: {
            type: 'object',
            properties: {
              creative_id: { type: 'string', description: 'Your unique identifier' },
              name: { type: 'string', description: 'Human-readable name' },
              format_id: {
                type: 'object',
                description: 'Format specification reference',
                properties: {
                  agent_url: { type: 'string' },
                  id: { type: 'string' },
                },
                required: ['agent_url', 'id'],
              },
              assets: {
                type: 'object',
                description: 'Asset content keyed by asset name (video, image, html, etc.)',
              },
            },
            required: ['creative_id', 'format_id', 'assets'],
          },
        },
        creative_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit sync scope to specific creative IDs for partial updates.',
        },
        assignments: {
          type: 'array',
          description: 'Assign creatives to packages with optional weight and placement targeting.',
          items: {
            type: 'object',
            properties: {
              creative_id: { type: 'string', description: 'Creative to assign' },
              package_id: { type: 'string', description: 'Package to assign to' },
              weight: { type: 'number', description: 'Relative delivery weight (0-100)' },
              placement_ids: { type: 'array', items: { type: 'string' }, description: 'Restrict to specific placements within the package' },
            },
            required: ['creative_id', 'package_id'],
          },
        },
        idempotency_key: {
          type: 'string',
          description: 'Client-generated key for safe retries (at-most-once execution).',
        },
        delete_missing: {
          type: 'boolean',
          description: 'When true, creatives not in this sync are archived.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview changes without applying',
        },
        validation_mode: {
          type: 'string',
          enum: ['strict', 'lenient'],
          description: "Validation strictness. 'strict' fails on any error, 'lenient' processes valid creatives.",
        },
        push_notification_config: {
          type: 'object',
          description: 'Webhook configuration for async sync notifications.',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'creatives'],
    },
  },
  {
    name: 'sync_catalogs',
    description:
      'Sync product catalogs, store locations, job postings, hotel listings, and other structured feeds to a seller account. Supports inline items or external feed URLs. When called without catalogs, returns all catalogs on the account (discovery mode).',
    usage_hints:
      'use when the user wants to push product feeds, catalog data, store locations, job postings, hotel listings, or other structured data to a seller account. Also use to discover what catalogs already exist on an account. Use after list_creative_formats shows catalog asset requirements, or before sync_creatives when the format needs catalog data.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        account: {
          type: 'object',
          description: 'The account that owns the catalogs',
          properties: {
            account_id: { type: 'string', description: 'Account identifier' },
          },
          required: ['account_id'],
        },
        catalogs: {
          type: 'array',
          description: 'Catalog objects to sync. Omit for discovery mode (returns all catalogs on the account).',
          items: {
            type: 'object',
            properties: {
              catalog_id: { type: 'string', description: "Buyer's identifier for this catalog" },
              name: { type: 'string', description: 'Human-readable catalog name' },
              type: {
                type: 'string',
                description: 'Catalog type',
                enum: [
                  'offering', 'product', 'inventory', 'store', 'promotion',
                  'hotel', 'flight', 'job', 'vehicle', 'real_estate',
                  'education', 'destination', 'app',
                ],
              },
              url: { type: 'string', description: 'External feed URL (mutually exclusive with items)' },
              feed_format: {
                type: 'string',
                description: 'Feed format when using url',
                enum: ['google_merchant_center', 'facebook_catalog', 'shopify', 'linkedin_jobs', 'custom'],
              },
              update_frequency: {
                type: 'string',
                description: 'How often the feed should be refreshed',
                enum: ['realtime', 'hourly', 'daily', 'weekly'],
              },
              items: {
                type: 'array',
                description: 'Inline catalog data (mutually exclusive with url). Item schema depends on catalog type — e.g., Offering objects for "offering", JobItem for "job", HotelItem for "hotel".',
                items: { type: 'object' },
              },
              feed_field_mappings: {
                type: 'array',
                description: 'Field normalization rules for mapping non-standard feed fields to AdCP schema',
                items: {
                  type: 'object',
                  properties: {
                    source_field: { type: 'string', description: 'Field name in the external feed' },
                    target_field: { type: 'string', description: 'AdCP schema field to map to' },
                    transform: { type: 'string', description: 'Named transform (date, divide, boolean, split)' },
                  },
                },
              },
            },
            required: ['type'],
          },
        },
        catalog_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to specific catalog IDs. In discovery mode (catalogs omitted), returns only these catalogs.',
        },
        delete_missing: {
          type: 'boolean',
          description: 'Remove catalogs not included in this sync (default: false). Use with caution — catalogs not in the request will be permanently deleted from the account.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview changes without applying',
        },
        validation_mode: {
          type: 'string',
          description: 'Validation strictness for catalog data',
          enum: ['strict', 'lenient'],
        },
        push_notification_config: {
          type: 'object',
          description: 'Webhook configuration for async sync notifications.',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'account'],
    },
  },
  {
    name: 'list_creative_formats',
    description:
      'View supported creative specifications from a sales or creative agent. Returns format definitions with dimensions and asset requirements.',
    usage_hints:
      'use when the user wants to see what creative formats are supported, understand creative specs, or check dimension requirements',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL (must be HTTPS)',
        },
        format_ids: {
          type: 'array',
          description: 'Return only these specific format IDs.',
          items: {
            type: 'object',
            properties: {
              agent_url: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['agent_url', 'id'],
          },
        },
        type: {
          type: 'string',
          description: 'Filter by format type (video, display, audio, native, etc.)',
        },
        asset_types: {
          type: 'array',
          items: { type: 'string' },
          description: "Filter to formats with these asset types (image, video, html, javascript, etc.).",
        },
        max_width: {
          type: 'integer',
          description: 'Maximum width in pixels (inclusive).',
        },
        max_height: {
          type: 'integer',
          description: 'Maximum height in pixels (inclusive).',
        },
        min_width: {
          type: 'integer',
          description: 'Minimum width in pixels (inclusive).',
        },
        min_height: {
          type: 'integer',
          description: 'Minimum height in pixels (inclusive).',
        },
        is_responsive: {
          type: 'boolean',
          description: 'Filter for responsive formats that adapt to container size.',
        },
        name_search: {
          type: 'string',
          description: 'Search formats by name (case-insensitive partial match).',
        },
        wcag_level: {
          type: 'string',
          description: 'Filter to formats meeting at least this WCAG level (A, AA, AAA).',
        },
        disclosure_positions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to formats supporting all of these disclosure positions.',
        },
        disclosure_persistence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to formats where each persistence mode is supported by at least one position.',
        },
        output_format_ids: {
          type: 'array',
          description: 'Filter to formats that can produce these output formats.',
          items: {
            type: 'object',
            properties: {
              agent_url: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['agent_url', 'id'],
          },
        },
        input_format_ids: {
          type: 'array',
          description: 'Filter to formats that accept these input formats.',
          items: {
            type: 'object',
            properties: {
              agent_url: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['agent_url', 'id'],
          },
        },
        pagination: {
          type: 'object',
          description: 'Cursor-based pagination parameters.',
          properties: {
            max_results: { type: 'integer', description: 'Max items per page (1-100)' },
            cursor: { type: 'string', description: 'Cursor from previous response' },
          },
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'list_authorized_properties',
    description:
      "Get the list of publisher properties this sales agent can sell. Returns authorized domain names.",
    usage_hints:
      'use when the user wants to see what publishers or properties an agent can sell',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'get_media_buy_delivery',
    description:
      'Retrieve performance metrics for a campaign. Returns impressions, spend, clicks, and other delivery data.',
    usage_hints:
      'use when the user wants to check campaign performance, see delivery stats, or monitor a media buy',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        account: {
          type: 'object',
          description: 'Filter delivery data to a specific account.',
          properties: {
            account_id: { type: 'string', description: 'Seller-assigned account identifier' },
            brand: {
              type: 'object',
              properties: {
                domain: { type: 'string' },
              },
              required: ['domain'],
            },
            operator: { type: 'string', description: 'Domain of the operating entity' },
          },
        },
        media_buy_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of publisher media buy IDs to get delivery data for.',
        },
        buyer_refs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of buyer reference IDs to get delivery data for.',
        },
        status_filter: {
          type: 'string',
          description: 'Filter by media buy status. Can be a single status or array.',
        },
        start_date: {
          type: 'string',
          description: 'Start date for reporting period (YYYY-MM-DD).',
        },
        end_date: {
          type: 'string',
          description: 'End date for reporting period (YYYY-MM-DD).',
        },
        include_package_daily_breakdown: {
          type: 'boolean',
          description: 'Include daily_breakdown arrays within each package for pacing analysis.',
        },
        attribution_window: {
          type: 'object',
          description: 'Attribution window for conversion metrics (post_click, post_view, model).',
        },
        reporting_dimensions: {
          type: 'object',
          description: 'Request dimensional breakdowns (geo, device_type, device_platform, audience, placement).',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'update_media_buy',
    description:
      'Modify an existing media buy using PATCH semantics. Supports campaign-level updates (dates, pause/resume) and package-level updates (budget, targeting, creatives).',
    usage_hints:
      'use when the user wants to modify a campaign, pause/resume ads, change budget, update targeting, or swap creatives',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        media_buy_id: {
          type: 'string',
          description: 'Publisher\'s media buy identifier to update (use this OR buyer_ref)',
        },
        buyer_ref: {
          type: 'string',
          description: 'Your reference for the media buy to update (use this OR media_buy_id)',
        },
        start_time: {
          type: 'string',
          description: 'Updated campaign start time (ISO 8601)',
        },
        end_time: {
          type: 'string',
          description: 'Updated campaign end time (ISO 8601)',
        },
        paused: {
          type: 'boolean',
          description: 'Pause (true) or resume (false) the entire media buy',
        },
        packages: {
          type: 'array',
          description: 'Package-level updates',
          items: {
            type: 'object',
            properties: {
              package_id: { type: 'string', description: 'Publisher\'s package ID (use this OR buyer_ref)' },
              buyer_ref: { type: 'string', description: 'Your package reference (use this OR package_id)' },
              paused: { type: 'boolean', description: 'Pause/resume this package' },
              budget: { type: 'number', description: 'Updated budget' },
              bid_price: { type: 'number', description: 'Updated bid price (auction only)' },
              targeting_overlay: { type: 'object', description: 'Updated targeting restrictions' },
              creative_assignments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    creative_id: { type: 'string' },
                    weight: { type: 'number' },
                  },
                  required: ['creative_id'],
                },
                description: 'Replace creative assignments',
              },
            },
          },
        },
        reporting_webhook: {
          type: 'object',
          description: 'Webhook configuration for automated reporting delivery.',
        },
        push_notification_config: {
          type: 'object',
          description: 'Webhook configuration for async update notifications.',
        },
        idempotency_key: {
          type: 'string',
          description: 'Client-generated key for safe retries (at-most-once execution).',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'list_creatives',
    description:
      'Query and search the creative library with filtering, sorting, and pagination. Supports filtering by format, status, tags, dates, and assignments.',
    usage_hints:
      'use when the user wants to browse creatives, search the creative library, or find specific creative assets',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        filters: {
          type: 'object',
          description: 'Filter criteria',
          properties: {
            formats: { type: 'array', items: { type: 'string' }, description: 'Filter by format types' },
            statuses: { type: 'array', items: { type: 'string' }, description: 'Filter by statuses (approved, pending_review, rejected, archived)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'ALL tags must match (AND)' },
            tags_any: { type: 'array', items: { type: 'string' }, description: 'ANY tag must match (OR)' },
            name_contains: { type: 'string', description: 'Case-insensitive name search' },
            creative_ids: { type: 'array', items: { type: 'string' }, description: 'Specific creative IDs' },
            created_after: { type: 'string', description: 'ISO 8601 datetime' },
            created_before: { type: 'string', description: 'ISO 8601 datetime' },
            assigned_to_packages: { type: 'array', items: { type: 'string' }, description: 'Assigned to these packages' },
            media_buy_ids: { type: 'array', items: { type: 'string' }, description: 'Assigned to these media buys' },
            unassigned: { type: 'boolean', description: 'Only unassigned creatives' },
          },
        },
        sort: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: ['created_date', 'updated_date', 'name', 'status', 'assignment_count'] },
            direction: { type: 'string', enum: ['asc', 'desc'] },
          },
        },
        pagination: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max results (1-100, default 50)' },
            offset: { type: 'number', description: 'Results to skip' },
          },
        },
        include_assignments: { type: 'boolean', description: 'Include package assignments (default true)' },
        include_snapshot: { type: 'boolean', description: 'Include lightweight delivery snapshot (lifetime impressions, last served date)' },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'provide_performance_feedback',
    description:
      'Share performance outcomes with publishers to enable data-driven optimization. Uses a normalized performance index (0.0 = no value, 1.0 = expected, >1.0 = above expected).',
    usage_hints:
      'use when the user wants to share campaign performance data with a publisher, provide optimization feedback, or report conversion metrics',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The sales agent URL (must be HTTPS)',
        },
        media_buy_id: {
          type: 'string',
          description: 'Publisher\'s media buy identifier',
        },
        buyer_ref: {
          type: 'string',
          description: "Buyer's reference for the media buy.",
        },
        measurement_period: {
          type: 'object',
          description: 'Time period for performance measurement',
          properties: {
            start: { type: 'string', description: 'ISO 8601 start datetime' },
            end: { type: 'string', description: 'ISO 8601 end datetime' },
          },
          required: ['start', 'end'],
        },
        performance_index: {
          type: 'number',
          description: 'Normalized score (0.0 = no value, 1.0 = expected, >1.0 = above expected)',
        },
        package_id: {
          type: 'string',
          description: 'Specific package (if feedback is package-specific)',
        },
        creative_id: {
          type: 'string',
          description: 'Specific creative (if feedback is creative-specific)',
        },
        metric_type: {
          type: 'string',
          enum: ['overall_performance', 'conversion_rate', 'brand_lift', 'click_through_rate', 'completion_rate', 'viewability', 'brand_safety', 'cost_efficiency'],
          description: 'The business metric being measured',
        },
        feedback_source: {
          type: 'string',
          enum: ['buyer_attribution', 'third_party_measurement', 'platform_analytics', 'verification_partner'],
          description: 'Source of the performance data',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'media_buy_id', 'measurement_period', 'performance_index'],
    },
  },
];

// ============================================
// CREATIVE TOOLS
// ============================================

export const ADCP_CREATIVE_TOOLS: AddieTool[] = [
  {
    name: 'build_creative',
    description:
      'Generate a creative from a brief or transform an existing creative to a different format. Supports single-format (target_format_id) or multi-format (target_format_ids) requests. Returns one or more creative manifests.',
    usage_hints:
      'use when the user wants to generate ad creatives, transform creative sizes, or build creative assets from a brief. Use target_format_ids when the user wants multiple formats generated in a single call.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The creative agent URL (must be HTTPS)',
        },
        message: {
          type: 'string',
          description: 'Natural language instructions for generation or transformation',
        },
        target_format_id: {
          type: 'object',
          description:
            'Single format to generate. Exactly one of target_format_id or target_format_ids must be provided.',
          properties: {
            agent_url: { type: 'string' },
            id: { type: 'string' },
            width: { type: 'integer', description: 'Width in pixels for visual formats' },
            height: { type: 'integer', description: 'Height in pixels for visual formats' },
            duration_ms: { type: 'number', description: 'Duration in ms for time-based formats' },
          },
          required: ['agent_url', 'id'],
        },
        target_format_ids: {
          type: 'array',
          description:
            'Array of formats to generate in a single call. Exactly one of target_format_id or target_format_ids must be provided. Returns one manifest per format.',
          items: {
            type: 'object',
            properties: {
              agent_url: { type: 'string' },
              id: { type: 'string' },
              width: { type: 'integer', description: 'Width in pixels for visual formats' },
              height: { type: 'integer', description: 'Height in pixels for visual formats' },
              duration_ms: {
                type: 'number',
                description: 'Duration in ms for time-based formats',
              },
            },
            required: ['agent_url', 'id'],
          },
          minItems: 1,
        },
        creative_manifest: {
          type: 'object',
          description: 'Source manifest - minimal for generation, complete for transformation',
        },
        brand: {
          type: 'object',
          description: 'Brand reference for creative generation. Resolved to full identity (colors, logos, tone).',
          properties: {
            domain: { type: 'string', description: "Domain where /.well-known/brand.json is hosted, or the brand's operating domain" },
            brand_id: { type: 'string', description: 'Brand identifier within the house portfolio. Optional for single-brand domains.' },
          },
          required: ['domain'],
        },
        quality: {
          type: 'string',
          enum: ['draft', 'production'],
          description: "'draft' for fast iteration, 'production' for final delivery.",
        },
        item_limit: {
          type: 'integer',
          description: 'Max catalog items to use when generating.',
        },
        creative_id: {
          type: 'string',
          description: 'Reference to a creative in the agent library. Use instead of creative_manifest when retrieving an existing creative for tag generation or format adaptation.',
        },
        concept_id: {
          type: 'string',
          description: 'Creative concept containing the creative. Required to disambiguate when creative_id is not globally unique.',
        },
        media_buy_id: {
          type: 'string',
          description: "Buyer's media buy reference for tag generation context. Provides trafficking context when the creative agent is also the ad server.",
        },
        package_id: {
          type: 'string',
          description: "Buyer's package or line item reference within the media buy. Used with media_buy_id for line-item-level tag generation context.",
        },
        macro_values: {
          type: 'object',
          description: 'Macro values to pre-substitute into output assets. Keys are universal macro names (e.g., CLICK_URL, CACHEBUSTER); values are substitution strings.',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'preview_creative',
    description:
      'Generate visual previews of creative manifests. Returns preview URLs or HTML.',
    usage_hints:
      'use when the user wants to see how a creative will look, preview ad renderings, or validate creative output',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The creative agent URL (must be HTTPS)',
        },
        request_type: {
          type: 'string',
          enum: ['single', 'batch'],
          description: 'Single preview or batch of multiple creatives',
        },
        format_id: {
          type: 'object',
          description: 'Format identifier (for single preview)',
          properties: {
            agent_url: { type: 'string' },
            id: { type: 'string' },
          },
        },
        creative_manifest: {
          type: 'object',
          description: 'The creative manifest to preview',
        },
        requests: {
          type: 'array',
          description: 'For batch preview - array of { creative_manifest } objects',
        },
        output_format: {
          type: 'string',
          enum: ['url', 'html'],
          description: 'Output format (default: url)',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'request_type'],
    },
  },
];

// ============================================
// SIGNALS TOOLS
// ============================================

export const ADCP_SIGNALS_TOOLS: AddieTool[] = [
  {
    name: 'get_signals',
    description:
      'Discover audience signals using natural language. Returns matching signals with coverage, pricing, and deployment status.',
    usage_hints:
      'use when the user wants to find audience data, discover targeting segments, or search for signal providers',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The signal agent URL (must be HTTPS)',
        },
        signal_spec: {
          type: 'string',
          description: 'Natural language description of desired signals (e.g., "High-income households interested in luxury goods")',
        },
        destinations: {
          type: 'array',
          description:
            'Filter signals to those activatable on specific agents/platforms. When omitted, returns all signals available on the current agent.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['platform', 'agent'] },
              platform: { type: 'string', description: 'DSP name (e.g., "the-trade-desk")' },
              agent_url: { type: 'string', description: 'Sales agent URL' },
              account: { type: 'string', description: 'Optional account identifier' },
            },
            required: ['type'],
          },
        },
        countries: {
          type: 'array',
          description: 'Countries where signals will be used (ISO 3166-1 alpha-2 codes)',
          items: { type: 'string' },
        },
        filters: {
          type: 'object',
          properties: {
            catalog_types: { type: 'array', items: { type: 'string' } },
            data_providers: { type: 'array', items: { type: 'string' } },
            max_cpm: { type: 'number' },
            min_coverage_percentage: { type: 'number' },
          },
        },
        max_results: {
          type: 'number',
          description: 'Limit number of results',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'signal_spec'],
    },
  },
  {
    name: 'activate_signal',
    description:
      'Activate a signal for use on a specific platform or agent. Returns activation key for targeting.',
    usage_hints:
      'use when the user wants to activate an audience segment, deploy a signal to a DSP, or enable targeting data',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The signal agent URL (must be HTTPS)',
        },
        signal_agent_segment_id: {
          type: 'string',
          description: 'Signal identifier from get_signals response',
        },
        deployments: {
          type: 'array',
          description: 'Target deployments',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['platform', 'agent'] },
              platform: { type: 'string' },
              agent_url: { type: 'string' },
              account: { type: 'string' },
            },
            required: ['type'],
          },
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'signal_agent_segment_id', 'deployments'],
    },
  },
];

// ============================================
// GOVERNANCE TOOLS - Property Lists
// ============================================

export const ADCP_GOVERNANCE_PROPERTY_TOOLS: AddieTool[] = [
  {
    name: 'create_property_list',
    description:
      'Create a property list for brand safety and inventory targeting. Combines static property sets with dynamic filters. Used for setup-time campaign planning, not real-time bid decisions.',
    usage_hints:
      'use when the user wants to create an include/exclude list for campaigns, set up brand safety rules, or define compliant property sets',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The governance agent URL (must be HTTPS)',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the list',
        },
        description: {
          type: 'string',
          description: 'Description of the list purpose',
        },
        base_properties: {
          type: 'array',
          description: 'Property sources to evaluate (publisher_tags, publisher_ids, or identifiers)',
          items: {
            type: 'object',
            properties: {
              selection_type: { type: 'string', enum: ['publisher_tags', 'publisher_ids', 'identifiers'] },
              publisher_domain: { type: 'string', description: 'For publisher_tags/publisher_ids' },
              tags: { type: 'array', items: { type: 'string' }, description: 'For publisher_tags' },
              property_ids: { type: 'array', items: { type: 'string' }, description: 'For publisher_ids' },
              identifiers: {
                type: 'array',
                description: 'For identifiers selection type',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    value: { type: 'string' },
                  },
                },
              },
            },
            required: ['selection_type'],
          },
        },
        filters: {
          type: 'object',
          description: 'Filters applied when resolving the list',
          properties: {
            countries_all: { type: 'array', items: { type: 'string' }, description: 'ISO country codes - property must have data for ALL (required)' },
            channels_any: { type: 'array', items: { type: 'string' }, description: 'Channels - property must support ANY (required)' },
            property_types: { type: 'array', items: { type: 'string' }, description: 'website, mobile_app, ctv_app, etc.' },
            feature_requirements: {
              type: 'array',
              description: 'Requirements based on agent-provided features',
              items: {
                type: 'object',
                properties: {
                  feature_id: { type: 'string' },
                  min_value: { type: 'number' },
                  max_value: { type: 'number' },
                  allowed_values: { type: 'array' },
                  if_not_covered: { type: 'string', enum: ['exclude', 'include'] },
                },
                required: ['feature_id'],
              },
            },
            exclude_identifiers: {
              type: 'array',
              items: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'string' } } },
            },
          },
        },
        brand: {
          type: 'object',
          description: 'Brand reference — agent applies appropriate rules based on industry, audience, etc.',
          properties: {
            domain: { type: 'string', description: "Domain where /.well-known/brand.json is hosted, or the brand's operating domain" },
            brand_id: { type: 'string', description: 'Brand identifier within the house portfolio. Optional for single-brand domains.' },
          },
          required: ['domain'],
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging',
        },
      },
      required: ['agent_url', 'name'],
    },
  },
  {
    name: 'update_property_list',
    description:
      'Modify an existing property list. Can update filters, base properties, or webhook configuration.',
    usage_hints:
      'use when the user wants to modify a property list, change filters, or update brand safety rules',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The governance agent URL (must be HTTPS)',
        },
        list_id: {
          type: 'string',
          description: 'Property list identifier to update',
        },
        name: { type: 'string' },
        description: { type: 'string' },
        base_properties: { type: 'array', description: 'Replace base property sources' },
        filters: { type: 'object', description: 'Replace filter configuration' },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'list_id'],
    },
  },
  {
    name: 'get_property_list',
    description:
      'Retrieve a property list with optional resolution of filters. Returns metadata or resolved property identifiers.',
    usage_hints:
      'use when the user wants to view a property list, see what properties are included, or get the resolved list for campaign targeting',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The governance agent URL (must be HTTPS)',
        },
        list_id: {
          type: 'string',
          description: 'Property list identifier',
        },
        resolve: {
          type: 'boolean',
          description: 'Whether to resolve filters and return property identifiers (default: false)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum properties to return when resolved',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'list_id'],
    },
  },
  {
    name: 'list_property_lists',
    description:
      'List all property lists accessible to the authenticated principal.',
    usage_hints:
      'use when the user wants to see all their property lists, browse available lists, or search for specific lists',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The governance agent URL (must be HTTPS)',
        },
        name_contains: {
          type: 'string',
          description: 'Filter by name substring',
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'delete_property_list',
    description:
      'Delete a property list.',
    usage_hints:
      'use when the user wants to remove a property list they no longer need',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The governance agent URL (must be HTTPS)',
        },
        list_id: {
          type: 'string',
          description: 'Property list identifier to delete',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'list_id'],
    },
  },
];

// ============================================
// GOVERNANCE TOOLS - Content Standards
// ============================================

export const ADCP_GOVERNANCE_CONTENT_TOOLS: AddieTool[] = [
  {
    name: 'create_content_standards',
    description:
      'Create content standards (brand safety rules) for campaign compliance. Defines what content types, categories, and contexts are acceptable.',
    usage_hints:
      'use when the user wants to set up brand safety policies, define content restrictions, or create compliance rules',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The governance agent URL (must be HTTPS)',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the standards',
        },
        description: {
          type: 'string',
          description: 'Description of the standards',
        },
        rules: {
          type: 'array',
          description: 'Content rules to apply',
          items: {
            type: 'object',
            properties: {
              rule_type: { type: 'string', description: 'Type of rule (category, keyword, context, etc.)' },
              action: { type: 'string', enum: ['allow', 'block', 'flag'] },
              value: { type: 'string', description: 'Rule value or pattern' },
              severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            },
          },
        },
        brand: {
          type: 'object',
          description: 'Brand reference for automatic rule inference',
          properties: {
            domain: { type: 'string', description: "Domain where /.well-known/brand.json is hosted, or the brand's operating domain" },
            brand_id: { type: 'string', description: 'Brand identifier within the house portfolio. Optional for single-brand domains.' },
          },
          required: ['domain'],
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'name'],
    },
  },
  {
    name: 'get_content_standards',
    description:
      'Retrieve content standards by ID.',
    usage_hints:
      'use when the user wants to view content standards details or check brand safety rules',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        standards_id: { type: 'string', description: 'Content standards identifier' },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'standards_id'],
    },
  },
  {
    name: 'update_content_standards',
    description:
      'Modify existing content standards.',
    usage_hints:
      'use when the user wants to update brand safety rules or modify content restrictions',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        standards_id: { type: 'string', description: 'Content standards identifier to update' },
        name: { type: 'string' },
        description: { type: 'string' },
        rules: { type: 'array', description: 'Replace rules configuration' },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'standards_id'],
    },
  },
  {
    name: 'list_content_standards',
    description:
      'List all content standards accessible to the authenticated principal.',
    usage_hints:
      'use when the user wants to see all their content standards or browse available policies',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        name_contains: { type: 'string', description: 'Filter by name substring' },
        max_results: { type: 'number' },
        debug: { type: 'boolean' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'delete_content_standards',
    description:
      'Delete content standards.',
    usage_hints:
      'use when the user wants to remove content standards they no longer need',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        standards_id: { type: 'string', description: 'Content standards identifier to delete' },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'standards_id'],
    },
  },
  {
    name: 'calibrate_content',
    description:
      'Calibrate content against content standards. Tests specific content samples to validate standards configuration.',
    usage_hints:
      'use when the user wants to test content against brand safety rules, validate standards, or preview compliance decisions',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        standards_id: { type: 'string', description: 'Content standards to calibrate against' },
        samples: {
          type: 'array',
          description: 'Content samples to test',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL of content to analyze' },
              text: { type: 'string', description: 'Text content to analyze' },
              expected_result: { type: 'string', enum: ['allow', 'block'], description: 'Expected classification' },
            },
          },
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'standards_id', 'samples'],
    },
  },
  {
    name: 'get_media_buy_artifacts',
    description:
      'Get creative artifacts from a media buy for compliance review. Returns creative assets and metadata for brand safety validation.',
    usage_hints:
      'use when the user wants to review creatives from a campaign for compliance, audit ad content, or validate brand safety',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        media_buy_id: { type: 'string', description: 'Media buy identifier' },
        sales_agent_url: { type: 'string', description: 'Sales agent URL that owns the media buy' },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'media_buy_id', 'sales_agent_url'],
    },
  },
  {
    name: 'validate_content_delivery',
    description:
      'Validate delivered content against content standards. Checks if actual delivery met compliance requirements.',
    usage_hints:
      'use when the user wants to audit content delivery, verify brand safety compliance, or check for policy violations',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The governance agent URL (must be HTTPS)' },
        standards_id: { type: 'string', description: 'Content standards to validate against' },
        media_buy_id: { type: 'string', description: 'Media buy identifier' },
        sales_agent_url: { type: 'string', description: 'Sales agent URL' },
        date_range: {
          type: 'object',
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
          },
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'standards_id', 'media_buy_id', 'sales_agent_url'],
    },
  },
];

// ============================================
// SPONSORED INTELLIGENCE (SI) TOOLS
// ============================================

export const ADCP_SI_TOOLS: AddieTool[] = [
  {
    name: 'si_initiate_session',
    description:
      'Start a conversational session with a brand agent. Used when a user expresses interest in engaging with a brand for shopping, inquiries, or transactions.',
    usage_hints:
      'use when the user wants to start a conversation with a brand, begin a shopping session, or engage with sponsored content',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The SI agent URL (must be HTTPS)',
        },
        context: {
          type: 'string',
          description: 'Natural language description of user intent',
        },
        identity: {
          type: 'object',
          description: 'User identity with consent status',
          properties: {
            consent_granted: { type: 'boolean', description: 'Whether user consented to share identity' },
            consent_timestamp: { type: 'string', description: 'ISO 8601 timestamp of consent' },
            consent_scope: { type: 'array', items: { type: 'string' }, description: 'Fields user agreed to share' },
            user: {
              type: 'object',
              description: 'User PII (only if consent_granted)',
              properties: {
                email: { type: 'string' },
                name: { type: 'string' },
                locale: { type: 'string' },
              },
            },
            anonymous_session_id: { type: 'string', description: 'Session ID if no consent' },
          },
          required: ['consent_granted'],
        },
        media_buy_id: {
          type: 'string',
          description: 'AdCP media buy ID if triggered by advertising',
        },
        placement: {
          type: 'string',
          description: 'Where the session was triggered (e.g., "chatgpt_search")',
        },
        offering_id: {
          type: 'string',
          description: 'Brand-specific offering reference',
        },
        offering_token: {
          type: 'string',
          description: 'Token from si_get_offering for session continuity',
        },
        supported_capabilities: {
          type: 'object',
          description: 'What the host platform supports (modalities, components, commerce)',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'context', 'identity'],
    },
  },
  {
    name: 'si_send_message',
    description:
      'Send a message within an active SI session. Relays user messages and action responses to the brand agent.',
    usage_hints:
      'use when the user sends a message in a brand conversation, clicks a button, or submits a form in an SI session',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The SI agent URL (must be HTTPS)',
        },
        session_id: {
          type: 'string',
          description: 'Session ID from si_initiate_session',
        },
        message: {
          type: 'string',
          description: 'User\'s text message',
        },
        action_response: {
          type: 'object',
          description: 'Response to a UI action (button click, form submit)',
          properties: {
            action: { type: 'string', description: 'Action identifier from UI element' },
            element_id: { type: 'string' },
            payload: { type: 'object', description: 'Additional data from interaction' },
          },
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'session_id'],
    },
  },
  {
    name: 'si_get_offering',
    description:
      'Get offering details, availability, and optionally matching products before initiating a session. Allows showing rich previews before asking for consent.',
    usage_hints:
      'use when the user wants to preview brand offerings, see available products, or check offering details before starting a conversation',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The SI agent URL (must be HTTPS)',
        },
        offering_id: {
          type: 'string',
          description: 'Offering identifier from the catalog',
        },
        context: {
          type: 'string',
          description: 'Natural language context for personalized results (no PII)',
        },
        include_products: {
          type: 'boolean',
          description: 'Whether to include matching products',
        },
        product_limit: {
          type: 'number',
          description: 'Max products to return (default 5, max 50)',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'offering_id'],
    },
  },
  {
    name: 'si_terminate_session',
    description:
      'End an SI session. Can be initiated by host or brand agent, with different reasons indicating how the session concluded.',
    usage_hints:
      'use when the user ends a brand conversation, completes a transaction, or the session times out',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The SI agent URL (must be HTTPS)',
        },
        session_id: {
          type: 'string',
          description: 'Session ID to terminate',
        },
        reason: {
          type: 'string',
          enum: ['handoff_transaction', 'handoff_complete', 'user_exit', 'session_timeout', 'host_terminated'],
          description: 'Why the session is ending',
        },
        termination_context: {
          type: 'object',
          description: 'Additional context for the termination',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url', 'session_id', 'reason'],
    },
  },
];

// ============================================
// PROTOCOL TOOLS
// ============================================

export const ADCP_PROTOCOL_TOOLS: AddieTool[] = [
  {
    name: 'get_adcp_capabilities',
    description:
      'Discover an agent\'s AdCP protocol support and capabilities. Returns supported tasks, domains, features, and configuration.',
    usage_hints:
      'use when the user wants to discover what an agent can do, check supported features, or understand agent capabilities before using other tasks',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL to query (must be HTTPS)',
        },
        debug: { type: 'boolean' },
      },
      required: ['agent_url'],
    },
  },
];

// ============================================
// ALL ADCP TOOLS
// ============================================

export const ADCP_TOOLS: AddieTool[] = [
  ...ADCP_MEDIA_BUY_TOOLS,
  ...ADCP_CREATIVE_TOOLS,
  ...ADCP_SIGNALS_TOOLS,
  ...ADCP_GOVERNANCE_PROPERTY_TOOLS,
  ...ADCP_GOVERNANCE_CONTENT_TOOLS,
  ...ADCP_SI_TOOLS,
  ...ADCP_PROTOCOL_TOOLS,
];

// ============================================
// TOOL HANDLERS
// ============================================

/**
 * Create handlers for AdCP protocol tools.
 * These wrap the AdCPClient to execute tasks with proper parameter mapping.
 */
export function createAdcpToolHandlers(
  memberContext: MemberContext | null
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const agentContextDb = new AgentContextDatabase();

  // Helper to get auth credentials for an agent (checks OAuth first, then static token)
  async function getAuthInfo(agentUrl: string): Promise<{ token: string; authType: 'bearer' | 'basic' } | undefined> {
    const organizationId = memberContext?.organization?.workos_organization_id;
    if (!organizationId) return undefined;

    try {
      // First check for OAuth tokens (always bearer)
      const oauthTokens = await agentContextDb.getOAuthTokensByOrgAndUrl(organizationId, agentUrl);
      if (oauthTokens) {
        // Check if token is expired
        if (oauthTokens.expires_at) {
          const expiresAt = new Date(oauthTokens.expires_at);
          if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
            logger.debug({ agentUrl }, 'Using OAuth access token for agent');
            return { token: oauthTokens.access_token, authType: 'bearer' };
          }
          // Token expired or expiring soon - could refresh here in future
          logger.debug({ agentUrl, expiresAt }, 'OAuth token expired or expiring soon');
        } else {
          // No expiration, use the token
          logger.debug({ agentUrl }, 'Using OAuth access token for agent (no expiration)');
          return { token: oauthTokens.access_token, authType: 'bearer' };
        }
      }

      // Fall back to static auth token (may be bearer or basic)
      const authInfo = await agentContextDb.getAuthInfoByOrgAndUrl(organizationId, agentUrl);
      if (authInfo) {
        logger.debug({ agentUrl, authType: authInfo.authType }, 'Using static auth token for agent');
        return authInfo;
      }
    } catch (error) {
      logger.debug({ error, agentUrl }, 'Failed to get auth info for agent');
    }
    return undefined;
  }

  // Helper to validate agent URL
  function validateAgentUrl(agentUrl: string): string | null {
    try {
      const url = new URL(agentUrl);

      // Allow the embedded training agent only if same-origin (prevents SSRF via external URLs with matching path)
      if (url.pathname.startsWith('/api/training-agent')) {
        const selfHost = new URL(getBaseUrl()).hostname;
        if (url.hostname === selfHost) {
          return null;
        }
        // External URL with /api/training-agent path — fall through to normal validation
      }

      if (url.protocol !== 'https:') {
        return 'Agent URL must use HTTPS protocol.';
      }

      const hostname = url.hostname.toLowerCase();
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        hostname.match(/^172\.(1[6-9]|2\d|3[01])\./) ||
        hostname === '169.254.169.254'
      ) {
        return 'Agent URL cannot point to internal or private networks.';
      }

      return null; // Valid
    } catch {
      return 'Invalid agent URL format.';
    }
  }

  // Helper to execute AdCP task
  async function executeTask(
    agentUrl: string,
    task: string,
    params: Record<string, unknown>,
    debug: boolean = false
  ): Promise<string> {
    const validationError = validateAgentUrl(agentUrl);
    if (validationError) {
      return `**Error:** ${validationError}`;
    }

    // In-process shortcut for training agent (avoids HTTP round-trip and localhost restrictions)
    try {
      const parsedUrl = new URL(agentUrl);
      if (parsedUrl.pathname.startsWith('/api/training-agent')) {
        const { executeTrainingAgentTool } = await import('../../training-agent/task-handlers.js');
        const userId = memberContext?.workos_user?.workos_user_id;
        const ctx = { mode: 'training' as const, userId };
        const result = executeTrainingAgentTool(task, params, ctx);
        if (!result.success) {
          return `**Task failed:** \`${task}\`\n\n**Error:** ${result.error}`;
        }
        let output = `**Task:** \`${task}\`\n**Status:** Success (sandbox)\n\n`;
        output += `**Response:**\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``;
        return output;
      }
    } catch (err) {
      logger.warn({ error: err, agentUrl, task }, 'Training agent in-process shortcut failed, falling through to HTTP');
    }

    const authInfo = await getAuthInfo(agentUrl);

    logger.info({ agentUrl, task, hasAuth: !!authInfo, authType: authInfo?.authType, debug }, `AdCP: executing ${task}`);

    try {
      const { AdCPClient } = await import('@adcp/client');

      const agentConfig = {
        id: 'target',
        name: 'target',
        agent_uri: agentUrl,
        protocol: 'mcp' as const,
        ...(authInfo?.authType === 'basic'
          ? { headers: { 'Authorization': `Basic ${authInfo.token}` } }
          : authInfo ? { auth_token: authInfo.token } : {}),
      };

      const multiClient = new AdCPClient(
        [agentConfig],
        { debug }
      );
      const client = multiClient.agent('target');

      const result = await client.executeTask(task, params, undefined, { debug });

      if (!result.success) {
        let output = `**Task failed:** \`${task}\`\n\n**Error:**\n\`\`\`json\n${JSON.stringify(result.error, null, 2)}\n\`\`\``;

        // Include debug logs on failure (always useful for debugging)
        if (result.debug_logs && result.debug_logs.length > 0) {
          output += `\n\n**Debug Logs:**\n\`\`\`json\n${JSON.stringify(result.debug_logs, null, 2)}\n\`\`\``;
        }

        return output;
      }

      let output = `**Task:** \`${task}\`\n**Status:** Success\n\n`;
      output += `**Response:**\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``;

      // Include debug logs if debug mode is enabled
      if (debug && result.debug_logs && result.debug_logs.length > 0) {
        output += `\n\n**Debug Logs:**\n\`\`\`json\n${JSON.stringify(result.debug_logs, null, 2)}\n\`\`\``;
      }

      return output;
    } catch (error) {
      logger.error({ error, agentUrl, task }, `AdCP: ${task} failed`);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Handle AuthenticationRequiredError from @adcp/client (includes OAuth metadata)
      if (error instanceof AuthenticationRequiredError) {
        const organizationId = memberContext?.organization?.workos_organization_id;
        if (organizationId && error.hasOAuth) {
          try {
            // Get or create agent context for OAuth flow
            const baseUrl = new URL(agentUrl);
            let agentContext = await agentContextDb.getByOrgAndUrl(organizationId, agentUrl);
            if (!agentContext) {
              agentContext = await agentContextDb.create({
                organization_id: organizationId,
                agent_url: agentUrl,
                agent_name: baseUrl.hostname,
                agent_type: 'sales',
                protocol: 'mcp',
              });
              logger.info({ agentUrl, agentContextId: agentContext.id }, 'Created agent context for OAuth');
            }

            // Build auth URL with pending request context for auto-retry
            // Note: URLSearchParams handles encoding, so don't double-encode
            const authParams = new URLSearchParams({
              agent_context_id: agentContext.id,
              pending_task: task,
              pending_params: JSON.stringify(params),
            });
            const authUrl = `${getBaseUrl()}/api/oauth/agent/start?${authParams.toString()}`;

            return (
              `**Task failed:** \`${task}\`\n\n` +
              `**Error:** OAuth authorization required\n\n` +
              `The agent at \`${agentUrl}\` requires OAuth authentication.\n\n` +
              `**[Click here to authorize this agent](${authUrl})**\n\n` +
              `After you authorize, I'll automatically retry your request.`
            );
          } catch (oauthSetupError) {
            logger.debug({ error: oauthSetupError, agentUrl }, 'Failed to set up OAuth flow');
          }
        }

        // OAuth not available or couldn't set up flow
        return (
          `**Task failed:** \`${task}\`\n\n` +
          `**Error:** Authentication required\n\n` +
          `The agent at \`${agentUrl}\` requires authentication. ` +
          `Please check with the agent provider for authentication requirements.`
        );
      }

      return `**Task failed:** \`${task}\`\n\n**Error:** ${errorMessage}`;
    }
  }

  // Fields that are Addie routing concerns, not protocol parameters
  const ADDIE_FIELDS = new Set(['agent_url', 'debug']);

  // Pre-call validation for tools with mutual exclusivity constraints
  const PRE_VALIDATION: Record<string, (input: Record<string, unknown>) => string | null> = {
    update_media_buy: (input) => {
      if (!input.media_buy_id && !input.buyer_ref) {
        return 'Either media_buy_id or buyer_ref must be provided to identify the media buy to update.';
      }
      return null;
    },
    si_send_message: (input) => {
      if (!input.message && !input.action_response) {
        return 'Either message or action_response must be provided.';
      }
      return null;
    },
  };

  // Register a generic passthrough handler for every AdCP tool.
  // Strips Addie-specific fields (agent_url, debug) and forwards
  // all protocol parameters to the SDK's executeTask unchanged.
  for (const tool of ADCP_TOOLS) {
    handlers.set(tool.name, async (input: Record<string, unknown>) => {
      const agentUrl = input.agent_url as string;
      const debug = input.debug as boolean | undefined;

      const validator = PRE_VALIDATION[tool.name];
      if (validator) {
        const error = validator(input);
        if (error) return `**Error:** ${error}`;
      }

      // Forward all defined values including null/false/0/"" —
      // schema validation is the remote agent's responsibility.
      const params: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (!ADDIE_FIELDS.has(key) && value !== undefined) {
          params[key] = value;
        }
      }

      return executeTask(agentUrl, tool.name, params, debug);
    });
  }

  return handlers;
}
