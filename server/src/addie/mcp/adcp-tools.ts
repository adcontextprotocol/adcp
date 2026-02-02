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

// Tool handler type (matches claude-client.ts internal type)
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

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
        brand_manifest: {
          type: 'object',
          description: 'Brand context - either { url: "https://brand.com" } or inline manifest with name, colors, etc.',
          properties: {
            url: { type: 'string', description: 'Brand website URL for context extraction' },
            name: { type: 'string', description: 'Brand name (for inline manifest)' },
          },
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
        brand_manifest: {
          type: 'object',
          description: 'Brand context - URL reference or inline manifest',
          properties: {
            url: { type: 'string' },
            name: { type: 'string' },
          },
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
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'buyer_ref', 'brand_manifest', 'packages', 'start_time', 'end_time'],
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
        assignments: {
          type: 'object',
          description: 'Map creative_id to array of package IDs',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview changes without applying',
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
        format_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to specific format categories (video, display, audio, etc.)',
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
        media_buy_id: {
          type: 'string',
          description: 'The campaign identifier from create_media_buy',
        },
        granularity: {
          type: 'string',
          enum: ['hourly', 'daily', 'weekly'],
          description: 'Time granularity for timeseries data',
        },
        date_range: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
            end: { type: 'string', description: 'ISO date (YYYY-MM-DD)' },
          },
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'media_buy_id'],
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
            field: { type: 'string', enum: ['created_date', 'updated_date', 'name', 'status', 'assignment_count', 'performance_score'] },
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
        include_performance: { type: 'boolean', description: 'Include performance metrics' },
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
      'Generate a creative from a brief or transform an existing creative to a different format. Returns a complete creative manifest.',
    usage_hints:
      'use when the user wants to generate ad creatives, transform creative sizes, or build creative assets from a brief',
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
          description: 'The format to generate',
          properties: {
            agent_url: { type: 'string' },
            id: { type: 'string' },
          },
          required: ['agent_url', 'id'],
        },
        creative_manifest: {
          type: 'object',
          description: 'Source manifest - minimal for generation, complete for transformation',
        },
        debug: {
          type: 'boolean',
          description: 'Enable debug logging to see protocol-level details',
        },
      },
      required: ['agent_url', 'target_format_id'],
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
          description: 'For batch preview - array of { format_id, creative_manifest }',
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
        deliver_to: {
          type: 'object',
          description: 'Where signals will be used',
          properties: {
            deployments: {
              type: 'array',
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
              items: { type: 'string' },
              description: 'ISO country codes',
            },
          },
          required: ['deployments'],
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
      required: ['agent_url', 'signal_spec', 'deliver_to'],
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
        brand_manifest: {
          type: 'object',
          description: 'Brand context - agent applies appropriate rules based on industry, audience, etc.',
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
        brand_manifest: { type: 'object', description: 'Brand context for automatic rule inference' },
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
          description: 'Offering identifier from promoted offerings',
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

  // Helper to get auth token for an agent (checks OAuth first, then static token)
  async function getAuthToken(agentUrl: string): Promise<string | undefined> {
    const organizationId = memberContext?.organization?.workos_organization_id;
    if (!organizationId) return undefined;

    try {
      // First check for OAuth tokens
      const oauthTokens = await agentContextDb.getOAuthTokensByOrgAndUrl(organizationId, agentUrl);
      if (oauthTokens) {
        // Check if token is expired
        if (oauthTokens.expires_at) {
          const expiresAt = new Date(oauthTokens.expires_at);
          if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
            logger.debug({ agentUrl }, 'Using OAuth access token for agent');
            return oauthTokens.access_token;
          }
          // Token expired or expiring soon - could refresh here in future
          logger.debug({ agentUrl, expiresAt }, 'OAuth token expired or expiring soon');
        } else {
          // No expiration, use the token
          logger.debug({ agentUrl }, 'Using OAuth access token for agent (no expiration)');
          return oauthTokens.access_token;
        }
      }

      // Fall back to static auth token
      const token = await agentContextDb.getAuthTokenByOrgAndUrl(organizationId, agentUrl);
      if (token) {
        logger.debug({ agentUrl }, 'Using static auth token for agent');
        return token;
      }
    } catch (error) {
      logger.debug({ error, agentUrl }, 'Failed to get auth token for agent');
    }
    return undefined;
  }

  // Helper to validate agent URL
  function validateAgentUrl(agentUrl: string): string | null {
    try {
      const url = new URL(agentUrl);

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

    const authToken = await getAuthToken(agentUrl);

    logger.info({ agentUrl, task, hasAuth: !!authToken, debug }, `AdCP: executing ${task}`);

    try {
      const { AdCPClient } = await import('@adcp/client');
      const multiClient = new AdCPClient(
        [
          {
            id: 'target',
            name: 'target',
            agent_uri: agentUrl,
            protocol: 'mcp',
            ...(authToken && { auth_token: authToken }),
          },
        ],
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

      // Check if this looks like an OAuth/auth error
      const isAuthError =
        errorMessage.toLowerCase().includes('unauthorized') ||
        errorMessage.toLowerCase().includes('authentication') ||
        errorMessage.toLowerCase().includes('oauth') ||
        errorMessage.toLowerCase().includes('401');

      if (isAuthError) {
        // Try to provide an OAuth authorization link if the agent supports it
        const organizationId = memberContext?.organization?.workos_organization_id;
        if (organizationId) {
          try {
            // Check if agent supports OAuth by looking for metadata endpoint
            const baseUrl = new URL(agentUrl);
            const metadataUrl = new URL('/.well-known/oauth-authorization-server', baseUrl.origin);
            const metadataResponse = await fetch(metadataUrl.toString(), {
              headers: { Accept: 'application/json' },
            });

            if (metadataResponse.ok) {
              // Agent supports OAuth - get or create context and provide auth link
              let agentContext = await agentContextDb.getByOrgAndUrl(organizationId, agentUrl);
              if (!agentContext) {
                // Create agent context for this agent
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
              const authParams = new URLSearchParams({
                agent_context_id: agentContext.id,
                pending_task: task,
                pending_params: encodeURIComponent(JSON.stringify(params)),
              });
              const authUrl = `/api/oauth/agent/start?${authParams.toString()}`;

              return (
                `**Task failed:** \`${task}\`\n\n` +
                `**Error:** OAuth authorization required\n\n` +
                `The agent at \`${agentUrl}\` requires OAuth authentication.\n\n` +
                `**[Click here to authorize this agent](${authUrl})**\n\n` +
                `After you authorize, I'll automatically retry your request.`
              );
            }
          } catch (oauthCheckError) {
            logger.debug({ error: oauthCheckError, agentUrl }, 'Failed to check OAuth support');
          }
        }

        // Fallback message if OAuth check fails or agent doesn't support OAuth
        return (
          `**Task failed:** \`${task}\`\n\n` +
          `**Error:** Authentication required\n\n` +
          `The agent at \`${agentUrl}\` requires authentication. ` +
          `This agent may require OAuth authentication to be configured. ` +
          `Please check with the agent provider for authentication requirements.`
        );
      }

      return `**Task failed:** \`${task}\`\n\n**Error:** ${errorMessage}`;
    }
  }

  // Media Buy handlers
  handlers.set('get_products', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      brief: input.brief,
    };
    if (input.brand_manifest) params.brand_manifest = input.brand_manifest;
    if (input.filters) params.filters = input.filters;

    return executeTask(agentUrl, 'get_products', params, debug);
  });

  handlers.set('create_media_buy', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      buyer_ref: input.buyer_ref,
      brand_manifest: input.brand_manifest,
      packages: input.packages,
      start_time: input.start_time,
      end_time: input.end_time,
    };

    return executeTask(agentUrl, 'create_media_buy', params, debug);
  });

  handlers.set('sync_creatives', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      creatives: input.creatives,
    };
    if (input.assignments) params.assignments = input.assignments;
    if (input.dry_run !== undefined) params.dry_run = input.dry_run;

    return executeTask(agentUrl, 'sync_creatives', params, debug);
  });

  handlers.set('list_creative_formats', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {};
    if (input.format_types) params.format_types = input.format_types;

    return executeTask(agentUrl, 'list_creative_formats', params, debug);
  });

  handlers.set('list_authorized_properties', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    return executeTask(agentUrl, 'list_authorized_properties', {}, debug);
  });

  handlers.set('get_media_buy_delivery', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      media_buy_id: input.media_buy_id,
    };
    if (input.granularity) params.granularity = input.granularity;
    if (input.date_range) params.date_range = input.date_range;

    return executeTask(agentUrl, 'get_media_buy_delivery', params, debug);
  });

  // Creative handlers
  handlers.set('build_creative', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      target_format_id: input.target_format_id,
    };
    if (input.message) params.message = input.message;
    if (input.creative_manifest) params.creative_manifest = input.creative_manifest;

    return executeTask(agentUrl, 'build_creative', params, debug);
  });

  handlers.set('preview_creative', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      request_type: input.request_type,
    };
    if (input.format_id) params.format_id = input.format_id;
    if (input.creative_manifest) params.creative_manifest = input.creative_manifest;
    if (input.requests) params.requests = input.requests;
    if (input.output_format) params.output_format = input.output_format;

    return executeTask(agentUrl, 'preview_creative', params, debug);
  });

  // Signals handlers
  handlers.set('get_signals', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      signal_spec: input.signal_spec,
      deliver_to: input.deliver_to,
    };
    if (input.filters) params.filters = input.filters;
    if (input.max_results) params.max_results = input.max_results;

    return executeTask(agentUrl, 'get_signals', params, debug);
  });

  handlers.set('activate_signal', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      signal_agent_segment_id: input.signal_agent_segment_id,
      deployments: input.deployments,
    };

    return executeTask(agentUrl, 'activate_signal', params, debug);
  });

  // Additional Media Buy handlers
  handlers.set('update_media_buy', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;

    if (!input.media_buy_id && !input.buyer_ref) {
      return '**Error:** Either media_buy_id or buyer_ref must be provided to identify the media buy to update.';
    }

    const params: Record<string, unknown> = {};
    if (input.media_buy_id) params.media_buy_id = input.media_buy_id;
    if (input.buyer_ref) params.buyer_ref = input.buyer_ref;
    if (input.start_time) params.start_time = input.start_time;
    if (input.end_time) params.end_time = input.end_time;
    if (input.paused !== undefined) params.paused = input.paused;
    if (input.packages) params.packages = input.packages;

    return executeTask(agentUrl, 'update_media_buy', params, debug);
  });

  handlers.set('list_creatives', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {};
    if (input.filters) params.filters = input.filters;
    if (input.sort) params.sort = input.sort;
    if (input.pagination) params.pagination = input.pagination;
    if (input.include_assignments !== undefined) params.include_assignments = input.include_assignments;
    if (input.include_performance !== undefined) params.include_performance = input.include_performance;

    return executeTask(agentUrl, 'list_creatives', params, debug);
  });

  handlers.set('provide_performance_feedback', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      media_buy_id: input.media_buy_id,
      measurement_period: input.measurement_period,
      performance_index: input.performance_index,
    };
    if (input.package_id) params.package_id = input.package_id;
    if (input.creative_id) params.creative_id = input.creative_id;
    if (input.metric_type) params.metric_type = input.metric_type;
    if (input.feedback_source) params.feedback_source = input.feedback_source;

    return executeTask(agentUrl, 'provide_performance_feedback', params, debug);
  });

  // Governance Property List handlers
  handlers.set('create_property_list', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      name: input.name,
    };
    if (input.description) params.description = input.description;
    if (input.base_properties) params.base_properties = input.base_properties;
    if (input.filters) params.filters = input.filters;
    if (input.brand_manifest) params.brand_manifest = input.brand_manifest;

    return executeTask(agentUrl, 'create_property_list', params, debug);
  });

  handlers.set('update_property_list', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      list_id: input.list_id,
    };
    if (input.name) params.name = input.name;
    if (input.description) params.description = input.description;
    if (input.base_properties) params.base_properties = input.base_properties;
    if (input.filters) params.filters = input.filters;

    return executeTask(agentUrl, 'update_property_list', params, debug);
  });

  handlers.set('get_property_list', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      list_id: input.list_id,
    };
    if (input.resolve !== undefined) params.resolve = input.resolve;
    if (input.max_results) params.max_results = input.max_results;

    return executeTask(agentUrl, 'get_property_list', params, debug);
  });

  handlers.set('list_property_lists', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {};
    if (input.name_contains) params.name_contains = input.name_contains;
    if (input.max_results) params.max_results = input.max_results;

    return executeTask(agentUrl, 'list_property_lists', params, debug);
  });

  handlers.set('delete_property_list', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    return executeTask(agentUrl, 'delete_property_list', { list_id: input.list_id }, debug);
  });

  // Governance Content Standards handlers
  handlers.set('create_content_standards', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      name: input.name,
    };
    if (input.description) params.description = input.description;
    if (input.rules) params.rules = input.rules;
    if (input.brand_manifest) params.brand_manifest = input.brand_manifest;

    return executeTask(agentUrl, 'create_content_standards', params, debug);
  });

  handlers.set('get_content_standards', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    return executeTask(agentUrl, 'get_content_standards', { standards_id: input.standards_id }, debug);
  });

  handlers.set('update_content_standards', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      standards_id: input.standards_id,
    };
    if (input.name) params.name = input.name;
    if (input.description) params.description = input.description;
    if (input.rules) params.rules = input.rules;

    return executeTask(agentUrl, 'update_content_standards', params, debug);
  });

  handlers.set('list_content_standards', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {};
    if (input.name_contains) params.name_contains = input.name_contains;
    if (input.max_results) params.max_results = input.max_results;

    return executeTask(agentUrl, 'list_content_standards', params, debug);
  });

  handlers.set('delete_content_standards', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    return executeTask(agentUrl, 'delete_content_standards', { standards_id: input.standards_id }, debug);
  });

  handlers.set('calibrate_content', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      standards_id: input.standards_id,
      samples: input.samples,
    };

    return executeTask(agentUrl, 'calibrate_content', params, debug);
  });

  handlers.set('get_media_buy_artifacts', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      media_buy_id: input.media_buy_id,
      sales_agent_url: input.sales_agent_url,
    };

    return executeTask(agentUrl, 'get_media_buy_artifacts', params, debug);
  });

  handlers.set('validate_content_delivery', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      standards_id: input.standards_id,
      media_buy_id: input.media_buy_id,
      sales_agent_url: input.sales_agent_url,
    };
    if (input.date_range) params.date_range = input.date_range;

    return executeTask(agentUrl, 'validate_content_delivery', params, debug);
  });

  // Sponsored Intelligence (SI) handlers
  handlers.set('si_initiate_session', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      context: input.context,
      identity: input.identity,
    };
    if (input.media_buy_id) params.media_buy_id = input.media_buy_id;
    if (input.placement) params.placement = input.placement;
    if (input.offering_id) params.offering_id = input.offering_id;
    if (input.offering_token) params.offering_token = input.offering_token;
    if (input.supported_capabilities) params.supported_capabilities = input.supported_capabilities;

    return executeTask(agentUrl, 'si_initiate_session', params, debug);
  });

  handlers.set('si_send_message', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;

    if (!input.message && !input.action_response) {
      return '**Error:** Either message or action_response must be provided.';
    }

    const params: Record<string, unknown> = {
      session_id: input.session_id,
    };
    if (input.message) params.message = input.message;
    if (input.action_response) params.action_response = input.action_response;

    return executeTask(agentUrl, 'si_send_message', params, debug);
  });

  handlers.set('si_get_offering', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      offering_id: input.offering_id,
    };
    if (input.context) params.context = input.context;
    if (input.include_products !== undefined) params.include_products = input.include_products;
    if (input.product_limit) params.product_limit = input.product_limit;

    return executeTask(agentUrl, 'si_get_offering', params, debug);
  });

  handlers.set('si_terminate_session', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    const params: Record<string, unknown> = {
      session_id: input.session_id,
      reason: input.reason,
    };
    if (input.termination_context) params.termination_context = input.termination_context;

    return executeTask(agentUrl, 'si_terminate_session', params, debug);
  });

  // Protocol handlers
  handlers.set('get_adcp_capabilities', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    return executeTask(agentUrl, 'get_adcp_capabilities', {}, debug);
  });

  return handlers;
}
