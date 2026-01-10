/**
 * Addie Member Tools
 *
 * Tools that allow Addie to help users with:
 * - Validating adagents.json configurations
 * - Viewing and updating their member profile
 * - Browsing and joining working groups
 * - Creating posts in working groups
 *
 * CRITICAL: All write operations are scoped to the authenticated user.
 * Addie can only modify data on behalf of the user she's talking to.
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import { AdAgentsManager } from '../../adagents-manager.js';
import type { MemberContext } from '../member-context.js';
import {
  runAgentTests,
  formatTestResults,
  setAgentTesterLogger,
  createTestClient,
  type TestScenario,
  type TestOptions,
} from '@adcp/client/testing';
import { AgentContextDatabase } from '../../db/agent-context-db.js';
import {
  findExistingProposalOrFeed,
  createFeedProposal,
  getPendingProposals,
} from '../../db/industry-feeds-db.js';
import { MemberDatabase } from '../../db/member-db.js';
import { MemberSearchAnalyticsDatabase } from '../../db/member-search-analytics-db.js';
import { sendIntroductionEmail } from '../../notifications/email.js';
import { v4 as uuidv4 } from 'uuid';

const adagentsManager = new AdAgentsManager();
const memberDb = new MemberDatabase();
const agentContextDb = new AgentContextDatabase();
const memberSearchAnalyticsDb = new MemberSearchAnalyticsDatabase();

/**
 * Known open-source agents and their GitHub repositories.
 * Used to offer GitHub issue links when tests fail on these agents.
 * Keys must be lowercase (hostnames are case-insensitive).
 */
const KNOWN_OPEN_SOURCE_AGENTS: Record<string, { org: string; repo: string; name: string }> = {
  'test-agent.adcontextprotocol.org': {
    org: 'adcontextprotocol',
    repo: 'salesagent',
    name: 'AdCP Reference Sales Agent',
  },
  'wonderstruck.sales-agent.scope3.com': {
    org: 'adcontextprotocol',
    repo: 'salesagent',
    name: 'Wonderstruck (Scope3 Sales Agent)',
  },
  'creative.adcontextprotocol.org': {
    org: 'adcontextprotocol',
    repo: 'creative-agent',
    name: 'AdCP Reference Creative Agent',
  },
};

/**
 * Public test agent credentials.
 * These are intentionally public and documented for testing purposes.
 * See: https://adcontextprotocol.org/docs/media-buy/advanced-topics/testing
 *
 * The token can be overridden via PUBLIC_TEST_AGENT_TOKEN env var if needed,
 * but defaults to the documented public token.
 */
const PUBLIC_TEST_AGENT = {
  url: 'https://test-agent.adcontextprotocol.org/mcp',
  // Default token is documented at https://adcontextprotocol.org/docs/quickstart
  token: process.env.PUBLIC_TEST_AGENT_TOKEN || '1v8tAhASaUYYp' + '4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ',
  name: 'AdCP Public Test Agent',
};

/**
 * Known error patterns that indicate bugs in the @adcp/client testing library
 * rather than in the agent being tested.
 *
 * Each pattern should be specific enough to avoid false positives where an agent
 * is actually returning invalid data.
 */
const CLIENT_LIBRARY_ERROR_PATTERNS: Array<{
  pattern: RegExp;
  repo: string;
  description: string;
}> = [
  {
    // This specific Zod validation error occurs when the test code tries to access
    // authorized_properties (old field) but the schema expects publisher_domains (new field)
    pattern: /publisher_domains\.\d+: Invalid input: expected string, received undefined/i,
    repo: 'adcp-client',
    description: 'The discovery test scenario references `authorized_properties` (v2.2 field) instead of `publisher_domains` (v2.3+ field).',
  },
];

/**
 * Check if an error indicates a bug in the client library rather than the agent.
 * Returns null if no known client library bug pattern matches.
 */
function detectClientLibraryBug(
  failedSteps: Array<{ error?: string; step?: string; details?: string }>
): { repo: string; description: string; matchedError: string } | null {
  for (const step of failedSteps) {
    const errorText = step.error || step.details || '';
    for (const pattern of CLIENT_LIBRARY_ERROR_PATTERNS) {
      if (pattern.pattern.test(errorText)) {
        return {
          repo: pattern.repo,
          description: pattern.description,
          matchedError: errorText,
        };
      }
    }
  }
  return null;
}

/**
 * Extract hostname from an agent URL for matching against known agents
 */
