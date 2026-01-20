/**
 * AdCP Protocol Tools
 *
 * Standard MCP tools that match the AdCP protocol specification.
 * These expose the same functionality as call_adcp_agent but with
 * proper schemas that match the protocol, enabling skills to work.
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
      },
      required: ['agent_url', 'media_buy_id'],
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
      },
      required: ['agent_url', 'signal_agent_segment_id', 'deployments'],
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

  // Helper to get auth token for an agent
  async function getAuthToken(agentUrl: string): Promise<string | undefined> {
    const organizationId = memberContext?.organization?.workos_organization_id;
    if (!organizationId) return undefined;

    try {
      const token = await agentContextDb.getAuthTokenByOrgAndUrl(organizationId, agentUrl);
      if (token) {
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
    params: Record<string, unknown>
  ): Promise<string> {
    const validationError = validateAgentUrl(agentUrl);
    if (validationError) {
      return `**Error:** ${validationError}`;
    }

    const authToken = await getAuthToken(agentUrl);

    logger.info({ agentUrl, task, hasAuth: !!authToken }, `AdCP: executing ${task}`);

    try {
      const { AdCPClient } = await import('@adcp/client');
      const multiClient = new AdCPClient([
        {
          id: 'target',
          name: 'target',
          agent_uri: agentUrl,
          protocol: 'mcp',
          ...(authToken && { auth_token: authToken }),
        },
      ]);
      const client = multiClient.agent('target');

      const result = await client.executeTask(task, params);

      if (!result.success) {
        return `**Task failed:** \`${task}\`\n\n**Error:**\n\`\`\`json\n${JSON.stringify(result.error, null, 2)}\n\`\`\``;
      }

      let output = `**Task:** \`${task}\`\n**Status:** Success\n\n`;
      output += `**Response:**\n\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\``;

      return output;
    } catch (error) {
      logger.error({ error, agentUrl, task }, `AdCP: ${task} failed`);
      return `**Task failed:** \`${task}\`\n\n**Error:** ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  // Media Buy handlers
  handlers.set('get_products', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      brief: input.brief,
    };
    if (input.brand_manifest) params.brand_manifest = input.brand_manifest;
    if (input.filters) params.filters = input.filters;

    return executeTask(agentUrl, 'get_products', params);
  });

  handlers.set('create_media_buy', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      buyer_ref: input.buyer_ref,
      brand_manifest: input.brand_manifest,
      packages: input.packages,
      start_time: input.start_time,
      end_time: input.end_time,
    };

    return executeTask(agentUrl, 'create_media_buy', params);
  });

  handlers.set('sync_creatives', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      creatives: input.creatives,
    };
    if (input.assignments) params.assignments = input.assignments;
    if (input.dry_run !== undefined) params.dry_run = input.dry_run;

    return executeTask(agentUrl, 'sync_creatives', params);
  });

  handlers.set('list_creative_formats', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {};
    if (input.format_types) params.format_types = input.format_types;

    return executeTask(agentUrl, 'list_creative_formats', params);
  });

  handlers.set('list_authorized_properties', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    return executeTask(agentUrl, 'list_authorized_properties', {});
  });

  handlers.set('get_media_buy_delivery', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      media_buy_id: input.media_buy_id,
    };
    if (input.granularity) params.granularity = input.granularity;
    if (input.date_range) params.date_range = input.date_range;

    return executeTask(agentUrl, 'get_media_buy_delivery', params);
  });

  // Creative handlers
  handlers.set('build_creative', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      target_format_id: input.target_format_id,
    };
    if (input.message) params.message = input.message;
    if (input.creative_manifest) params.creative_manifest = input.creative_manifest;

    return executeTask(agentUrl, 'build_creative', params);
  });

  handlers.set('preview_creative', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      request_type: input.request_type,
    };
    if (input.format_id) params.format_id = input.format_id;
    if (input.creative_manifest) params.creative_manifest = input.creative_manifest;
    if (input.requests) params.requests = input.requests;
    if (input.output_format) params.output_format = input.output_format;

    return executeTask(agentUrl, 'preview_creative', params);
  });

  // Signals handlers
  handlers.set('get_signals', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      signal_spec: input.signal_spec,
      deliver_to: input.deliver_to,
    };
    if (input.filters) params.filters = input.filters;
    if (input.max_results) params.max_results = input.max_results;

    return executeTask(agentUrl, 'get_signals', params);
  });

  handlers.set('activate_signal', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const params: Record<string, unknown> = {
      signal_agent_segment_id: input.signal_agent_segment_id,
      deployments: input.deployments,
    };

    return executeTask(agentUrl, 'activate_signal', params);
  });

  return handlers;
}
