/**
 * AdCP Protocol Tools — Meta-Tool Pattern
 *
 * Three tools replace 43 individual tool definitions:
 * - ask_about_adcp_task: Search SKILL.md docs for task parameters, workflows, concepts
 * - call_adcp_task: Execute any AdCP task against an agent
 * - get_adcp_capabilities: Discover agent capabilities (unchanged)
 *
 * Task definitions live in ADCP_TASK_REGISTRY. Documentation lives in skills/adcp-{area}/SKILL.md.
 * Use debug=true to see protocol-level details (requests, responses, schema validation).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { AgentContextDatabase } from '../../db/agent-context-db.js';
import { AuthenticationRequiredError } from '@adcp/client';
import { TRAINING_AGENT_HOSTNAMES } from '../../training-agent/config.js';

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
// TASK REGISTRY
// ============================================

type ProtocolArea = 'media-buy' | 'creative' | 'signals' | 'governance' | 'si' | 'brand-protocol';

interface AdcpTaskMeta {
  area: ProtocolArea;
  description: string;
  validate?: (params: Record<string, unknown>) => string | null;
}

export const ADCP_TASK_REGISTRY: Record<string, AdcpTaskMeta> = {
  // Media Buy
  get_products: { area: 'media-buy', description: 'Discover advertising products from a sales agent using natural language briefs' },
  create_media_buy: {
    area: 'media-buy',
    description: 'Create an advertising campaign from selected products',
    validate: (params) => {
      if (!params.brand) return 'brand is required (with domain).';
      if (!params.packages || !Array.isArray(params.packages)) return 'packages array is required.';
      if (!params.start_time) return 'start_time is required.';
      if (!params.end_time) return 'end_time is required.';
      return null;
    },
  },
  sync_creatives: {
    area: 'media-buy',
    description: 'Upload and manage creative assets for a campaign',
    validate: (params) => {
      if (!params.creatives || !Array.isArray(params.creatives)) return 'creatives array is required.';
      return null;
    },
  },
  sync_catalogs: { area: 'media-buy', description: 'Sync product catalogs, store locations, job postings, and other structured feeds to a seller account' },
  list_creative_formats: { area: 'media-buy', description: 'View supported creative specifications from a sales or creative agent' },
  list_authorized_properties: { area: 'media-buy', description: 'Get the list of publisher properties this sales agent can sell' },
  get_media_buys: { area: 'media-buy', description: 'Retrieve media buy state: status, valid_actions, creative approvals, pending formats' },
  get_media_buy_delivery: { area: 'media-buy', description: 'Retrieve performance metrics for a campaign' },
  update_media_buy: {
    area: 'media-buy',
    description: 'Modify an existing media buy (dates, pause/resume, cancel, budget, targeting, creatives)',
    validate: (params) => {
      if (!params.account) return 'account is required (account_id or brand+operator).';
      if (!params.media_buy_id) return 'media_buy_id is required to identify the media buy to update.';
      return null;
    },
  },
  list_creatives: { area: 'media-buy', description: 'Query and search the creative library with filtering, sorting, and pagination' },
  provide_performance_feedback: { area: 'media-buy', description: 'Share performance outcomes with publishers to enable optimization' },

  // Creative
  build_creative: { area: 'creative', description: 'Generate a creative from a brief or transform an existing creative to a different format' },
  preview_creative: {
    area: 'creative',
    description: 'Generate visual previews of creative manifests',
    validate: (params) => {
      if (!params.request_type) return 'request_type is required (single, batch, or variant).';
      if (params.request_type === 'single' && !params.creative_manifest) return 'creative_manifest is required for single mode.';
      if (params.request_type === 'batch' && !params.requests) return 'requests array is required for batch mode.';
      if (params.request_type === 'variant' && !params.variant_id) return 'variant_id is required for variant mode.';
      return null;
    },
  },
  get_creative_delivery: { area: 'creative', description: 'Retrieve variant-level creative delivery data from a creative agent' },

  // Signals
  get_signals: { area: 'signals', description: 'Discover audience signals using natural language' },
  activate_signal: { area: 'signals', description: 'Activate a signal for use on a specific platform or agent' },

  // Governance — Property Lists
  create_property_list: {
    area: 'governance',
    description: 'Create a property list for brand safety and inventory targeting',
    validate: (params) => {
      if (!params.name) return 'name is required.';
      return null;
    },
  },
  update_property_list: { area: 'governance', description: 'Modify an existing property list' },
  get_property_list: { area: 'governance', description: 'Retrieve a property list with optional resolution of filters' },
  list_property_lists: { area: 'governance', description: 'List all property lists accessible to the authenticated principal' },
  delete_property_list: { area: 'governance', description: 'Delete a property list' },

  // Governance — Collection Lists
  create_collection_list: { area: 'governance', description: 'Create a collection list for program-level brand safety' },
  update_collection_list: { area: 'governance', description: 'Modify an existing collection list' },
  get_collection_list: { area: 'governance', description: 'Retrieve a collection list with optional resolution' },
  list_collection_lists: { area: 'governance', description: 'List all collection lists accessible to the authenticated principal' },
  delete_collection_list: { area: 'governance', description: 'Delete a collection list' },

  // Governance — Content Standards
  create_content_standards: {
    area: 'governance',
    description: 'Create content standards (brand safety rules) for campaign compliance',
    validate: (params) => {
      if (!params.name) return 'name is required.';
      return null;
    },
  },
  get_content_standards: { area: 'governance', description: 'Retrieve content standards by ID' },
  update_content_standards: { area: 'governance', description: 'Modify existing content standards' },
  list_content_standards: { area: 'governance', description: 'List all content standards accessible to the authenticated principal' },
  calibrate_content: { area: 'governance', description: 'Test content samples against content standards to validate configuration' },
  get_media_buy_artifacts: { area: 'governance', description: 'Get creative artifacts from a media buy for compliance review' },
  validate_content_delivery: { area: 'governance', description: 'Validate delivered content against content standards' },

  // Sponsored Intelligence (SI)
  si_initiate_session: { area: 'si', description: 'Start a conversational session with a brand agent' },
  si_send_message: {
    area: 'si',
    description: 'Send a message within an active SI session',
    validate: (params) => {
      if (!params.message && !params.action_response) return 'Either message or action_response must be provided.';
      return null;
    },
  },
  si_get_offering: { area: 'si', description: 'Get offering details and availability before initiating a session' },
  si_terminate_session: { area: 'si', description: 'End an SI session' },

  // Brand Protocol
  get_brand_identity: { area: 'brand-protocol', description: 'Get brand identity data from a brand agent' },
  get_rights: { area: 'brand-protocol', description: 'Search for licensable rights (talent, IP, content) from a brand agent' },
  acquire_rights: {
    area: 'brand-protocol',
    description: 'Acquire rights from a brand agent for a campaign',
    validate: (params) => {
      if (!params.rights_id) return 'rights_id is required (from get_rights response).';
      if (!params.pricing_option_id) return 'pricing_option_id is required.';
      if (!params.buyer) return 'buyer is required (with domain).';
      if (!params.campaign) return 'campaign is required (with description and uses).';
      return null;
    },
  },
  update_rights: { area: 'brand-protocol', description: 'Update an existing rights grant (extend dates, adjust caps, pause/resume)' },

  // Note: get_adcp_capabilities is NOT in this registry — it has its own dedicated
  // tool definition and handler. Using call_adcp_task for it would be redundant.
};

const TASK_NAMES = Object.keys(ADCP_TASK_REGISTRY);

// ============================================
// SKILL.MD DOCUMENTATION LOADER
// ============================================

interface SkillSection {
  area: string;
  heading: string;
  content: string;
  keywords: string[];
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'about', 'between', 'out', 'up',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'or', 'and', 'but', 'if', 'not', 'no', 'so', 'than', 'too',
  'very', 'just', 'how', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'it', 'its', 'they', 'them', 'their',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function loadSkillDocs(): SkillSection[] {
  const sections: SkillSection[] = [];
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const skillsDir = path.join(__dirname, '../../../../skills');

  let dirs: string[];
  try {
    dirs = fs.readdirSync(skillsDir).filter(d =>
      d.startsWith('adcp-') && fs.statSync(path.join(skillsDir, d)).isDirectory()
    );
  } catch {
    logger.warn({ skillsDir }, 'Could not read skills directory');
    return sections;
  }

  for (const dir of dirs) {
    const skillPath = path.join(skillsDir, dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }

    // Strip frontmatter
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) content = content.slice(fmMatch[0].length);

    const area = dir.replace('adcp-', '');

    // Split by ## and ### headings
    const lines = content.split('\n');
    let currentHeading = area;
    let currentContent: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^#{2,3}\s+(.+)/);
      if (headingMatch) {
        // Save previous section
        if (currentContent.length > 0) {
          const text = currentContent.join('\n').trim();
          if (text) {
            sections.push({
              area,
              heading: currentHeading,
              content: text,
              keywords: tokenize(`${currentHeading} ${text}`),
            });
          }
        }
        currentHeading = headingMatch[1];
        currentContent = [];
      } else {
        currentContent.push(line);
      }
    }

    // Save last section
    if (currentContent.length > 0) {
      const text = currentContent.join('\n').trim();
      if (text) {
        sections.push({
          area,
          heading: currentHeading,
          content: text,
          keywords: tokenize(`${currentHeading} ${text}`),
        });
      }
    }
  }

  return sections;
}

// Load once at module init
const skillSections = loadSkillDocs();

function searchSkillDocs(question: string): string {
  const queryTokens = tokenize(question);

  if (queryTokens.length === 0) {
    return formatAvailableAreas();
  }

  // Score each section by keyword overlap
  const scored = skillSections.map(section => {
    let score = 0;
    for (const qt of queryTokens) {
      for (const kw of section.keywords) {
        if (kw === qt) { score += 3; break; }
        if (kw.includes(qt) || qt.includes(kw)) { score += 1; break; }
      }
      // Bonus for heading match
      if (section.heading.toLowerCase().includes(qt)) score += 5;
    }
    return { section, score };
  });

  // Filter and sort
  const matches = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (matches.length === 0) {
    return formatAvailableAreas();
  }

  // Build Matching Tasks section first so we can reserve space for it
  const registryMatches = TASK_NAMES.filter(name => {
    const meta = ADCP_TASK_REGISTRY[name];
    return queryTokens.some(qt =>
      name.includes(qt) || meta.description.toLowerCase().includes(qt)
    );
  });

  let registrySection = '';
  if (registryMatches.length > 0) {
    registrySection = '## Matching Tasks\n\n';
    for (const name of registryMatches) {
      registrySection += `- **${name}** (${ADCP_TASK_REGISTRY[name].area}): ${ADCP_TASK_REGISTRY[name].description}\n`;
    }
  }

  // Build response with character limit, reserving space for registry section
  const MAX_CHARS = 6000;
  const docBudget = MAX_CHARS - registrySection.length;
  let result = '';

  for (const { section } of matches) {
    const entry = `## ${section.heading} (${section.area})\n\n${section.content}\n\n---\n\n`;
    if (result.length + entry.length > docBudget) break;
    result += entry;
  }

  result += registrySection;
  return result.trim();
}

function formatAvailableAreas(): string {
  const areas = new Map<string, string[]>();
  for (const [name, meta] of Object.entries(ADCP_TASK_REGISTRY)) {
    if (!areas.has(meta.area)) areas.set(meta.area, []);
    areas.get(meta.area)!.push(name);
  }

  let result = 'Available AdCP protocol areas:\n\n';
  for (const [area, tasks] of areas) {
    result += `**${area}**: ${tasks.join(', ')}\n\n`;
  }
  result += 'Ask about a specific area or task to get detailed documentation.';
  return result;
}

// ============================================
// TOOL DEFINITIONS
// ============================================

const askAboutAdcpTaskTool: AddieTool = {
  name: 'ask_about_adcp_task',
  description:
    'Search AdCP protocol documentation to understand tasks, parameters, workflows, and concepts. Returns relevant sections from protocol documentation. Call this BEFORE call_adcp_task to learn what parameters a task needs.',
  usage_hints:
    'use when you need to understand AdCP task parameters, workflows, or concepts before executing a task',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What you want to know about AdCP tasks (e.g., "how do I create a media buy?", "what parameters does get_signals accept?", "creative workflow")',
      },
    },
    required: ['question'],
  },
};

const callAdcpTaskTool: AddieTool = {
  name: 'call_adcp_task',
  description:
    'Execute any AdCP protocol task against an agent. For common tasks you can call directly — for uncommon tasks or when unsure about parameters, call ask_about_adcp_task first.',
  usage_hints:
    'use when executing any AdCP protocol operation against a sales, creative, signals, governance, SI, or brand agent',
  input_schema: {
    type: 'object',
    properties: {
      agent_url: {
        type: 'string',
        description: 'The agent URL (must be HTTPS)',
      },
      task: {
        type: 'string',
        enum: TASK_NAMES,
        description: 'The AdCP task to execute',
      },
      params: {
        type: 'object',
        description: [
          'Task-specific parameters. Quick reference for common tasks:',
          '• get_products: { brief, brand: { domain }, buying_mode?: "brief"|"wholesale"|"refine", filters?: { channels, budget_range } }',
          '• create_media_buy: { brand: { domain }, packages: [{ product_id, pricing_option_id, budget }], start_time: { type: "asap"|"scheduled" }, end_time }',
          '• update_media_buy: { account: { account_id | brand+operator }, media_buy_id, paused?, canceled?, packages?: [{ package_id, budget? }] }',
          '• sync_creatives: { creatives: [{ creative_id, format_id: { agent_url, id }, assets }], assignments? }',
          '• build_creative: { message, target_format_id: { agent_url, id }, brand?: { domain } }',
          '• get_signals: { signal_spec, destinations?, countries? }',
          'For other tasks, call ask_about_adcp_task first.',
        ].join('\n'),
      },
      debug: {
        type: 'boolean',
        description: 'Enable debug logging to see protocol-level details',
      },
    },
    required: ['agent_url', 'task'],
  },
};

const getAdcpCapabilitiesTool: AddieTool = {
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
};

// ============================================
// ALL ADCP TOOLS
// ============================================

export const ADCP_TOOLS: AddieTool[] = [
  askAboutAdcpTaskTool,
  callAdcpTaskTool,
  getAdcpCapabilitiesTool,
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

  // The training agent is served at multiple hostnames and as an internal path
  // on the main server. Recognize any of them for the in-process shortcut.
  function isTrainingAgentUrl(url: URL): boolean {
    if (TRAINING_AGENT_HOSTNAMES.has(url.hostname)) return true;
    const selfHost = new URL(getBaseUrl()).hostname;
    return url.pathname.startsWith('/api/training-agent') && url.hostname === selfHost;
  }

  // Helper to validate agent URL
  function validateAgentUrl(agentUrl: string): string | null {
    try {
      const url = new URL(agentUrl);

      // Allow the embedded training agent (same-origin or dedicated hostname)
      if (isTrainingAgentUrl(url)) {
        return null;
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
      if (isTrainingAgentUrl(parsedUrl)) {
        const { executeTrainingAgentTool } = await import('../../training-agent/task-handlers.js');
        const userId = memberContext?.workos_user?.workos_user_id;
        const ctx = { mode: 'training' as const, userId };
        const result = await executeTrainingAgentTool(task, params, ctx);
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
      logger.warn({ error, agentUrl, task }, `AdCP: ${task} failed`);

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
                agent_type: 'buying',
                protocol: 'mcp',
              });
              logger.info({ agentUrl, agentContextId: agentContext.id }, 'Created agent context for OAuth');
            }

            // Build auth URL with pending request context for auto-retry
            // Note: URLSearchParams handles encoding, so don't double-encode
            // Strip bank details from params before URL serialization — bank data
            // in URLs leaks to browser history, access logs, and referrer headers.
            const safeParams = structuredClone(params);
            for (const key of ['billing_entity', 'invoice_recipient'] as const) {
              const obj = (safeParams as Record<string, unknown>)[key];
              if (obj && typeof obj === 'object' && 'bank' in (obj as Record<string, unknown>)) {
                delete (obj as Record<string, unknown>).bank;
              }
            }
            const authParams = new URLSearchParams({
              agent_context_id: agentContext.id,
              pending_task: task,
              pending_params: JSON.stringify(safeParams),
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

  // ask_about_adcp_task handler
  handlers.set('ask_about_adcp_task', async (input: Record<string, unknown>) => {
    const question = input.question as string;
    if (!question) return '**Error:** question is required.';
    return searchSkillDocs(question);
  });

  // call_adcp_task handler
  handlers.set('call_adcp_task', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const task = input.task as string;
    const params = (input.params as Record<string, unknown>) || {};
    const debug = input.debug as boolean | undefined;

    if (!agentUrl) return '**Error:** agent_url is required.';
    if (!task) return '**Error:** task is required.';

    const meta = ADCP_TASK_REGISTRY[task];
    if (!meta) {
      return `**Error:** Unknown task "${task}". Valid tasks: ${TASK_NAMES.join(', ')}`;
    }

    if (meta.validate) {
      const error = meta.validate(params);
      if (error) return `**Error:** ${error}`;
    }

    return executeTask(agentUrl, task, params, debug);
  });

  // get_adcp_capabilities handler (unchanged — uses executeTask with empty params)
  handlers.set('get_adcp_capabilities', async (input: Record<string, unknown>) => {
    const agentUrl = input.agent_url as string;
    const debug = input.debug as boolean | undefined;
    return executeTask(agentUrl, 'get_adcp_capabilities', {}, debug);
  });

  return handlers;
}