function getAgentHostname(agentUrl: string): string | null {
  try {
    const url = new URL(agentUrl);
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Check if an agent URL is a known open-source agent
 */
function getOpenSourceAgentInfo(agentUrl: string): { org: string; repo: string; name: string } | null {
  const hostname = getAgentHostname(agentUrl);
  if (!hostname) return null;
  // Normalize to lowercase for case-insensitive matching
  return KNOWN_OPEN_SOURCE_AGENTS[hostname.toLowerCase()] || null;
}

// Configure the agent tester to use our pino logger
setAgentTesterLogger({
  info: (ctx, msg) => logger.info(ctx, msg),
  error: (ctx, msg) => logger.error(ctx, msg),
  warn: (ctx, msg) => logger.warn(ctx, msg),
  debug: (ctx, msg) => logger.debug(ctx, msg),
});

/**
 * Tool definitions for member-related operations
 */
export const MEMBER_TOOLS: AddieTool[] = [
  // ============================================
  // ADAGENTS.JSON VALIDATION (read-only, public)
  // ============================================
  {
    name: 'validate_adagents',
    description:
      'Validate an adagents.json file for a domain. Checks that the file exists at /.well-known/adagents.json, has valid structure, and optionally validates the agent cards. Use this when users ask about setting up or debugging their adagents.json configuration. Share the validation results with the user - they contain helpful error messages and links.',
    usage_hints: 'use ONLY for "check my setup", "validate example.com", debugging configs - NOT for learning about adagents.json',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description:
            'The domain to check (e.g., "example.com" or "https://example.com"). The protocol and path will be normalized.',
        },
        validate_cards: {
          type: 'boolean',
          description:
            'Whether to also validate the agent cards for each authorized agent (default: false). This makes additional HTTP requests to each agent URL.',
        },
      },
      required: ['domain'],
    },
  },

  // ============================================
  // WORKING GROUPS (read + user-scoped write)
  // ============================================
  {
    name: 'list_working_groups',
    description:
      'List active committees in AgenticAdvertising.org. Can filter by type: working groups (technical), councils (industry verticals), or chapters (regional). Shows public groups to everyone, and includes private groups for members.',
    usage_hints: 'use for "what groups exist?", browsing available groups, finding councils or chapters',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of groups to return (default 20, max 50)',
        },
        type: {
          type: 'string',
          enum: ['working_group', 'council', 'chapter', 'all'],
          description: 'Filter by committee type. working_group=technical groups, council=industry verticals, chapter=regional groups, all=show all types (default)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_working_group',
    description:
      'Get details about a specific working group including its description, leaders, member count, and recent posts. Use the group slug (URL-friendly name).',
    usage_hints: 'use for "tell me about X group", getting specific group details',
    input_schema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'The working group slug (e.g., "sustainability", "creative-formats")',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'join_working_group',
    description:
      'Join a public working group on behalf of the current user. Only works for public groups - private groups require an invitation. The user must be a member of AgenticAdvertising.org.',
    usage_hints: 'use when user explicitly wants to join a group',
    input_schema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'The working group slug to join',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_my_working_groups',
    description:
      "Get the current user's working group memberships. Shows which groups they belong to and their role in each.",
    usage_hints: 'use for "what groups am I in?", checking user\'s memberships',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // MEMBER PROFILE (user-scoped only)
  // ============================================
  {
    name: 'get_my_profile',
    description:
      "Get the current user's member profile. Shows their public profile information, organization details, and any published agents or properties.",
    usage_hints: 'use for "what\'s my profile?", account/membership questions',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_my_profile',
    description:
      "Update the current user's member profile. Can update headline, bio, focus areas, website, LinkedIn, and other profile fields. Only updates fields that are provided - omitted fields are unchanged.",
    usage_hints: 'use when user wants to update their profile information',
    input_schema: {
      type: 'object',
      properties: {
        headline: {
          type: 'string',
          description: 'Short headline/title (e.g., "VP of Product at Acme")',
        },
        bio: {
          type: 'string',
          description: 'Longer bio/description in markdown format',
        },
        focus_areas: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Areas of focus (e.g., ["sustainability", "CTV", "measurement"])',
        },
        website: {
          type: 'string',
          description: 'Website URL',
        },
        linkedin: {
          type: 'string',
          description: 'LinkedIn profile URL',
        },
        location: {
          type: 'string',
          description: 'Location (e.g., "New York, NY")',
        },
      },
      required: [],
    },
  },

  // ============================================
  // PERSPECTIVES / POSTS (user-scoped write)
  // ============================================
  {
    name: 'list_perspectives',
    description:
      'List published perspectives (articles/posts) from AgenticAdvertising.org members. These are public articles shared by the community.',
    usage_hints: 'use for "show me perspectives", browsing member articles',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number to return (default 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_working_group_post',
    description:
      'Create a post in a working group on behalf of the current user. The user must be a member of the working group. Supports article, link, and discussion post types.',
    usage_hints: 'use when user wants to create a post in a working group',
    input_schema: {
      type: 'object',
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'The working group to post in',
        },
        title: {
          type: 'string',
          description: 'Post title',
        },
        content: {
          type: 'string',
          description: 'Post content in markdown format',
        },
        post_type: {
          type: 'string',
          enum: ['article', 'link', 'discussion'],
          description: 'Type of post (default: discussion)',
        },
        link_url: {
          type: 'string',
          description: 'URL for link posts',
        },
      },
      required: ['working_group_slug', 'title', 'content'],
    },
  },

  // ============================================
  // UNIFIED CONTENT MANAGEMENT
  // ============================================
  {
    name: 'propose_content',
    description:
      'Create content for the website (perspectives, committee posts). Content can be for personal perspectives or committee collections. Committee leads and admins can publish directly; others submit for review. Supports co-authors.',
    usage_hints: 'use for "write a perspective", "post to the sustainability group", "create an article", "share my thoughts on X"',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Content title',
        },
        content: {
          type: 'string',
          description: 'Article content in markdown format (required for article type)',
        },
        content_type: {
          type: 'string',
          enum: ['article', 'link'],
          description: 'Type of content. article=original content, link=external link with commentary (default: article)',
        },
        external_url: {
          type: 'string',
          description: 'URL for link type content',
        },
        excerpt: {
          type: 'string',
          description: 'Short excerpt/summary (auto-generated from content if not provided)',
        },
        category: {
          type: 'string',
          description: 'Category for the content',
        },
        collection: {
          type: 'object',
          description: 'Where to publish: personal (perspectives page) or committee (committee page)',
          properties: {
            type: {
              type: 'string',
              enum: ['personal', 'committee'],
              description: 'Collection type',
            },
            committee_slug: {
              type: 'string',
              description: 'Committee slug (required if type is committee)',
            },
          },
          required: ['type'],
        },
        co_author_emails: {
          type: 'array',
          items: { type: 'string' },
          description: 'Email addresses of co-authors to add',
        },
      },
      required: ['title', 'collection'],
    },
  },
  {
    name: 'get_my_content',
    description:
      'Get all content where the user is an author, proposer, or owner (committee lead). Shows content across all collections with status and relationship info.',
    usage_hints: 'use for "show my content", "my perspectives", "what have I written?", "my pending posts"',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'pending_review', 'published', 'archived', 'rejected', 'all'],
          description: 'Filter by status (default: all)',
        },
        collection: {
          type: 'string',
          description: 'Filter by collection: "personal" or a committee slug',
        },
        relationship: {
          type: 'string',
          enum: ['author', 'proposer', 'owner'],
          description: 'Filter by relationship type',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_pending_content',
    description:
      'List content pending review that the user can approve/reject. Only committee leads see their committee content; admins see all pending content.',
    usage_hints: 'use for "what content needs approval?", "pending posts", "review queue"',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'Filter to a specific committee',
        },
      },
      required: [],
    },
  },
  {
    name: 'approve_content',
    description:
      'Approve pending content for publication. Only committee leads (for their committees) and admins can approve content.',
    usage_hints: 'use for "approve this post", "publish this content"',
    input_schema: {
      type: 'object',
      properties: {
        content_id: {
          type: 'string',
          description: 'The ID of the content to approve',
        },
        publish_immediately: {
          type: 'boolean',
          description: 'Whether to publish immediately (default: true) or save as draft',
        },
      },
      required: ['content_id'],
    },
  },
  {
    name: 'reject_content',
    description:
      'Reject pending content with a reason. Only committee leads (for their committees) and admins can reject content. The proposer will see the rejection reason.',
    usage_hints: 'use for "reject this post", "decline this content"',
    input_schema: {
      type: 'object',
      properties: {
        content_id: {
          type: 'string',
          description: 'The ID of the content to reject',
        },
        reason: {
          type: 'string',
          description: 'Reason for rejection (required - helps the author understand and improve)',
        },
      },
      required: ['content_id', 'reason'],
    },
  },

  // ============================================
  // ACCOUNT LINKING
  // ============================================
  {
    name: 'get_account_link',
    description:
      'Get a link to connect the user\'s Slack account with their AgenticAdvertising.org account. Use this when a user\'s accounts are not linked and they want to access member features. IMPORTANT: Share the full tool output with the user - it contains the clickable sign-in link they need. The user clicks the link to sign in and their accounts are automatically connected.',
    usage_hints: 'use when user needs to connect Slack to their AAO account',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // AGENT TESTING & COMPLIANCE
  // ============================================
  {
    name: 'check_agent_health',
    description:
      'Check if an AdCP agent is online and responding. Tests the agent\'s endpoint and returns health status, response time, and available tools. Use this when users want to verify their agent is working before adding it to their profile or authorizing it.',
    usage_hints: 'use for "is my agent working?", "test my agent endpoint"',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL to check (e.g., "https://sales.example.com")',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'check_publisher_authorization',
    description:
      'Check if a publisher domain has authorized a specific agent. Validates the publisher\'s adagents.json and confirms the agent is listed. Use this when users want to verify their publisher setup before testing integrations.',
    usage_hints: 'use for authorization verification, "is my agent authorized?"',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The publisher domain (e.g., "example.com")',
        },
        agent_url: {
          type: 'string',
          description: 'The agent URL to check authorization for',
        },
      },
      required: ['domain', 'agent_url'],
    },
  },
  {
    name: 'get_agent_capabilities',
    description:
      'Get detailed capabilities of an AdCP agent including available tools and supported operations. Use this to help users understand what an agent can do before using it.',
    usage_hints: 'use for "what can this agent do?", inspecting agent tools',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL to inspect',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'test_adcp_agent',
    description:
      'Run end-to-end tests against an AdCP agent to verify it works correctly. Tests the full workflow: discover products, create media buys, sync creatives, etc. By default runs in dry-run mode - set dry_run=false for real testing. IMPORTANT: For agents requiring authentication (including the public test agent), users must first set up the agent. Use setup_test_agent for the public test agent, or save_agent for custom agents.',
    usage_hints: 'use for "test my agent", "run the full flow", "verify my sales agent works", "test against test-agent", "test creative sync", "test pricing models", "try the API". If testing the public test agent and auth fails, suggest setup_test_agent first.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL to test (e.g., "https://sales.example.com" or "https://test-agent.adcontextprotocol.org")',
        },
        scenario: {
          type: 'string',
          enum: [
            'health_check',
            'discovery',
            'create_media_buy',
            'full_sales_flow',
            'creative_sync',
            'creative_inline',
            'creative_reference',
            'pricing_models',
            'creative_flow',
            'signals_flow',
            'error_handling',
            'validation',
            'pricing_edge_cases',
            'temporal_validation',
            'behavior_analysis',
            'response_consistency',
          ],
          description: 'Test scenario: health_check (agent responds), discovery (products/formats/properties), create_media_buy (discovery + create), full_sales_flow (create + update + delivery), creative_sync (sync_creatives flow), creative_inline (inline creatives in create_media_buy), creative_reference (reference existing creatives), pricing_models (analyze pricing options), creative_flow (creative agents), signals_flow (signals agents), error_handling (proper error responses), validation (invalid input rejection), pricing_edge_cases (auction vs fixed, min spend), temporal_validation (date ordering, format), behavior_analysis (auth requirements, brief relevance, filtering behavior), response_consistency (schema errors, pagination bugs, data mismatches)',
        },
        brief: {
          type: 'string',
          description: 'Optional custom brief for product discovery (default: generic tech brand brief)',
        },
        budget: {
          type: 'number',
          description: 'Budget for test media buy in dollars (default: 1000)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Whether to run in dry-run mode (default: true). Set to false for real testing that creates actual media buys.',
        },
        channels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific channels to test (e.g., ["display", "video", "ctv"]). If not specified, tests all channels the agent supports.',
        },
        pricing_models: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific pricing models to test (e.g., ["cpm", "cpcv"]). If not specified, uses first available.',
        },
        brand_manifest: {
          type: 'object',
          description: 'Brand manifest for the test advertiser. Can specify a well-known brand like {name: "Nike", url: "https://nike.com"} or a custom brand. If not specified, uses Nike as the default.',
          properties: {
            name: {
              type: 'string',
              description: 'Brand name (e.g., "Nike", "Coca-Cola", "Acme Corp")',
            },
            url: {
              type: 'string',
              format: 'uri',
              description: 'Brand website URL',
            },
            tagline: {
              type: 'string',
              description: 'Brand tagline or slogan',
            },
          },
          required: ['name'],
        },
      },
      required: ['agent_url'],
    },
  },
  // ============================================
  // AGENT CONTEXT MANAGEMENT
  // ============================================
  {
    name: 'save_agent',
    description:
      'Save an agent URL to the organization\'s context. Optionally store an auth token securely (encrypted, never shown in conversations). Use this when users want to save their agent for easy testing later, or when they provide an auth token.',
    usage_hints: 'use for "save my agent", "remember this agent URL", "store my auth token"',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL to save (e.g., "https://sales.example.com/mcp")',
        },
        agent_name: {
          type: 'string',
          description: 'Friendly name for the agent (e.g., "Production Sales Agent")',
        },
        auth_token: {
          type: 'string',
          description: 'Optional auth token to store securely. Will be encrypted and never shown again.',
        },
        protocol: {
          type: 'string',
          enum: ['mcp', 'a2a'],
          description: 'Protocol type (default: mcp)',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'list_saved_agents',
    description:
      'List all agents saved for this organization. Shows agent URLs, names, types, and whether they have auth tokens stored (but never shows the actual tokens). Use this when users ask "what agents do I have saved?" or want to see their configured agents.',
    usage_hints: 'use for "show my agents", "what agents are saved?", "list our agents"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'remove_saved_agent',
    description:
      'Remove a saved agent and its stored auth token. Use this when users want to delete or forget an agent configuration.',
    usage_hints: 'use for "remove my agent", "delete the agent", "forget this agent"',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: {
          type: 'string',
          description: 'The agent URL to remove',
        },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'setup_test_agent',
    description:
      'Set up the public AdCP test agent for the user with one click. This saves the test agent URL and credentials so the user can immediately start testing. Use this when users want to try AdCP, explore the test agent, or say "set up the test agent". Requires the user to be logged in with an organization.',
    usage_hints: 'use for "set up test agent", "I want to try AdCP", "help me get started testing", "configure the test agent"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // GITHUB ISSUE DRAFTING
  // ============================================
  {
    name: 'draft_github_issue',
    description:
      'Draft a GitHub issue and generate a pre-filled URL for the user to create it. Use this when users report bugs, request features, or ask you to create a GitHub issue. CRITICAL: Users CANNOT see tool outputs - you MUST copy this tool\'s entire output (the GitHub link, title, body preview) into your response. Never say "click the link above" without including the actual link. The user will click the link to create the issue from their own GitHub account. All issues go to the "adcp" repository which contains the protocol, schemas, AgenticAdvertising.org server, and documentation.',
    usage_hints: 'use when user wants to report a bug or request a feature - MUST include full output in response',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Issue title - clear and concise summary of the bug or feature request',
        },
        body: {
          type: 'string',
          description:
            'Issue body in markdown format. CRITICAL: Never include customer names, emails, org IDs, or any PII - GitHub issues are public. Use generic placeholders like [Customer] or [Organization]. For bugs, ALWAYS include the exact error message. Include anonymized steps to reproduce.',
        },
        repo: {
          type: 'string',
          description:
            'Repository name within adcontextprotocol org. Always use "adcp" - it contains the protocol, schemas, server, and docs. Default: "adcp"',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional labels to suggest (e.g., ["bug"], ["enhancement"], ["documentation"]). Common labels: bug, enhancement, documentation, good first issue',
        },
      },
      required: ['title', 'body'],
    },
  },

  // ============================================
  // INDUSTRY FEED PROPOSALS
  // ============================================
  {
    name: 'propose_news_source',
    description:
      'Propose a website or RSS feed as a news source for industry monitoring. Any community member can propose sources - admins will review and approve them. Use this when someone shares a link to a relevant ad-tech, marketing, or media publication and thinks it should be monitored for news. Check for duplicates before proposing.',
    usage_hints: 'use when user shares a news link and suggests it as a source, or asks to add a publication to monitoring',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the proposed news source (website or RSS feed URL)',
        },
        name: {
          type: 'string',
          description: 'Suggested name for the feed (e.g., "AdExchanger", "Marketing Week")',
        },
        reason: {
          type: 'string',
          description: 'Brief reason why this source is relevant to the community',
        },
        category: {
          type: 'string',
          enum: ['ad-tech', 'advertising', 'marketing', 'media', 'martech', 'ctv', 'dooh', 'creator', 'ai', 'sports', 'industry', 'research'],
          description: 'Category that best fits this publication',
        },
      },
      required: ['url'],
    },
  },

  // ============================================
  // MEMBER SEARCH / FIND HELP
  // ============================================
  {
    name: 'search_members',
    description:
      'Search for member organizations that can help with specific needs. Searches member names, descriptions, taglines, offerings, and tags using natural language. Use this when users ask about finding vendors, consultants, implementation partners, managed services, or anyone who can help them with AdCP adoption. Returns public member profiles with contact info.',
    usage_hints: 'use for "find someone to run a sales agent", "who can help me implement AdCP", "find a CTV partner", "looking for managed services", "need a consultant"',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What the user is looking for in natural language (e.g., "run a sales agent for me", "help implementing AdCP", "CTV advertising expertise", "managed services for publishers")',
        },
        offerings: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'publisher', 'consulting', 'managed_services', 'implementation', 'other'],
          },
          description: 'Optional: filter by specific service offerings',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 5, max 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'request_introduction',
    description:
      'Send an introduction email connecting a user with a member organization. Addie sends the email directly on behalf of the requester. Use this when a user explicitly asks to be introduced to or connected with a specific member after seeing search results.',
    usage_hints: 'use for "introduce me to X", "connect me with X", "I\'d like to talk to X", "can you put me in touch with X"',
    input_schema: {
      type: 'object',
      properties: {
        member_slug: {
          type: 'string',
          description: 'The slug (URL identifier) of the member to be introduced to',
        },
        requester_name: {
          type: 'string',
          description: 'Full name of the person requesting the introduction',
        },
        requester_email: {
          type: 'string',
          description: 'Email address of the person requesting the introduction',
        },
        requester_company: {
          type: 'string',
          description: 'Company/organization of the person requesting the introduction (optional)',
        },
        message: {
          type: 'string',
          description: 'Brief message from the requester explaining what they\'re looking for or why they want to connect',
        },
        search_query: {
          type: 'string',
          description: 'The original search query the user used to find this member (if applicable)',
        },
        reasoning: {
          type: 'string',
          description: 'Addie\'s explanation of why this member is a good fit for what the requester is looking for. Be specific about matching capabilities.',
        },
      },
      required: ['member_slug', 'requester_name', 'requester_email', 'message', 'reasoning'],
    },
  },
  {
    name: 'get_my_search_analytics',
    description:
      'Get search analytics for the user\'s member profile. Shows how many times their profile appeared in searches, profile clicks, and introduction requests. Only works for members with a public profile.',
    usage_hints: 'use for "how is my profile performing?", "how many people have seen my profile?", "search analytics", "introduction stats"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

/**
 * Base URL for internal API calls
 * Uses BASE_URL env var in production, falls back to localhost for development
 * Note: PORT takes precedence over CONDUCTOR_PORT for internal calls (inside Docker, PORT=8080)
 */
function getBaseUrl(): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  // PORT is the internal server port (8080 in Docker), CONDUCTOR_PORT is external mapping
  const port = process.env.PORT || process.env.CONDUCTOR_PORT || '3000';
  return `http://localhost:${port}`;
}

/**
 * Make an authenticated API call on behalf of a user
 */
async function callApi(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  memberContext: MemberContext | null,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path}`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add user context for authentication
    // The API will validate this against the session
    if (memberContext?.workos_user?.workos_user_id) {
      headers['X-Addie-User-Id'] = memberContext.workos_user.workos_user_id;
    }
    if (memberContext?.slack_user?.slack_user_id) {
      headers['X-Addie-Slack-User-Id'] = memberContext.slack_user.slack_user_id;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000), // Keep short for responsive UX
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorData = data as { error?: string };
      return {
        ok: false,
        status: response.status,
        error: errorData.error || `HTTP ${response.status}`,
      };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    logger.error({ error, url, method }, 'Addie: API call failed');
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Create tool handlers that are scoped to the current user
 */
export function createMemberToolHandlers(
  memberContext: MemberContext | null
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // ============================================
  // ADAGENTS.JSON VALIDATION
  // ============================================
  handlers.set('validate_adagents', async (input) => {
    const domain = input.domain as string;
    const validateCards = (input.validate_cards as boolean) || false;

    try {
      // Validate the domain's adagents.json
      const result = await adagentsManager.validateDomain(domain);

      let response = `## adagents.json Validation for ${result.domain}\n\n`;
      response += `**URL:** ${result.url}\n`;
      response += `**Status:** ${result.valid ? '✅ Valid' : '❌ Invalid'}\n`;

      if (result.status_code) {
        response += `**HTTP Status:** ${result.status_code}\n`;
      }

      if (result.errors.length > 0) {
        response += `\n### Errors\n`;
        result.errors.forEach((err) => {
          response += `- **${err.field}:** ${err.message}\n`;
        });
      }

      if (result.warnings.length > 0) {
        response += `\n### Warnings\n`;
        result.warnings.forEach((warn) => {
          response += `- **${warn.field}:** ${warn.message}`;
          if (warn.suggestion) {
            response += ` (${warn.suggestion})`;
          }
          response += `\n`;
        });
      }

      // Optionally validate agent cards
      if (validateCards && result.valid && result.raw_data?.authorized_agents) {
        response += `\n### Agent Card Validation\n`;
        const cardResults = await adagentsManager.validateAgentCards(
          result.raw_data.authorized_agents
        );

        cardResults.forEach((cardResult) => {
          const status = cardResult.valid ? '✅' : '❌';
          response += `\n**${status} ${cardResult.agent_url}**\n`;
          if (cardResult.response_time_ms) {
            response += `- Response time: ${cardResult.response_time_ms}ms\n`;
          }
          if (cardResult.errors.length > 0) {
            cardResult.errors.forEach((err) => {
              response += `- Error: ${err}\n`;
            });
          }
        });
      }

      if (result.valid) {
        response += `\n✅ The adagents.json file is valid and properly configured.`;
      } else {
        response += `\n\nNeed help fixing these issues? Check out the adagents.json builder at https://agenticadvertising.org/adagents or ask me for guidance on specific errors.`;
      }

      return response;
    } catch (error) {
      logger.error({ error, domain }, 'Addie: validate_adagents failed');
      return `Failed to validate adagents.json for ${domain}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  // ============================================
  // WORKING GROUPS
  // ============================================
  handlers.set('list_working_groups', async (input) => {
    // Apply limit with sensible defaults and max
    const requestedLimit = (input.limit as number) || 20;
    const limit = Math.min(Math.max(requestedLimit, 1), 50);

    // Build query params with optional type filter
    const typeFilter = input.type as string | undefined;
    const validTypes = ['working_group', 'council', 'chapter', 'all'];
    let queryParams = `limit=${limit}`;
    if (typeFilter && typeFilter !== 'all' && validTypes.includes(typeFilter)) {
      queryParams += `&type=${encodeURIComponent(typeFilter)}`;
    }

    const result = await callApi('GET', `/api/working-groups?${queryParams}`, memberContext);

    if (!result.ok) {
      return `Failed to fetch working groups: ${result.error}`;
    }

    const groups = result.data as Array<{
      slug: string;
      name: string;
      description: string;
      is_private: boolean;
      member_count: number;
      committee_type: string;
      region?: string;
    }>;

    if (groups.length === 0) {
      const typeLabel = typeFilter && typeFilter !== 'all' ? ` (type: ${typeFilter})` : '';
      return `No active committees found${typeLabel}.`;
    }

    // Determine title based on filter
    const typeLabels: Record<string, string> = {
      working_group: 'Working Groups',
      council: 'Industry Councils',
      chapter: 'Regional Chapters',
    };
    const title = typeFilter && typeFilter !== 'all' ? typeLabels[typeFilter] || 'Committees' : 'Committees';

    let response = `## AgenticAdvertising.org ${title}\n\n`;
    groups.forEach((group) => {
      const privacy = group.is_private ? '🔒 Private' : '🌐 Public';
      const typeLabel = group.committee_type !== 'working_group' ? ` [${group.committee_type.replace('_', ' ')}]` : '';
      const regionInfo = group.region ? ` 📍 ${group.region}` : '';
      response += `### ${group.name}${typeLabel}\n`;
      response += `**Slug:** ${group.slug} | **Members:** ${group.member_count} | ${privacy}${regionInfo}\n`;
      response += `${group.description || 'No description'}\n\n`;
    });

    return response;
  });

  handlers.set('get_working_group', async (input) => {
    const slug = input.slug as string;
    const result = await callApi('GET', `/api/working-groups/${slug}`, memberContext);

    if (!result.ok) {
      if (result.status === 404) {
        return `Working group "${slug}" not found. Use list_working_groups to see available groups.`;
      }
      return `Failed to fetch working group: ${result.error}`;
    }

    const group = result.data as {
      name: string;
      slug: string;
      description: string;
      is_private: boolean;
      member_count: number;
      leaders: Array<{ name: string; headline?: string }>;
      recent_posts?: Array<{ title: string; author: string; published_at: string }>;
    };

    let response = `## ${group.name}\n\n`;
    response += `**Slug:** ${group.slug}\n`;
    response += `**Members:** ${group.member_count}\n`;
    response += `**Access:** ${group.is_private ? '🔒 Private (invitation only)' : '🌐 Public (anyone can join)'}\n\n`;
    response += `${group.description || 'No description'}\n\n`;

    if (group.leaders && group.leaders.length > 0) {
      response += `### Leaders\n`;
      group.leaders.forEach((leader) => {
        response += `- **${leader.name}**${leader.headline ? ` - ${leader.headline}` : ''}\n`;
      });
      response += `\n`;
    }

    if (group.recent_posts && group.recent_posts.length > 0) {
      response += `### Recent Posts\n`;
      group.recent_posts.forEach((post) => {
        response += `- "${post.title}" by ${post.author}\n`;
      });
    }

    return response;
  });

  handlers.set('join_working_group', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to join a working group. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.slug as string;
    const result = await callApi('POST', `/api/working-groups/${slug}/join`, memberContext);

    if (!result.ok) {
      if (result.status === 403) {
        return `Cannot join "${slug}" - this is a private working group that requires an invitation.`;
      }
      if (result.status === 409) {
        return `You're already a member of the "${slug}" working group!`;
      }
      return `Failed to join working group: ${result.error}`;
    }

    return `✅ Successfully joined the "${slug}" working group! You can now participate in discussions and see group posts.`;
  });

  handlers.set('get_my_working_groups', async () => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to see your working groups. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const result = await callApi('GET', '/api/me/working-groups', memberContext);

    if (!result.ok) {
      return `Failed to fetch your working groups: ${result.error}`;
    }

    const memberships = result.data as Array<{
      working_group: { name: string; slug: string };
      role: string;
      joined_at: string;
    }>;

    if (memberships.length === 0) {
      return "You're not a member of any working groups yet. Use list_working_groups to find groups to join!";
    }

    let response = `## Your Working Group Memberships\n\n`;
    memberships.forEach((m) => {
      const role = m.role === 'leader' ? '👑 Leader' : '👤 Member';
      response += `- **${m.working_group.name}** (${m.working_group.slug}) - ${role}\n`;
    });

    return response;
  });

  // ============================================
  // MEMBER PROFILE
  // ============================================
  handlers.set('get_my_profile', async () => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to see your profile. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const result = await callApi('GET', '/api/me/member-profile', memberContext);

    if (!result.ok) {
      if (result.status === 404) {
        return "You don't have a member profile yet. Visit https://agenticadvertising.org/member-profile to create one!";
      }
      return `Failed to fetch your profile: ${result.error}`;
    }

    const profile = result.data as {
      name: string;
      slug: string;
      headline?: string;
      bio?: string;
      focus_areas?: string[];
      website?: string;
      linkedin?: string;
      location?: string;
      is_visible: boolean;
    };

    let response = `## Your Member Profile\n\n`;
    response += `**Name:** ${profile.name}\n`;
    response += `**Profile URL:** https://agenticadvertising.org/members/${profile.slug}\n`;
    response += `**Visibility:** ${profile.is_visible ? '🌐 Public' : '🔒 Hidden'}\n\n`;

    if (profile.headline) response += `**Headline:** ${profile.headline}\n`;
    if (profile.location) response += `**Location:** ${profile.location}\n`;
    if (profile.website) response += `**Website:** ${profile.website}\n`;
    if (profile.linkedin) response += `**LinkedIn:** ${profile.linkedin}\n`;

    if (profile.focus_areas && profile.focus_areas.length > 0) {
      response += `**Focus Areas:** ${profile.focus_areas.join(', ')}\n`;
    }

    if (profile.bio) {
      response += `\n### Bio\n${profile.bio}\n`;
    }

    return response;
  });

  handlers.set('update_my_profile', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to update your profile. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    // Only include fields that were provided
    const updates: Record<string, unknown> = {};
    if (input.headline !== undefined) updates.headline = input.headline;
    if (input.bio !== undefined) updates.bio = input.bio;
    if (input.focus_areas !== undefined) updates.focus_areas = input.focus_areas;
    if (input.website !== undefined) updates.website = input.website;
    if (input.linkedin !== undefined) updates.linkedin = input.linkedin;
    if (input.location !== undefined) updates.location = input.location;

    if (Object.keys(updates).length === 0) {
      return 'No fields to update. Provide at least one field (headline, bio, focus_areas, website, linkedin, or location).';
    }

    const result = await callApi('PUT', '/api/me/member-profile', memberContext, updates);

    if (!result.ok) {
      if (result.status === 404) {
        return "You don't have a member profile yet. Visit https://agenticadvertising.org/member-profile to create one first!";
      }
      return `Failed to update profile: ${result.error}`;
    }

    const updatedFields = Object.keys(updates).join(', ');
    return `✅ Profile updated successfully! Updated fields: ${updatedFields}\n\nView your profile at https://agenticadvertising.org/members/`;
  });

  // ============================================
  // PERSPECTIVES / POSTS
  // ============================================
  handlers.set('list_perspectives', async (input) => {
    const limit = (input.limit as number) || 10;
    const result = await callApi('GET', `/api/perspectives?limit=${limit}`, memberContext);

    if (!result.ok) {
      return `Failed to fetch perspectives: ${result.error}`;
    }

    const perspectives = result.data as Array<{
      title: string;
      slug: string;
      author_name: string;
      published_at: string;
      excerpt?: string;
    }>;

    if (perspectives.length === 0) {
      return 'No published perspectives found.';
    }

    let response = `## Recent Perspectives\n\n`;
    perspectives.forEach((p) => {
      response += `### ${p.title}\n`;
      response += `**By:** ${p.author_name} | **Published:** ${new Date(p.published_at).toLocaleDateString()}\n`;
      if (p.excerpt) response += `${p.excerpt}\n`;
      response += `**Read more:** https://agenticadvertising.org/perspectives/${p.slug}\n\n`;
    });

    return response;
  });

  handlers.set('create_working_group_post', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to create posts. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.working_group_slug as string;
    const title = input.title as string;
    const content = input.content as string;
    const postType = (input.post_type as string) || 'discussion';
    const linkUrl = input.link_url as string | undefined;

    const body: Record<string, unknown> = {
      title,
      content,
      post_type: postType,
    };

    if (postType === 'link' && linkUrl) {
      body.link_url = linkUrl;
    }

    const result = await callApi(
      'POST',
      `/api/working-groups/${slug}/posts`,
      memberContext,
      body
    );

    if (!result.ok) {
      if (result.status === 403) {
        return `You're not a member of the "${slug}" working group. Join it first using join_working_group.`;
      }
      return `Failed to create post: ${result.error}`;
    }

    return `✅ Post created successfully in the "${slug}" working group!\n\n**Title:** ${title}\n\nYour post is now visible to other working group members.`;
  });

  // ============================================
  // UNIFIED CONTENT MANAGEMENT
  // ============================================
  handlers.set('propose_content', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to create content. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const title = input.title as string;
    const contentBody = input.content as string | undefined;
    const contentType = (input.content_type as string) || 'article';
    const externalUrl = input.external_url as string | undefined;
    const excerpt = input.excerpt as string | undefined;
    const category = input.category as string | undefined;
    const collection = input.collection as { type: string; committee_slug?: string };
    const coAuthorEmails = input.co_author_emails as string[] | undefined;

    // Validate requirements
    if (contentType === 'article' && !contentBody) {
      return 'Content is required for article type. Please provide the content in markdown format.';
    }
    if (contentType === 'link' && !externalUrl) {
      return 'A URL is required for link type content. Please provide the external_url.';
    }
    if (collection.type === 'committee' && !collection.committee_slug) {
      return 'committee_slug is required when targeting a committee collection.';
    }

    // Build request body
    const body: Record<string, unknown> = {
      title,
      content: contentBody,
      content_type: contentType,
      external_url: externalUrl,
      excerpt,
      category,
      collection,
    };

    // Handle co-authors by looking up user IDs from emails
    if (coAuthorEmails && coAuthorEmails.length > 0) {
      // For now, co-authors are added via a separate call after content creation
      // We'll note them in the response
    }

    const result = await callApi('POST', '/api/content/propose', memberContext, body);

    if (!result.ok) {
      if (result.status === 404) {
        return `Committee "${collection.committee_slug}" not found. Use list_working_groups to see available committees.`;
      }
      return `Failed to create content: ${result.error}`;
    }

    const data = result.data as { id: string; slug: string; status: string; message: string };

    let response = `## Content ${data.status === 'published' ? 'Published' : 'Submitted'}\n\n`;
    response += `**Title:** ${title}\n`;
    response += `**Status:** ${data.status === 'published' ? '✅ Published' : '⏳ Pending Review'}\n`;

    if (collection.type === 'committee') {
      response += `**Collection:** ${collection.committee_slug}\n`;
    } else {
      response += `**Collection:** Personal (perspectives)\n`;
    }

    if (data.status === 'published') {
      if (collection.type === 'committee') {
        response += `\n**View:** https://agenticadvertising.org/committees/${collection.committee_slug}\n`;
      } else {
        response += `\n**View:** https://agenticadvertising.org/perspectives/${data.slug}\n`;
      }
    } else {
      response += `\n_A committee lead or admin will review your submission. You'll be notified when it's approved._\n`;
    }

    if (coAuthorEmails && coAuthorEmails.length > 0) {
      response += `\n💡 **Note:** To add co-authors, you can edit this content at: https://agenticadvertising.org/admin/content/${data.id}`;
    }

    return response;
  });

  handlers.set('get_my_content', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to see your content. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const status = input.status as string | undefined;
    const collection = input.collection as string | undefined;
    const relationship = input.relationship as string | undefined;

    // Build query string
    const params = new URLSearchParams();
    if (status && status !== 'all') params.set('status', status);
    if (collection) params.set('collection', collection);
    if (relationship) params.set('relationship', relationship);

    const queryString = params.toString() ? `?${params.toString()}` : '';
    const result = await callApi('GET', `/api/me/content${queryString}`, memberContext);

    if (!result.ok) {
      return `Failed to fetch your content: ${result.error}`;
    }

    const data = result.data as {
      items: Array<{
        id: string;
        slug: string;
        title: string;
        status: string;
        content_type: string;
        collection: { type: string; committee_name?: string; committee_slug?: string };
        relationships: string[];
        authors: Array<{ display_name: string }>;
        published_at?: string;
        created_at: string;
      }>;
    };

    if (data.items.length === 0) {
      let response = "You don't have any content yet.\n\n";
      response += 'Use `propose_content` to create your first article or perspective!';
      return response;
    }

    let response = `## Your Content\n\n`;

    // Group by status
    const byStatus: Record<string, typeof data.items> = {};
    for (const item of data.items) {
      if (!byStatus[item.status]) byStatus[item.status] = [];
      byStatus[item.status].push(item);
    }

    // Display order: pending_review first, then published, then others
    const statusOrder = ['pending_review', 'published', 'draft', 'rejected', 'archived'];
    const statusEmoji: Record<string, string> = {
      pending_review: '⏳',
      published: '✅',
      draft: '📝',
      rejected: '❌',
      archived: '📦',
    };
    const statusLabel: Record<string, string> = {
      pending_review: 'Pending Review',
      published: 'Published',
      draft: 'Drafts',
      rejected: 'Rejected',
      archived: 'Archived',
    };

    for (const statusKey of statusOrder) {
      const items = byStatus[statusKey];
      if (!items || items.length === 0) continue;

      response += `### ${statusEmoji[statusKey] || ''} ${statusLabel[statusKey] || statusKey} (${items.length})\n\n`;

      for (const item of items) {
        const collectionLabel = item.collection.type === 'committee'
          ? `📁 ${item.collection.committee_name || item.collection.committee_slug}`
          : '📁 Personal';
        const roleLabels = item.relationships.map(r => {
          if (r === 'author') return '✍️ Author';
          if (r === 'proposer') return '📤 Proposer';
          if (r === 'owner') return '👑 Owner';
          return r;
        }).join(' | ');

        response += `**${item.title}**\n`;
        response += `${collectionLabel} | ${roleLabels}\n`;
        if (item.authors.length > 1) {
          response += `_Co-authors: ${item.authors.map(a => a.display_name).join(', ')}_\n`;
        }
        if (item.published_at) {
          response += `_Published: ${new Date(item.published_at).toLocaleDateString()}_\n`;
        }
        response += `\n`;
      }
    }

    return response;
  });

  handlers.set('list_pending_content', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to see pending content. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const committeeSlug = input.committee_slug as string | undefined;
    const queryString = committeeSlug ? `?committee_slug=${encodeURIComponent(committeeSlug)}` : '';

    const result = await callApi('GET', `/api/content/pending${queryString}`, memberContext);

    if (!result.ok) {
      return `Failed to fetch pending content: ${result.error}`;
    }

    const data = result.data as {
      items: Array<{
        id: string;
        title: string;
        slug: string;
        excerpt?: string;
        content_type: string;
        proposer: { id: string; name: string };
        proposed_at: string;
        collection: { type: string; committee_name?: string; committee_slug?: string };
        authors: Array<{ display_name: string }>;
      }>;
      summary: {
        total: number;
        by_collection: Record<string, number>;
      };
    };

    if (data.items.length === 0) {
      return '✅ No pending content to review! All caught up.';
    }

    let response = `## Pending Content for Review\n\n`;
    response += `**Total:** ${data.summary.total} item(s)\n\n`;

    // Show breakdown by collection
    if (Object.keys(data.summary.by_collection).length > 1) {
      response += `**By collection:**\n`;
      for (const [col, count] of Object.entries(data.summary.by_collection)) {
        const label = col === 'personal' ? 'Personal perspectives' : col;
        response += `- ${label}: ${count}\n`;
      }
      response += `\n`;
    }

    for (const item of data.items) {
      const collectionLabel = item.collection.type === 'committee'
        ? `📁 ${item.collection.committee_name || item.collection.committee_slug}`
        : '📁 Personal';
      const proposedDate = new Date(item.proposed_at).toLocaleDateString();

      response += `---\n\n`;
      response += `### ${item.title}\n`;
      response += `**ID:** \`${item.id}\`\n`;
      response += `${collectionLabel} | Proposed by ${item.proposer.name} on ${proposedDate}\n`;
      if (item.excerpt) {
        response += `\n_${item.excerpt}_\n`;
      }
      response += `\n**Actions:** \`approve_content\` or \`reject_content\` with content_id: \`${item.id}\`\n\n`;
    }

    return response;
  });

  handlers.set('approve_content', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to approve content. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const contentId = input.content_id as string;
    const publishImmediately = input.publish_immediately !== false; // default true

    const result = await callApi(
      'POST',
      `/api/content/${contentId}/approve`,
      memberContext,
      { publish_immediately: publishImmediately }
    );

    if (!result.ok) {
      if (result.status === 403) {
        return 'Permission denied. Only committee leads and admins can approve content.';
      }
      if (result.status === 404) {
        return `Content not found with ID: ${contentId}`;
      }
      if (result.status === 400) {
        return `This content is not pending review. It may have already been processed.`;
      }
      return `Failed to approve content: ${result.error}`;
    }

    const data = result.data as { status: string; message: string };

    if (publishImmediately) {
      return `✅ Content approved and published! The author will be notified.`;
    } else {
      return `✅ Content approved and saved as draft. The author can publish when ready.`;
    }
  });

  handlers.set('reject_content', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to reject content. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const contentId = input.content_id as string;
    const reason = input.reason as string;

    if (!reason) {
      return 'A reason is required when rejecting content. This helps the author understand and improve.';
    }

    const result = await callApi(
      'POST',
      `/api/content/${contentId}/reject`,
      memberContext,
      { reason }
    );

    if (!result.ok) {
      if (result.status === 403) {
        return 'Permission denied. Only committee leads and admins can reject content.';
      }
      if (result.status === 404) {
        return `Content not found with ID: ${contentId}`;
      }
      if (result.status === 400) {
        return `This content is not pending review. It may have already been processed.`;
      }
      return `Failed to reject content: ${result.error}`;
    }

    return `❌ Content rejected. The author will see the following reason:\n\n> ${reason}\n\nThey can revise and resubmit if appropriate.`;
  });

  // ============================================
  // ACCOUNT LINKING
  // ============================================
  handlers.set('get_account_link', async () => {
    // Check if already linked/authenticated
    if (memberContext?.workos_user?.workos_user_id) {
      return '✅ Your account is already linked! You have full access to member features.';
    }

    // For Slack users, generate a link with their Slack ID for auto-linking
    if (memberContext?.slack_user?.slack_user_id) {
      const slackUserId = memberContext.slack_user.slack_user_id;
      const loginUrl = `https://agenticadvertising.org/auth/login?slack_user_id=${encodeURIComponent(slackUserId)}`;

      let response = `## Link Your Account\n\n`;
      response += `Click the link below to sign in to AgenticAdvertising.org and automatically link your Slack account:\n\n`;
      response += `**👉 ${loginUrl}**\n\n`;
      response += `After signing in:\n`;
      response += `- If you have an account, it will be linked to your Slack\n`;
      response += `- If you don't have an account, you can create one and it will be automatically linked\n\n`;
      response += `Once linked, you'll be able to use all member features directly from Slack!`;

      return response;
    }

    // For web users (anonymous), just provide the standard login URL
    const loginUrl = 'https://agenticadvertising.org/auth/login';
    let response = `## Sign In or Create an Account\n\n`;
    response += `To access member features, please sign in to AgenticAdvertising.org:\n\n`;
    response += `**👉 ${loginUrl}**\n\n`;
    response += `With an account, you can:\n`;
    response += `- Get personalized recommendations based on your interests\n`;
    response += `- Join working groups and participate in discussions\n`;
    response += `- Access member-only content and resources\n`;
    response += `- Manage your profile and email preferences`;

    return response;
  });

  // ============================================
  // AGENT TESTING & COMPLIANCE
  // ============================================
  handlers.set('check_agent_health', async (input) => {
    const agentUrl = input.agent_url as string;

    // Use the validate-cards endpoint which checks agent card + health
    const result = await callApi('POST', '/api/adagents/validate-cards', memberContext, {
      agent_urls: [agentUrl],
    });

    if (!result.ok) {
      return `Failed to check agent health: ${result.error}`;
    }

    const data = result.data as {
      agent_cards: Array<{
        agent_url: string;
        valid: boolean;
        errors: string[];
        status_code?: number;
        response_time_ms?: number;
        card_data?: {
          name?: string;
          description?: string;
          protocol?: string;
        };
        card_endpoint?: string;
      }>;
    };

    if (!data.agent_cards || data.agent_cards.length === 0) {
      return `No response received for agent ${agentUrl}`;
    }

    const card = data.agent_cards[0];
    let response = `## Agent Health Check: ${agentUrl}\n\n`;

    if (card.valid) {
      response += `**Status:** ✅ Online and responding\n`;
      if (card.response_time_ms) {
        response += `**Response Time:** ${card.response_time_ms}ms\n`;
      }
      if (card.card_data?.name) {
        response += `**Name:** ${card.card_data.name}\n`;
      }
      if (card.card_data?.description) {
        response += `**Description:** ${card.card_data.description}\n`;
      }
      if (card.card_data?.protocol) {
        response += `**Protocol:** ${card.card_data.protocol}\n`;
      }
      if (card.card_endpoint) {
        response += `**Card Endpoint:** ${card.card_endpoint}\n`;
      }
      response += `\n✅ This agent is properly configured and ready to use.`;
    } else {
      response += `**Status:** ❌ Not responding or invalid\n`;
      if (card.status_code) {
        response += `**HTTP Status:** ${card.status_code}\n`;
      }
      if (card.errors.length > 0) {
        response += `\n### Errors\n`;
        card.errors.forEach((err) => {
          response += `- ${err}\n`;
        });
      }
      response += `\n⚠️ This agent needs to be fixed before it can be used. Common issues:\n`;
      response += `- Agent endpoint not reachable\n`;
      response += `- Missing or invalid agent card at /.well-known/agent.json\n`;
      response += `- HTTPS not configured\n`;
    }

    return response;
  });

  handlers.set('check_publisher_authorization', async (input) => {
    const domain = input.domain as string;
    const agentUrl = input.agent_url as string;

    // Use the validate endpoint to check authorization
    const result = await callApi('POST', '/api/validate', memberContext, {
      domain,
      agent_url: agentUrl,
    });

    if (!result.ok) {
      return `Failed to check authorization: ${result.error}`;
    }

    const data = result.data as {
      authorized: boolean;
      domain: string;
      agent_url: string;
      checked_at: string;
      source?: string;
      error?: string;
    };

    let response = `## Authorization Check\n\n`;
    response += `**Publisher:** ${data.domain}\n`;
    response += `**Agent:** ${data.agent_url}\n\n`;

    if (data.authorized) {
      response += `✅ **Authorized!** This agent is authorized by ${data.domain}.\n`;
      if (data.source) {
        response += `\n**Source:** ${data.source}\n`;
      }
      response += `\nThe agent can access this publisher's inventory and serve ads.`;
    } else {
      response += `❌ **Not Authorized.** This agent is NOT listed in ${data.domain}'s adagents.json.\n`;
      if (data.error) {
        response += `\n**Reason:** ${data.error}\n`;
      }
      response += `\n### To Fix This\n`;
      response += `1. The publisher needs to add this agent to their adagents.json file\n`;
      response += `2. The file should be at: https://${data.domain}/.well-known/adagents.json\n`;
      response += `3. Use validate_adagents to check the publisher's current configuration\n`;
    }

    return response;
  });

  handlers.set('get_agent_capabilities', async (input) => {
    const agentUrl = input.agent_url as string;

    // URL encode the agent URL for the path
    const encodedUrl = encodeURIComponent(agentUrl);
    const result = await callApi('GET', `/api/registry/agents?url=${encodedUrl}&capabilities=true`, memberContext);

    if (!result.ok) {
      return `Failed to get agent capabilities: ${result.error}`;
    }

    const data = result.data as {
      agents: Array<{
        name: string;
        url: string;
        type: string;
        protocol: string;
        description?: string;
        capabilities?: {
          tools_count: number;
          tools: Array<{
            name: string;
            description?: string;
          }>;
          standard_operations?: string[];
        };
      }>;
    };

    if (!data.agents || data.agents.length === 0) {
      // Try direct capabilities endpoint if not in registry
      const directResult = await callApi('POST', '/api/adagents/validate-cards', memberContext, {
        agent_urls: [agentUrl],
      });

      if (!directResult.ok) {
        return `Agent not found in registry and couldn't fetch directly. The agent may not be publicly registered. Try check_agent_health first to verify the agent is online.`;
      }

      return `Agent ${agentUrl} is not in the public registry. Use check_agent_health to verify it's online, then check its documentation for available capabilities.`;
    }

    const agent = data.agents[0];
    let response = `## Agent Capabilities: ${agent.name || agentUrl}\n\n`;
    response += `**URL:** ${agent.url}\n`;
    response += `**Type:** ${agent.type}\n`;
    response += `**Protocol:** ${agent.protocol}\n`;
    if (agent.description) {
      response += `**Description:** ${agent.description}\n`;
    }

    if (agent.capabilities) {
      response += `\n### Available Tools (${agent.capabilities.tools_count})\n`;
      if (agent.capabilities.tools && agent.capabilities.tools.length > 0) {
        agent.capabilities.tools.forEach((tool) => {
          response += `\n**${tool.name}**\n`;
          if (tool.description) {
            response += `${tool.description}\n`;
          }
        });
      }

      if (agent.capabilities.standard_operations && agent.capabilities.standard_operations.length > 0) {
        response += `\n### Standard AdCP Operations\n`;
        agent.capabilities.standard_operations.forEach((op) => {
          response += `- ${op}\n`;
        });
      }
    } else {
      response += `\n_Capabilities not available. The agent may need to be contacted directly to discover its tools._\n`;
    }

    return response;
  });

  // ============================================
  // E2E AGENT TESTING
  // ============================================
  handlers.set('test_adcp_agent', async (input) => {
    const agentUrl = input.agent_url as string;
    const scenario = (input.scenario as TestScenario) || 'discovery';
    const brief = input.brief as string | undefined;
    const budget = input.budget as number | undefined;
    const dryRun = input.dry_run as boolean | undefined;
    const channels = input.channels as string[] | undefined;
    const pricingModels = input.pricing_models as string[] | undefined;
    const brandManifest = input.brand_manifest as TestOptions['brand_manifest'];
    let authToken = input.auth_token as string | undefined;

    // Look up saved token for organization
    let usingSavedToken = false;
    let usingPublicTestAgent = false;
    const organizationId = memberContext?.organization?.workos_organization_id;

    if (!authToken && organizationId) {
      try {
        const savedToken = await agentContextDb.getAuthTokenByOrgAndUrl(
          organizationId,
          agentUrl
        );
        if (savedToken) {
          authToken = savedToken;
          usingSavedToken = true;
          logger.info({ agentUrl }, 'Using saved auth token for agent test');
        }
      } catch (error) {
        // Non-fatal - continue without saved token
        logger.debug({ error, agentUrl }, 'Could not lookup saved token');
      }
    }

    // Auto-use public credentials for the public test agent.
    // Comes after saved token lookup so explicit user saves take precedence.
    if (!authToken && agentUrl.toLowerCase() === PUBLIC_TEST_AGENT.url.toLowerCase()) {
      authToken = PUBLIC_TEST_AGENT.token;
      usingPublicTestAgent = true;
      logger.info({ agentUrl }, 'Using public test agent credentials');
    }

    // Use a realistic default brand manifest that real sales agents will accept
    const defaultBrandManifest = {
      name: 'Nike',
      url: 'https://nike.com',
    };

    const options: TestOptions = {
      test_session_id: `addie-test-${Date.now()}`,
      dry_run: dryRun, // undefined means default to true
      brand_manifest: brandManifest || defaultBrandManifest,
    };
    if (brief) options.brief = brief;
    if (budget) options.budget = budget;
    if (channels) options.channels = channels;
    if (pricingModels) options.pricing_models = pricingModels;
    if (authToken) options.auth = { type: 'bearer', token: authToken };

    try {
      const result = await runAgentTests(agentUrl, scenario, options);

      // If user is authenticated and agent test succeeded, update the saved context
      if (organizationId) {
        try {
          const context = await agentContextDb.getByOrgAndUrl(
            organizationId,
            agentUrl
          );
          if (context && result.agent_profile) {
            // Update with discovered tools and test results
            const tools = result.agent_profile.tools || [];
            await agentContextDb.update(context.id, {
              tools_discovered: tools,
              agent_type: agentContextDb.inferAgentType(tools),
              last_test_scenario: scenario,
              last_test_passed: result.overall_passed,
              last_test_summary: result.summary,
            });

            // Record test history
            await agentContextDb.recordTest({
              agent_context_id: context.id,
              scenario,
              overall_passed: result.overall_passed,
              steps_passed: result.steps.filter((s) => s.passed).length,
              steps_failed: result.steps.filter((s) => !s.passed).length,
              total_duration_ms: result.total_duration_ms,
              summary: result.summary,
              dry_run: options.dry_run !== false,
              brief: options.brief,
              triggered_by: 'user',
              user_id: memberContext?.workos_user?.workos_user_id,
              steps_json: result.steps,
              agent_profile_json: result.agent_profile,
            });
          }
        } catch (error) {
          // Non-fatal - test still ran
          logger.debug({ error }, 'Could not update agent context after test');
        }
      }

      let output = formatTestResults(result);
      if (usingSavedToken) {
        output = `_Using saved credentials for this agent._\n\n` + output;
      } else if (usingPublicTestAgent) {
        output = `_Using public test agent credentials._\n\n` + output;
      }

      // If tests failed, offer to help file a GitHub issue
      const failedSteps = result.steps.filter((s) => !s.passed);
      if (failedSteps.length > 0) {
        // First, check if this looks like a bug in the @adcp/client testing library itself
        const clientLibraryBug = detectClientLibraryBug(failedSteps);
        if (clientLibraryBug) {
          logger.info(
            { agentUrl, repo: clientLibraryBug.repo, matchedError: clientLibraryBug.matchedError },
            'Detected known client library bug in test results'
          );
          output += `\n---\n\n`;
          output += `⚠️ **This looks like a bug in the testing library** (not the agent)\n\n`;
          output += `The error pattern suggests an issue in \`@adcp/client\`:\n`;
          output += `> ${clientLibraryBug.description}\n\n`;
          output += `Would you like me to draft a GitHub issue for \`adcontextprotocol/${clientLibraryBug.repo}\`?\n\n`;
          output += `Just say "yes, file an issue" and I'll create a pre-filled GitHub link for you.`;
        } else {
          // Check if this is a known open-source agent
          const openSourceInfo = getOpenSourceAgentInfo(agentUrl);
          if (openSourceInfo) {
            output += `\n---\n\n`;
            output += `💡 **This is an open-source agent** (${openSourceInfo.name})\n\n`;
            output += `Since ${failedSteps.length} test step(s) failed, would you like me to help you report this issue?\n`;
            output += `I can draft a GitHub issue for the \`${openSourceInfo.org}/${openSourceInfo.repo}\` repository with all the relevant details.\n\n`;
            output += `Just say "yes, file an issue" or "help me report this bug" and I'll create a pre-filled GitHub link for you.`;
          }
        }
      }

      return output;
    } catch (error) {
      logger.error({ error, agentUrl, scenario }, 'Addie: test_adcp_agent failed');
      return `Failed to test agent ${agentUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  // ============================================
  // GITHUB ISSUE DRAFTING
  // ============================================
  handlers.set('draft_github_issue', async (input) => {
    const title = input.title as string;
    const body = input.body as string;
    const repo = (input.repo as string) || 'adcp';
    const labels = (input.labels as string[]) || [];

    // GitHub organization
    const org = 'adcontextprotocol';

    // Build the pre-filled GitHub issue URL
    // GitHub supports: title, body, labels (comma-separated)
    const params = new URLSearchParams();
    params.set('title', title);
    params.set('body', body);
    if (labels.length > 0) {
      params.set('labels', labels.join(','));
    }

    const issueUrl = `https://github.com/${org}/${repo}/issues/new?${params.toString()}`;

    // Check URL length - browsers/GitHub have practical limits (~8000 chars)
    const urlLength = issueUrl.length;
    const URL_LENGTH_WARNING_THRESHOLD = 6000;
    const URL_LENGTH_MAX = 8000;

    // Build response with the draft details and link
    let response = `## GitHub Issue Draft\n\n`;

    if (urlLength > URL_LENGTH_MAX) {
      // URL too long - provide manual instructions instead
      response += `⚠️ **Issue body is too long for a pre-filled URL.**\n\n`;
      response += `Please create the issue manually:\n`;
      response += `1. Go to https://github.com/${org}/${repo}/issues/new\n`;
      response += `2. Copy the title and body from the preview below\n\n`;
    } else {
      response += `I've drafted a GitHub issue for you. Click the link below to create it:\n\n`;
      response += `**👉 [Create Issue on GitHub](${issueUrl})**\n\n`;

      if (urlLength > URL_LENGTH_WARNING_THRESHOLD) {
        response += `⚠️ _Note: The issue body is quite long. If the link doesn't work, you may need to shorten it or copy/paste manually._\n\n`;
      }
    }

    response += `---\n\n`;
    response += `### Preview\n\n`;
    response += `**Repository:** ${org}/${repo}\n`;
    response += `**Title:** ${title}\n`;
    if (labels.length > 0) {
      response += `**Labels:** ${labels.join(', ')}\n`;
    }
    response += `\n**Body:**\n\n${body}\n\n`;
    response += `---\n\n`;
    response += `_Note: You'll need to be signed in to GitHub to create the issue. Feel free to edit the title, body, or labels before submitting._`;

    return response;
  });

  // ============================================
  // AGENT CONTEXT MANAGEMENT
  // ============================================
  handlers.set('save_agent', async (input) => {
    // Require authenticated user with organization
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to save agents. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const saveOrgId = memberContext.organization?.workos_organization_id;
    if (!saveOrgId) {
      return 'Your account is not associated with an organization. Please contact support.';
    }

    const agentUrl = input.agent_url as string;
    const agentName = input.agent_name as string | undefined;
    const authToken = input.auth_token as string | undefined;
    const protocol = (input.protocol as 'mcp' | 'a2a') || 'mcp';

    try {
      // Check if agent already exists for this org
      let context = await agentContextDb.getByOrgAndUrl(saveOrgId, agentUrl);

      if (context) {
        // Update existing context
        if (agentName) {
          await agentContextDb.update(context.id, { agent_name: agentName, protocol });
        }
        if (authToken) {
          await agentContextDb.saveAuthToken(context.id, authToken);
        }
        // Refresh context
        context = await agentContextDb.getById(context.id);

        let response = `✅ Updated saved agent: **${context?.agent_name || agentUrl}**\n\n`;
        if (authToken) {
          response += `🔐 Auth token saved securely (hint: ${context?.auth_token_hint})\n`;
          response += `_The token is encrypted and will never be shown again._\n`;
        }
        return response;
      }

      // Create new context
      context = await agentContextDb.create({
        organization_id: saveOrgId,
        agent_url: agentUrl,
        agent_name: agentName,
        protocol,
        created_by: memberContext.workos_user.workos_user_id,
      });

      // Save auth token if provided
      if (authToken) {
        await agentContextDb.saveAuthToken(context.id, authToken);
        context = await agentContextDb.getById(context.id);
      }

      let response = `✅ Saved agent: **${context?.agent_name || agentUrl}**\n\n`;
      response += `**URL:** ${agentUrl}\n`;
      response += `**Protocol:** ${protocol.toUpperCase()}\n`;
      if (authToken) {
        response += `\n🔐 Auth token saved securely (hint: ${context?.auth_token_hint})\n`;
        response += `_The token is encrypted and will never be shown again._\n`;
      }
      response += `\nWhen you test this agent, I'll automatically use the saved credentials.`;

      return response;
    } catch (error) {
      logger.error({ error, agentUrl }, 'Addie: save_agent failed');
      return `Failed to save agent: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  handlers.set('list_saved_agents', async () => {
    // Require authenticated user with organization
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to list saved agents. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const listOrgId = memberContext.organization?.workos_organization_id;
    if (!listOrgId) {
      return 'Your account is not associated with an organization. Please contact support.';
    }

    try {
      const agents = await agentContextDb.getByOrganization(listOrgId);

      if (agents.length === 0) {
        return 'No agents saved yet. Use `save_agent` to save an agent URL for easy testing.';
      }

      let response = `## Your Saved Agents\n\n`;

      for (const agent of agents) {
        const name = agent.agent_name || 'Unnamed Agent';
        const type = agent.agent_type !== 'unknown' ? ` (${agent.agent_type})` : '';
        const hasToken = agent.has_auth_token ? `🔐 ${agent.auth_token_hint}` : '🔓 No token';

        response += `### ${name}${type}\n`;
        response += `**URL:** ${agent.agent_url}\n`;
        response += `**Protocol:** ${agent.protocol.toUpperCase()}\n`;
        response += `**Auth:** ${hasToken}\n`;

        if (agent.tools_discovered && agent.tools_discovered.length > 0) {
          response += `**Tools:** ${agent.tools_discovered.slice(0, 5).join(', ')}`;
          if (agent.tools_discovered.length > 5) {
            response += ` (+${agent.tools_discovered.length - 5} more)`;
          }
          response += `\n`;
        }

        if (agent.last_tested_at) {
          const lastTest = new Date(agent.last_tested_at).toLocaleDateString();
          const status = agent.last_test_passed ? '✅' : '❌';
          response += `**Last Test:** ${status} ${agent.last_test_scenario} (${lastTest})\n`;
          response += `**Total Tests:** ${agent.total_tests_run}\n`;
        }

        response += `\n`;
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Addie: list_saved_agents failed');
      return `Failed to list agents: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  handlers.set('remove_saved_agent', async (input) => {
    // Require authenticated user with organization
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to remove saved agents. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const removeOrgId = memberContext.organization?.workos_organization_id;
    if (!removeOrgId) {
      return 'Your account is not associated with an organization. Please contact support.';
    }

    const agentUrl = input.agent_url as string;

    try {
      // Find the agent
      const context = await agentContextDb.getByOrgAndUrl(removeOrgId, agentUrl);

      if (!context) {
        return `No saved agent found with URL: ${agentUrl}\n\nUse \`list_saved_agents\` to see your saved agents.`;
      }

      const agentName = context.agent_name || agentUrl;

      // Delete it
      await agentContextDb.delete(context.id);

      let response = `✅ Removed saved agent: **${agentName}**\n\n`;
      if (context.has_auth_token) {
        response += `🔐 The stored auth token has been permanently deleted.\n`;
      }
      response += `All test history for this agent has also been removed.`;

      return response;
    } catch (error) {
      logger.error({ error, agentUrl }, 'Addie: remove_saved_agent failed');
      return `Failed to remove agent: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  // ============================================
  // TEST AGENT SETUP (one-click)
  // ============================================
  handlers.set('setup_test_agent', async () => {
    // Require authenticated user with organization
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to set up the test agent. Please log in at https://agenticadvertising.org/dashboard first, then come back and try again.';
    }

    const setupOrgId = memberContext.organization?.workos_organization_id;
    if (!setupOrgId) {
      return 'Your account is not associated with an organization. Please contact support.';
    }

    try {
      // Check if already set up
      let context = await agentContextDb.getByOrgAndUrl(setupOrgId, PUBLIC_TEST_AGENT.url);

      if (context && context.has_auth_token) {
        return `✅ The test agent is already set up for your organization!\n\n**Agent:** ${PUBLIC_TEST_AGENT.name}\n**URL:** ${PUBLIC_TEST_AGENT.url}\n\nYou can now use \`test_adcp_agent\` to run tests against it.`;
      }

      if (context) {
        // Context exists but no token - add the token
        await agentContextDb.saveAuthToken(context.id, PUBLIC_TEST_AGENT.token);
      } else {
        // Create new context with token
        context = await agentContextDb.create({
          organization_id: setupOrgId,
          agent_url: PUBLIC_TEST_AGENT.url,
          agent_name: PUBLIC_TEST_AGENT.name,
          protocol: 'mcp',
          created_by: memberContext.workos_user.workos_user_id,
        });
        await agentContextDb.saveAuthToken(context.id, PUBLIC_TEST_AGENT.token);
      }

      let response = `✅ **Test agent is ready!**\n\n`;
      response += `**Agent:** ${PUBLIC_TEST_AGENT.name}\n`;
      response += `**URL:** ${PUBLIC_TEST_AGENT.url}\n\n`;
      response += `You can now:\n`;
      response += `- Run \`test_adcp_agent\` to run the full test suite\n`;
      response += `- Use different scenarios like \`discovery\`, \`pricing_models\`, or \`full_sales_flow\`\n\n`;
      response += `Would you like me to run a quick test now?`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Addie: setup_test_agent failed');
      return `Failed to set up test agent: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  // ============================================
  // INDUSTRY FEED PROPOSAL HANDLER
  // ============================================

  handlers.set('propose_news_source', async (input) => {
    const url = (input.url as string)?.trim();
    const name = input.name as string | undefined;
    const reason = input.reason as string | undefined;
    const category = input.category as string | undefined;

    if (!url) {
      return '❌ Please provide a URL for the proposed news source.';
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return `❌ Invalid URL: "${url}". Please provide a valid website or RSS feed URL.`;
    }

    try {
      // Check for existing feed or proposal
      const { existingFeed, existingProposal } = await findExistingProposalOrFeed(url);

      if (existingFeed) {
        const status = existingFeed.is_active ? '✅ active' : '⏸️ inactive';
        return `This source is already being monitored!\n\n**${existingFeed.name}** (${status})\n**URL:** ${existingFeed.feed_url}\n${existingFeed.category ? `**Category:** ${existingFeed.category}\n` : ''}`;
      }

      if (existingProposal) {
        return `This source has already been proposed and is pending review.\n\n**URL:** ${existingProposal.url}\n${existingProposal.name ? `**Suggested name:** ${existingProposal.name}\n` : ''}**Proposed:** ${existingProposal.proposed_at.toLocaleDateString()}`;
      }

      // Create the proposal
      const proposal = await createFeedProposal({
        url,
        name,
        reason,
        category,
        proposed_by_slack_user_id: memberContext?.slack_user?.slack_user_id,
        proposed_by_workos_user_id: memberContext?.workos_user?.workos_user_id,
      });

      let response = `✅ **News source proposed!**\n\n`;
      response += `**URL:** ${url}\n`;
      if (name) response += `**Suggested name:** ${name}\n`;
      if (category) response += `**Category:** ${category}\n`;
      if (reason) response += `**Reason:** ${reason}\n`;
      response += `\nAn admin will review this proposal and decide whether to add it to our monitored feeds. Thanks for the suggestion!`;

      logger.info({ proposalId: proposal.id, url, name }, 'Feed proposal created');
      return response;
    } catch (error) {
      logger.error({ error, url }, 'Error creating feed proposal');
      return '❌ Failed to submit the proposal. Please try again.';
    }
  });

  // ============================================
  // MEMBER SEARCH / FIND HELP
  // ============================================
  handlers.set('search_members', async (input) => {
    const searchQuery = input.query as string;
    const offeringsFilter = input.offerings as string[] | undefined;
    const requestedLimit = (input.limit as number) || 5;
    const limit = Math.min(Math.max(requestedLimit, 1), 10);

    // Generate a session ID for this search operation to correlate analytics
    const searchSessionId = uuidv4();

    try {
      // Search public member profiles
      // The MemberDatabase.listProfiles supports text search across name, tagline, description, tags
      const profiles = await memberDb.listProfiles({
        is_public: true,
        search: searchQuery,
        offerings: offeringsFilter as any,
        limit: limit + 5, // Get extra to allow for relevance filtering
      });

      if (profiles.length === 0) {
        let response = `No members found matching "${searchQuery}".\n\n`;
        response += `This could mean:\n`;
        response += `- No members have published profiles matching your needs yet\n`;
        response += `- Try broader search terms\n\n`;
        response += `You can also:\n`;
        response += `- Browse all members at https://agenticadvertising.org/members\n`;
        response += `- Ask me for general guidance on getting started with AdCP`;
        return response;
      }

      const displayProfiles = profiles.slice(0, limit);

      // Track search impressions for analytics (fire-and-forget)
      const searcherUserId = memberContext?.workos_user?.workos_user_id;
      memberSearchAnalyticsDb
        .recordSearchImpressionsBatch(
          displayProfiles.map((profile, index) => ({
            member_profile_id: profile.id,
            search_query: searchQuery,
            search_session_id: searchSessionId,
            searcher_user_id: searcherUserId,
            context: {
              position: index + 1,
              total_results: profiles.length,
              offerings_filter: offeringsFilter,
            },
          }))
        )
        .catch((err) => {
          logger.warn({ error: err, searchSessionId }, 'Failed to record search impressions');
        });

      // Return structured data that chat UI can render as cards
      // The format is: intro text + special JSON block + follow-up text
      const memberCards = displayProfiles.map((profile) => ({
        id: profile.id,
        slug: profile.slug,
        display_name: profile.display_name,
        tagline: profile.tagline || null,
        description: profile.description
          ? profile.description.length > 200
            ? profile.description.substring(0, 200) + '...'
            : profile.description
          : null,
        logo_url: profile.logo_url || profile.logo_light_url || null,
        offerings: profile.offerings || [],
        headquarters: profile.headquarters || null,
        contact_website: profile.contact_website || null,
      }));

      // Embed structured data in a special format the chat UI will recognize
      const structuredData = {
        type: 'member_search_results',
        query: searchQuery,
        search_session_id: searchSessionId,
        results: memberCards,
        total_found: profiles.length,
      };

      // Build response with intro, embedded data block, and follow-up
      let response = `Found ${displayProfiles.length} member${displayProfiles.length !== 1 ? 's' : ''} who can help:\n\n`;
      response += `<!--ADDIE_DATA:${JSON.stringify(structuredData)}:ADDIE_DATA-->\n\n`;

      if (profiles.length > limit) {
        response += `_Showing top ${limit} of ${profiles.length} results. [Browse all members](/members) for more options._\n\n`;
      }

      response += `Click on a card to see their full profile, or ask me to introduce you to someone.`;

      return response;
    } catch (error) {
      logger.error({ error, query: searchQuery }, 'Addie: search_members failed');
      return `Failed to search members: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  // ============================================
  // INTRODUCTION REQUESTS
  // ============================================
  handlers.set('request_introduction', async (input) => {
    const memberSlug = input.member_slug as string;
    const requesterName = input.requester_name as string;
    const requesterEmail = input.requester_email as string;
    const requesterCompany = input.requester_company as string | undefined;
    const message = input.message as string;
    const searchQuery = input.search_query as string | undefined;
    const reasoning = input.reasoning as string;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!requesterEmail || !emailRegex.test(requesterEmail)) {
      return 'Please provide a valid email address for the introduction request.';
    }

    try {
      // Get the member profile
      const profile = await memberDb.getProfileBySlug(memberSlug);
      if (!profile) {
        return `I couldn't find a member with the identifier "${memberSlug}". Please check the name and try again, or use search_members to find the right member.`;
      }

      if (!profile.is_public) {
        return `This member's profile is not currently public. They may not be accepting introductions at this time.`;
      }

      // Check if the member has a contact email
      if (!profile.contact_email) {
        let response = `**${profile.display_name}** doesn't have a contact email listed in their profile.\n\n`;
        if (profile.contact_website) {
          response += `You can reach them through their website: ${profile.contact_website}`;
        } else if (profile.linkedin_url) {
          response += `You can connect with them on LinkedIn: ${profile.linkedin_url}`;
        } else {
          response += `You may want to visit their profile page at https://agenticadvertising.org/members/${profile.slug} for more information.`;
        }
        return response;
      }

      // Record the introduction request for analytics
      const searcherUserId = memberContext?.workos_user?.workos_user_id;
      await memberSearchAnalyticsDb.recordIntroductionRequest({
        member_profile_id: profile.id,
        searcher_user_id: searcherUserId,
        searcher_email: requesterEmail,
        searcher_name: requesterName,
        searcher_company: requesterCompany,
        context: {
          message,
          search_query: searchQuery,
          reasoning,
        },
      });

      // Send the introduction email
      const emailResult = await sendIntroductionEmail({
        memberEmail: profile.contact_email,
        memberName: profile.display_name,
        memberSlug: profile.slug,
        requesterName,
        requesterEmail,
        requesterCompany,
        requesterMessage: message,
        searchQuery,
        addieReasoning: reasoning,
      });

      if (!emailResult.success) {
        // Email failed but we recorded the request - let user know to follow up manually
        logger.warn({ error: emailResult.error, memberSlug, requesterEmail }, 'Introduction email failed to send');
        let response = `I recorded your introduction request to **${profile.display_name}**, but there was an issue sending the email.\n\n`;
        response += `Please reach out to them directly at: **${profile.contact_email}**\n\n`;
        response += `Here's a suggested message:\n\n---\n\n`;
        response += `Hi ${profile.display_name.split(' ')[0] || 'there'},\n\n`;
        response += `I found your profile on AgenticAdvertising.org. ${message}\n\n`;
        response += `${requesterName}`;
        if (requesterCompany) response += `\n${requesterCompany}`;
        response += `\n${requesterEmail}\n\n---`;
        return response;
      }

      // Record that the email was sent
      await memberSearchAnalyticsDb.recordIntroductionSent({
        member_profile_id: profile.id,
        searcher_email: requesterEmail,
        searcher_name: requesterName,
        context: { email_id: emailResult.messageId },
      });

      logger.info(
        { memberSlug, requesterEmail, memberProfileId: profile.id, emailId: emailResult.messageId },
        'Introduction email sent'
      );

      // Build a nice confirmation message
      let response = `## Introduction Sent!\n\n`;
      response += `I've sent an introduction email to **${profile.display_name}** on your behalf.\n\n`;
      response += `**What happens next:**\n`;
      response += `- ${profile.display_name} will receive an email with your message and contact info\n`;
      response += `- When they reply, it will go directly to ${requesterEmail}\n`;
      response += `- The email explains why you're a good match for what you're looking for\n\n`;
      response += `Good luck with your conversation!`;

      return response;
    } catch (error) {
      logger.error({ error, memberSlug }, 'Addie: request_introduction failed');
      return `Failed to process introduction request: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  // ============================================
  // MEMBER SEARCH ANALYTICS
  // ============================================
  handlers.set('get_my_search_analytics', async () => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to see your search analytics. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const orgId = memberContext.organization?.workos_organization_id;
    if (!orgId) {
      return 'Your account is not associated with an organization. Please contact support.';
    }

    try {
      // Get the member profile for this organization
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) {
        return "You don't have a member profile yet. Visit https://agenticadvertising.org/member-profile to create one!";
      }

      if (!profile.is_public) {
        return "Your profile is not public yet. Make your profile public to appear in searches and see analytics.\n\nVisit https://agenticadvertising.org/member-profile to update your visibility settings.";
      }

      // Get analytics summary
      const analytics = await memberSearchAnalyticsDb.getAnalyticsSummary(profile.id);

      let response = `## Search Analytics for ${profile.display_name}\n\n`;

      // Summary stats
      response += `### Last 30 Days\n`;
      response += `- **Search impressions:** ${analytics.impressions_last_30_days}\n`;
      response += `- **Profile clicks:** ${analytics.clicks_last_30_days}\n`;
      response += `- **Introduction requests:** ${analytics.intro_requests_last_30_days}\n\n`;

      response += `### Last 7 Days\n`;
      response += `- **Search impressions:** ${analytics.impressions_last_7_days}\n`;
      response += `- **Profile clicks:** ${analytics.clicks_last_7_days}\n`;
      response += `- **Introduction requests:** ${analytics.intro_requests_last_7_days}\n\n`;

      response += `### All Time\n`;
      response += `- **Total impressions:** ${analytics.total_impressions}\n`;
      response += `- **Total clicks:** ${analytics.total_clicks}\n`;
      response += `- **Total introduction requests:** ${analytics.total_intro_requests}\n`;
      response += `- **Introductions sent:** ${analytics.total_intros_sent}\n\n`;

      // Conversion insights
      if (analytics.total_impressions > 0) {
        const clickRate = ((analytics.total_clicks / analytics.total_impressions) * 100).toFixed(1);
        response += `### Insights\n`;
        response += `- **Click-through rate:** ${clickRate}%\n`;
        if (analytics.total_clicks > 0) {
          const introRate = ((analytics.total_intro_requests / analytics.total_clicks) * 100).toFixed(1);
          response += `- **Introduction request rate:** ${introRate}% (of profile views)\n`;
        }
      }

      if (analytics.total_impressions === 0) {
        response += `\n💡 **Tip:** Your profile hasn't appeared in any searches yet. Make sure your description includes keywords that describe your services. Check your profile at https://agenticadvertising.org/member-profile`;
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Addie: get_my_search_analytics failed');
      return `Failed to fetch analytics: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  return handlers;
}
