/**
 * Addie Member Tools
 *
 * Tools that allow Addie to help users with:
 * - Viewing and updating their member profile
 * - Browsing and joining working groups
 * - Creating posts in working groups
 *
 * CRITICAL: All write operations are scoped to the authenticated user.
 * Addie can only modify data on behalf of the user she's talking to.
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { SlackDatabase } from '../../db/slack-db.js';
import {
  setAgentTesterLogger,
  comply,
  getBriefsByVertical,
  SAMPLE_BRIEFS,
  getAllPlatformTypes,
  getPlatformProfile,
  type ComplyOptions,
  type ComplianceTrack,
  type PlatformType,
} from '@adcp/client/testing';
import { AgentContextDatabase } from '../../db/agent-context-db.js';
import {
  findExistingProposalOrFeed,
  createFeedProposal,
  getPendingProposals,
} from '../../db/industry-feeds-db.js';
import { MemberDatabase } from '../../db/member-db.js';
import { getPool, query } from '../../db/client.js';
import { MemberSearchAnalyticsDatabase } from '../../db/member-search-analytics-db.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { checkMilestones } from '../services/journey-computation.js';
import { PERSONA_LABELS } from '../../config/personas.js';
import { getRecommendedGroupsForOrg, type GroupRecommendation } from '../services/group-recommendations.js';
import { sendIntroductionEmail } from '../../notifications/email.js';
import { v4 as uuidv4 } from 'uuid';
import * as relationshipDb from '../../db/relationship-db.js';
import * as personEvents from '../../db/person-events-db.js';

const memberDb = new MemberDatabase();
const agentContextDb = new AgentContextDatabase();
const memberSearchAnalyticsDb = new MemberSearchAnalyticsDatabase();
const orgDb = new OrganizationDatabase();
const wgDb = new WorkingGroupDatabase();
const slackDb = new SlackDatabase();

/**
 * Known open-source agents and their GitHub repositories.
 * Used to offer GitHub issue links when tests fail on these agents.
 * Keys must be lowercase (hostnames are case-insensitive).
 */
const KNOWN_OPEN_SOURCE_AGENTS: Record<string, { org: string; repo: string; name: string }> = {
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
 * See: https://docs.adcontextprotocol.org/docs/media-buy/advanced-topics/sandbox
 *
 * The token can be overridden via PUBLIC_TEST_AGENT_TOKEN env var if needed,
 * but defaults to the documented public token.
 */
const PUBLIC_TEST_AGENT = {
  url: process.env.PUBLIC_TEST_AGENT_URL || 'https://agenticadvertising.org/api/training-agent/mcp',
  token: process.env.PUBLIC_TEST_AGENT_TOKEN || '1v8tAhASaUYYp' + '4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ',
  name: 'AdCP Public Test Agent',
};

// Legacy URL for backward compatibility — redirect to the training agent
const LEGACY_TEST_AGENT_URL = 'https://test-agent.adcontextprotocol.org/mcp';

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

interface ResolvedAgentAuth {
  authToken?: string;
  authType: 'bearer' | 'basic';
  source: 'explicit' | 'saved' | 'oauth' | 'public' | 'none';
  resolvedUrl: string;
}

/**
 * Resolve auth credentials for an agent URL.
 * Checks: explicit token > saved token > OAuth token > public test agent.
 * Also handles legacy URL redirect.
 */
async function resolveAgentAuth(
  agentUrl: string,
  organizationId: string | undefined,
  explicitToken?: string,
): Promise<ResolvedAgentAuth> {
  let resolvedUrl = agentUrl;

  // Redirect legacy URL
  if (resolvedUrl.toLowerCase() === LEGACY_TEST_AGENT_URL.toLowerCase()) {
    resolvedUrl = PUBLIC_TEST_AGENT.url;
  }

  if (explicitToken) {
    return { authToken: explicitToken, authType: 'bearer', source: 'explicit', resolvedUrl };
  }

  if (organizationId) {
    // Check saved auth token
    try {
      const savedInfo = await agentContextDb.getAuthInfoByOrgAndUrl(organizationId, resolvedUrl);
      if (savedInfo) {
        return { authToken: savedInfo.token, authType: savedInfo.authType, source: 'saved', resolvedUrl };
      }
    } catch (error) {
      logger.debug({ error, agentUrl: resolvedUrl }, 'Could not lookup saved auth token');
    }

    // Check OAuth tokens
    try {
      const oauthTokens = await agentContextDb.getOAuthTokensByOrgAndUrl(organizationId, resolvedUrl);
      if (oauthTokens?.access_token) {
        const isExpired = oauthTokens.expires_at &&
          new Date(oauthTokens.expires_at).getTime() - Date.now() < 5 * 60 * 1000;
        if (!isExpired) {
          return { authToken: oauthTokens.access_token, authType: 'bearer', source: 'oauth', resolvedUrl };
        }
      }
    } catch (error) {
      logger.debug({ error, agentUrl: resolvedUrl }, 'Could not lookup OAuth token');
    }
  }

  // Public test agent auto-detection
  if (resolvedUrl.toLowerCase() === PUBLIC_TEST_AGENT.url.toLowerCase()) {
    return { authToken: PUBLIC_TEST_AGENT.token, authType: 'bearer', source: 'public', resolvedUrl };
  }

  return { authType: 'bearer', source: 'none', resolvedUrl };
}

/**
 * Validate an agent URL is well-formed.
 * Returns an error message if invalid, null if valid.
 */
function validateAgentUrl(agentUrl: string): string | null {
  try {
    new URL(agentUrl);
    return null;
  } catch {
    return 'Invalid agent URL format.';
  }
}

/**
 * Build auth options for the SDK from resolved auth.
 */
function buildAuthOption(resolved: ResolvedAgentAuth): { type: 'bearer'; token: string } | { type: 'basic'; username: string; password: string } | undefined {
  if (!resolved.authToken) return undefined;

  if (resolved.authType === 'basic') {
    const decoded = Buffer.from(resolved.authToken, 'base64').toString();
    const colonIndex = decoded.indexOf(':');
    if (colonIndex >= 0) {
      return { type: 'basic', username: decoded.slice(0, colonIndex), password: decoded.slice(colonIndex + 1) };
    }
  }

  return { type: 'bearer', token: resolved.authToken };
}

/**
 * Extract AdCP version from an agent card's extensions array.
 * Returns the version string if found and valid (e.g., "2.6.0"), undefined otherwise.
 */
export function extractAdcpVersion(extensions: unknown): string | undefined {
  if (!Array.isArray(extensions)) return undefined;
  const adcpExt = extensions.find((ext: { uri?: string }) => {
    if (!ext?.uri) return false;
    try {
      return new URL(ext.uri).hostname === 'adcontextprotocol.org';
    } catch {
      return false;
    }
  });
  const version = adcpExt?.params?.adcp_version;
  if (typeof version === 'string' && /^\d+\.\d+/.test(version)) {
    return version;
  }
  return undefined;
}

/**
 * Tool definitions for member-related operations
 */
export const MEMBER_TOOLS: AddieTool[] = [
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
        limit: { type: 'number', description: 'Max results (default 20)' },
        type: { type: 'string', enum: ['working_group', 'council', 'chapter', 'all'], description: 'Committee type filter' },
      },
      required: [],
    },
  },
  {
    name: 'get_working_group',
    description:
      'Get details about a specific working group including its description, leaders, member count, and recent posts. Use the group slug (URL-friendly name). Pass include_members: true to get the full member list with names, org, and email (admins only for private groups).',
    usage_hints: 'use for "tell me about X group", "who is in the Kitchen Cabinet", "list members of X committee/council/chapter"',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Working group slug' },
        include_members: { type: 'boolean', description: 'Return full member list with name, org, and email (default: false)' },
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
        slug: { type: 'string', description: 'Group slug to join' },
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
  // COUNCIL INTEREST (user-scoped)
  // ============================================
  {
    name: 'express_council_interest',
    description:
      'Express interest in joining an industry council or other committee that is not yet launched. The user can indicate whether they want to be a participant or a potential leader. This helps gauge interest before the council officially launches.',
    usage_hints: 'use when user wants to sign up for or show interest in a council',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Council slug' },
        interest_level: { type: 'string', enum: ['participant', 'leader'], description: 'Interest level (default: participant)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'withdraw_council_interest',
    description:
      'Withdraw interest in a council or committee. Use this when the user no longer wants to be notified when the council launches.',
    usage_hints: 'use when user wants to opt out or remove their interest from a council',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Council slug' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_my_council_interests',
    description:
      "Get the current user's council interest signups. Shows which councils they've expressed interest in joining.",
    usage_hints: 'use for "what councils am I interested in?", checking user\'s interest signups',
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
        headline: { type: 'string', description: 'Short headline/title' },
        bio: { type: 'string', description: 'Bio in markdown' },
        focus_areas: { type: 'array', items: { type: 'string' }, description: 'Areas of focus' },
        website: { type: 'string', description: 'Website URL' },
        linkedin: { type: 'string', description: 'LinkedIn URL' },
        location: { type: 'string', description: 'Location' },
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
        limit: { type: 'number', description: 'Max results (default 10)' },
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
        working_group_slug: { type: 'string', description: 'Working group slug' },
        title: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Content in markdown' },
        post_type: { type: 'string', enum: ['article', 'link', 'discussion'], description: 'Post type (default: discussion)' },
        link_url: { type: 'string', description: 'URL for link posts' },
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
      'Create content for the website. Content is published to a committee (working group, council, or chapter). Default is "editorial" which is the site-wide Perspectives section. Committee leads and admins can publish directly; others submit for review.',
    usage_hints: 'use for "write a perspective", "post to the sustainability group", "create an article", "share my thoughts on X"',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title' },
        content: { type: 'string', description: 'Content in markdown' },
        content_type: { type: 'string', enum: ['article', 'link'], description: 'Type (default: article)' },
        external_url: { type: 'string', description: 'URL for link type' },
        excerpt: { type: 'string', description: 'Short excerpt/summary' },
        category: { type: 'string', description: 'Category (e.g., Op-Ed, Interview, Ecosystem)' },
        committee_slug: { type: 'string', description: 'Target committee slug (default: editorial for Perspectives). Use list_working_groups to see options.' },
        co_author_emails: { type: 'array', items: { type: 'string' }, description: 'Co-author emails' },
      },
      required: ['title'],
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
        status: { type: 'string', enum: ['draft', 'pending_review', 'published', 'archived', 'rejected', 'all'], description: 'Filter by status' },
        collection: { type: 'string', description: 'Filter by collection' },
        relationship: { type: 'string', enum: ['author', 'proposer', 'owner'], description: 'Filter by relationship' },
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
        committee_slug: { type: 'string', description: 'Committee slug filter' },
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
        content_id: { type: 'string', description: 'Content ID' },
        publish_immediately: { type: 'boolean', description: 'Publish immediately (default: true)' },
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
        content_id: { type: 'string', description: 'Content ID' },
        reason: { type: 'string', description: 'Rejection reason' },
      },
      required: ['content_id', 'reason'],
    },
  },

  // ============================================
  // COMMITTEE DOCUMENTS
  // ============================================
  {
    name: 'add_committee_document',
    description:
      'Add a Google Docs document to a committee (working group, council, or chapter) for tracking. The document will be automatically indexed and summarized. Only committee leaders can add documents.',
    usage_hints: 'use when user wants to add a Google Doc to track for a committee',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        title: { type: 'string', description: 'Document title' },
        document_url: { type: 'string', description: 'Google Docs URL' },
        description: { type: 'string', description: 'Description' },
        is_featured: { type: 'boolean', description: 'Featured document (default: false)' },
      },
      required: ['committee_slug', 'title', 'document_url'],
    },
  },
  {
    name: 'list_committee_documents',
    description:
      'List documents tracked by a committee. Shows document titles, status, and summaries.',
    usage_hints: 'use for "what documents does X group have?", "show governance docs"',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
      },
      required: ['committee_slug'],
    },
  },
  {
    name: 'update_committee_document',
    description:
      'Update a document tracked by a committee. Can change title, description, URL, or featured status. Only committee leaders can update documents.',
    usage_hints: 'use when user wants to update/edit a tracked document',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        document_id: { type: 'string', description: 'Document ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        document_url: { type: 'string', description: 'New Google Docs URL' },
        is_featured: { type: 'boolean', description: 'Featured document' },
      },
      required: ['committee_slug', 'document_id'],
    },
  },
  {
    name: 'delete_committee_document',
    description:
      'Remove a document from a committee. The document will no longer be tracked or displayed. Only committee leaders can delete documents.',
    usage_hints: 'use when user wants to remove/delete a tracked document',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        document_id: { type: 'string', description: 'Document ID' },
      },
      required: ['committee_slug', 'document_id'],
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
    name: 'probe_adcp_agent',
    description:
      'Check if an AdCP agent is online and list its advertised capabilities. This only verifies connectivity (the agent responds to HTTP requests) - it does NOT verify the agent implements the protocol correctly. Use evaluate_agent_quality to verify actual protocol compliance.',
    usage_hints: 'use for "is this agent online?", "check connectivity", "what tools does this agent advertise?". For compliance testing, use evaluate_agent_quality instead.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The agent URL to probe' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'check_publisher_authorization',
    description:
      'Check if a publisher domain has authorized a specific agent.',
    usage_hints: 'use for authorization verification, "is my agent authorized?"',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Publisher domain' },
        agent_url: { type: 'string', description: 'Agent URL' },
      },
      required: ['domain', 'agent_url'],
    },
  },
  {
    name: 'test_adcp_agent',
    description:
      'Deprecated — use evaluate_agent_quality instead. Runs evaluate_agent_quality and returns the same results.',
    usage_hints: 'DEPRECATED: prefer evaluate_agent_quality for all agent testing. This tool exists for backward compatibility.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'evaluate_agent_quality',
    description:
      'Run protocol compliance evaluation on an AdCP agent and return structured results for coaching. Tests all capability tracks the agent supports (core, products, media buy, creative, governance, signals, etc.) and collects advisory observations about performance, completeness, and best practices. Results include specific actionable observations, not just pass/fail. The public test agent works for any logged-in user with no setup required. For custom agents requiring authentication, use save_agent first.',
    usage_hints: 'use for "test my agent", "run the full test suite", "how good is my agent?", "evaluate my agent quality", "what should I improve?", "coaching on my agent", "verify my sales agent works", "test against test-agent", "try the API". The public test agent works immediately for any logged-in user.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to evaluate' },
        tracks: { type: 'array', items: { type: 'string', enum: ['core', 'products', 'media_buy', 'creative', 'reporting', 'governance', 'signals', 'si', 'audiences'] }, description: 'Specific compliance tracks to run (default: all applicable)' },
        platform_type: { type: 'string', enum: ['display_ad_server', 'video_ad_server', 'social_platform', 'pmax_platform', 'dsp', 'retail_media', 'search_platform', 'audio_platform', 'creative_transformer', 'creative_library', 'creative_ad_server', 'si_platform', 'ai_ad_network', 'ai_platform', 'generative_dsp'], description: 'Declare the platform type for coherence checking — verifies the agent supports the tracks and tools expected for its platform category' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'compare_media_kit',
    description:
      'Compare a publisher\'s stated inventory (from their media kit or sample IO) against what their agent actually returns. Constructs briefs based on the publisher\'s verticals and channels, calls get_products, and identifies gaps — products, channels, formats, or buying modes the publisher sells but the agent doesn\'t expose. Extract the media_kit_summary from a PDF or description shared in conversation before calling this tool.',
    usage_hints: 'use when publisher shares a media kit, rate card, or sample IO and wants to see how their agent compares. Parse the document first, then call this tool with the structured summary.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to test against' },
        media_kit_summary: { type: 'string', description: 'Structured description of what the publisher sells (channels, formats, verticals, pricing tiers, audience capabilities)' },
        verticals: { type: 'array', items: { type: 'string' }, description: 'Verticals the publisher serves (e.g., automotive, healthcare, tech)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels from the media kit (e.g., display, video, podcast, audio, newsletter, dooh, ctv)' },
        formats: { type: 'array', items: { type: 'string' }, description: 'Specific format types offered' },
        platform_type: { type: 'string', enum: ['display_ad_server', 'video_ad_server', 'social_platform', 'pmax_platform', 'dsp', 'retail_media', 'search_platform', 'audio_platform', 'creative_transformer', 'creative_library', 'creative_ad_server', 'si_platform', 'ai_ad_network', 'ai_platform', 'generative_dsp'], description: 'Platform type for expected channel/tool context' },
        sample_io: { type: 'string', description: 'Text of a sample IO or RFP response for additional comparison' },
      },
      required: ['agent_url', 'media_kit_summary'],
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
        agent_url: { type: 'string', description: 'Agent URL' },
        agent_name: { type: 'string', description: 'Agent name' },
        auth_token: { type: 'string', description: 'Auth token (stored encrypted)' },
        auth_type: { type: 'string', enum: ['bearer', 'basic'], description: 'How the token is sent. "bearer" (default): sends Authorization: Bearer <token>. "basic": auth_token must be the base64-encoded "user:password" string, sent as Authorization: Basic <token>' },
        protocol: { type: 'string', enum: ['mcp', 'a2a'], description: 'Protocol (default: mcp)' },
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
        agent_url: { type: 'string', description: 'Agent URL' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'setup_test_agent',
    description:
      'Save the public AdCP test agent credentials for the user\'s organization so teammates can use them. Any logged-in user can already use the public test agent directly via evaluate_agent_quality without this step — no organization required. This is only needed for teams that want credentials stored.',
    usage_hints: 'use for "set up test agent for my team", "save test agent credentials". For "I want to try AdCP" or "test the API", prefer evaluate_agent_quality directly — it works immediately for any logged-in user. No organization or member profile required to try the test agent.',
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
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (no PII - GitHub is public)' },
        repo: { type: 'string', description: 'Repo name (default: "adcp")' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels' },
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
        url: { type: 'string', description: 'Source URL' },
        name: { type: 'string', description: 'Feed name' },
        reason: { type: 'string', description: 'Why this source is relevant' },
        category: { type: 'string', enum: ['ad-tech', 'advertising', 'marketing', 'media', 'martech', 'ctv', 'dooh', 'creator', 'ai', 'sports', 'industry', 'research'], description: 'Category' },
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
      'Search for member ORGANIZATIONS (companies) that offer specific capabilities or services. Searches member names, descriptions, taglines, offerings, and tags. Use this when users want to find vendors, consultants, implementation partners, or managed services. The query should reflect what the user actually needs (e.g., "CTV measurement", "sales agent implementation") — not a generic term like "partner". Returns public member profiles with contact info.',
    usage_hints: 'use for "find someone to run a sales agent", "who can help me implement AdCP", "find a CTV partner", "looking for managed services", "need a consultant". Do NOT use for finding individual people or contacts at specific companies.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the user is looking for — use their specific need (e.g., "CTV measurement partner", "sales agent implementation"). Never use "partner" alone as the query.' },
        offerings: { type: 'array', items: { type: 'string', enum: ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'si_agent', 'governance_agent', 'publisher', 'consulting', 'other'] }, description: 'Filter by offerings' },
        limit: { type: 'number', description: 'Max results (default 5)' },
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
        member_slug: { type: 'string', description: 'Member slug' },
        requester_name: { type: 'string', description: 'Requester name' },
        requester_email: { type: 'string', description: 'Requester email' },
        requester_company: { type: 'string', description: 'Requester company' },
        message: { type: 'string', description: 'Message to member' },
        search_query: { type: 'string', description: 'Original search query' },
        reasoning: { type: 'string', description: 'Why this member is a good fit' },
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
  {
    name: 'get_member_engagement',
    description:
      "Get the current user's organization engagement data: journey stage, engagement score, persona/archetype, milestone completion, and persona-based working group recommendations. Use this to understand where a member is in their journey and what actions would help them advance.",
    usage_hints: 'use when a member asks what to do next, asks about their progress or archetype, when you want to recommend working groups, or when you notice low engagement and want to suggest actions proactively',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_outreach_preference',
    description: `Set how often Addie sends proactive messages (tips, reminders, follow-ups). Choose a cadence or opt out entirely.`,
    usage_hints: 'use for "stop sending me messages", "unsubscribe from reminders", "opt out of outreach", "turn off notifications", "message me less", "only monthly"',
    input_schema: {
      type: 'object' as const,
      properties: {
        opt_out: {
          type: 'boolean',
          description: 'true to stop receiving proactive outreach entirely. Overrides cadence.',
        },
        cadence: {
          type: 'string',
          description: 'How often to receive proactive messages. Default = normal rules, monthly = once a month, quarterly = once every 3 months.',
          enum: ['default', 'monthly', 'quarterly'],
        },
      },
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

    // Add user context headers (for logging/tracking)
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
  memberContext: MemberContext | null,
  slackUserId?: string
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

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

    const data = result.data as { working_groups: Array<{
      slug: string;
      name: string;
      description: string;
      is_private: boolean;
      member_count: number;
      committee_type: string;
      region?: string;
    }> };
    const groups = data.working_groups;

    if (!groups || groups.length === 0) {
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
    const includeMembers = (input.include_members as boolean) === true;
    const result = await callApi('GET', `/api/working-groups/${slug}`, memberContext);

    if (!result.ok) {
      if (result.status === 404) {
        return `Working group "${slug}" not found. Use list_working_groups to see available groups.`;
      }
      return `Failed to fetch working group: ${result.error}`;
    }

    const data = result.data as { working_group: {
      name: string;
      slug: string;
      description: string;
      is_private: boolean;
      member_count: number;
      leaders?: Array<{ name?: string; user_id: string }>;
    }; is_member: boolean };
    const group = data.working_group;

    let response = `## ${group.name}\n\n`;
    response += `**Slug:** ${group.slug}\n`;
    response += `**Members:** ${group.member_count}\n`;
    response += `**Access:** ${group.is_private ? '🔒 Private (invitation only)' : '🌐 Public (anyone can join)'}\n\n`;
    response += `${group.description || 'No description'}\n\n`;

    if (group.leaders && group.leaders.length > 0) {
      response += `### Leaders\n`;
      group.leaders.forEach((leader) => {
        response += `- ${leader.name || 'Unknown'}\n`;
      });
      response += `\n`;
    }

    if (includeMembers) {
      // Check admin status — try WorkOS user ID first, then fall back to Slack user ID
      let isAdmin = false;
      const workosUserId = memberContext?.workos_user?.workos_user_id;
      const slackUserId = memberContext?.slack_user?.slack_user_id;
      const adminGroup = await wgDb.getWorkingGroupBySlug('aao-admin');
      if (adminGroup) {
        if (workosUserId) {
          isAdmin = await wgDb.isMember(adminGroup.id, workosUserId);
        } else if (slackUserId) {
          const mapping = await slackDb.getBySlackUserId(slackUserId);
          if (mapping?.workos_user_id) {
            isAdmin = await wgDb.isMember(adminGroup.id, mapping.workos_user_id);
          }
        }
      }

      if (group.is_private && !isAdmin) {
        response += `_Member list is only available to admins for private groups._\n`;
      } else {
        const pool = getPool();
        const membersResult = await pool.query<{
          user_name: string | null;
          user_email: string | null;
          user_org_name: string | null;
        }>(
          `SELECT wgm.user_name, wgm.user_email, wgm.user_org_name
           FROM working_group_memberships wgm
           JOIN working_groups wg ON wg.id = wgm.working_group_id
           WHERE wg.slug = $1 AND wgm.status = 'active'
           ORDER BY wgm.user_name ASC`,
          [slug]
        );

        response += `### Members\n`;
        if (membersResult.rows.length === 0) {
          response += `_No active members._\n`;
        } else {
          for (const member of membersResult.rows) {
            const name = member.user_name || member.user_email || 'Unknown';
            const org = member.user_org_name ? ` (${member.user_org_name})` : '';
            const email = member.user_email ? ` — ${member.user_email}` : '';
            response += `- ${name}${org}${email}\n`;
          }
        }
        response += `\n`;
      }
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

    const data = result.data as { working_groups: Array<{
      name: string;
      slug: string;
      committee_type: string;
      is_private: boolean;
    }> };
    const groups = data.working_groups;

    if (!groups || groups.length === 0) {
      return "You're not a member of any working groups yet. Use list_working_groups to find groups to join!";
    }

    let response = `## Your Working Group Memberships\n\n`;
    groups.forEach((group) => {
      const typeLabel = group.committee_type !== 'working_group' ? ` [${group.committee_type.replace('_', ' ')}]` : '';
      response += `- **${group.name}**${typeLabel} (${group.slug})\n`;
    });

    return response;
  });

  // ============================================
  // COUNCIL INTEREST
  // ============================================
  handlers.set('express_council_interest', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to express interest in a council. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.slug as string;
    const validInterestLevels = ['participant', 'leader'];
    const interestLevel = validInterestLevels.includes(input.interest_level as string)
      ? (input.interest_level as string)
      : 'participant';

    const result = await callApi('POST', `/api/working-groups/${slug}/interest`, memberContext, {
      interest_level: interestLevel,
    });

    if (!result.ok) {
      if (result.status === 404) {
        return `Could not find a council or committee with slug "${slug}". Use list_working_groups with type "council" to see available councils.`;
      }
      return `Failed to express interest: ${result.error}`;
    }

    const data = result.data as { message?: string };
    return data.message || `You've expressed interest! We'll notify you when this council launches.`;
  });

  handlers.set('withdraw_council_interest', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to withdraw interest. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.slug as string;

    const result = await callApi('DELETE', `/api/working-groups/${slug}/interest`, memberContext);

    if (!result.ok) {
      if (result.status === 404) {
        const data = result.data as { error?: string };
        if (data?.error === 'No interest found') {
          return `You haven't expressed interest in "${slug}". No action needed.`;
        }
        return `Could not find a council or committee with slug "${slug}".`;
      }
      return `Failed to withdraw interest: ${result.error}`;
    }

    const data = result.data as { message?: string };
    return data.message || `You've withdrawn your interest. You won't be notified when this council launches.`;
  });

  handlers.set('get_my_council_interests', async () => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to see your council interests. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const result = await callApi('GET', '/api/me/working-groups/interests', memberContext);

    if (!result.ok) {
      return `Failed to fetch your council interests: ${result.error}`;
    }

    const interests = result.data as Array<{
      committee_name: string;
      slug: string;
      interest_level: string;
      created_at: string;
    }>;

    if (interests.length === 0) {
      return "You haven't expressed interest in any councils yet. Use list_working_groups with type \"council\" to see available councils!";
    }

    let response = `## Your Council Interests\n\n`;
    interests.forEach((i) => {
      const level = i.interest_level === 'leader' ? '👑 Wants to Lead' : '👤 Participant';
      const date = new Date(i.created_at).toLocaleDateString();
      response += `- **${i.committee_name}** (${i.slug}) - ${level} - Signed up ${date}\n`;
    });

    response += `\nUse withdraw_council_interest to remove your interest from any council.`;

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

    const data = result.data as { profile: {
      name: string;
      slug: string;
      headline?: string;
      bio?: string;
      focus_areas?: string[];
      website?: string;
      linkedin?: string;
      location?: string;
      is_visible: boolean;
    } | null; organization_name?: string };

    if (!data.profile) {
      return "You don't have a member profile yet. Visit https://agenticadvertising.org/member-profile to create one!";
    }

    const profile = data.profile;

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
      external_url?: string;
    }>;

    if (perspectives.length === 0) {
      return 'No published perspectives found.';
    }

    let response = `## Recent Perspectives\n\n`;
    response += `_View all at: https://agenticadvertising.org/latest/perspectives_\n\n`;
    perspectives.forEach((p) => {
      response += `### ${p.title}\n`;
      response += `**By:** ${p.author_name} | **Published:** ${new Date(p.published_at).toLocaleDateString()}\n`;
      if (p.excerpt) response += `${p.excerpt}\n`;
      // Link content points to external URL, articles would be internal
      const readMoreUrl = p.external_url || `https://agenticadvertising.org/latest/perspectives`;
      response += `**Read more:** ${readMoreUrl}\n\n`;
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

    if (!title?.trim()) {
      return 'Title is required to create a post.';
    }

    // Generate post slug from title with timestamp for uniqueness
    const timestamp = Date.now().toString(36);
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
    const postSlug = baseSlug ? `${baseSlug}-${timestamp}` : timestamp;

    const body: Record<string, unknown> = {
      title,
      content,
      content_type: postType,
      post_slug: postSlug,
    };

    if (postType === 'link' && linkUrl) {
      body.external_url = linkUrl;
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
    const coAuthorEmails = input.co_author_emails as string[] | undefined;

    // Support both new format (committee_slug) and legacy format (collection.committee_slug)
    const legacyCollection = input.collection as { type?: string; committee_slug?: string } | undefined;

    // Validate legacy format: if type='committee', require committee_slug
    if (legacyCollection?.type === 'committee' && !legacyCollection.committee_slug) {
      return 'committee_slug is required when using collection.type="committee". Specify the committee or omit collection to default to editorial (Perspectives).';
    }

    const committeeSlug = (input.committee_slug as string) ||
      legacyCollection?.committee_slug ||
      (legacyCollection?.type === 'personal' ? 'editorial' : null) ||
      'editorial';

    // Validate requirements
    if (contentType === 'article' && !contentBody) {
      return 'Content is required for article type. Please provide the content in markdown format.';
    }
    if (contentType === 'link' && !externalUrl) {
      return 'A URL is required for link type content. Please provide the external_url.';
    }

    // Call the content service directly (bypasses HTTP auth)
    // Dynamic import to avoid pulling in auth.ts at module load time
    const { proposeContentForUser } = await import('../../routes/content.js');
    const result = await proposeContentForUser(
      {
        id: memberContext.workos_user.workos_user_id,
        email: memberContext.workos_user.email,
      },
      {
        title,
        content: contentBody,
        content_type: contentType as 'article' | 'link',
        external_url: externalUrl,
        excerpt,
        category,
        collection: { committee_slug: committeeSlug },
      }
    );

    if (!result.success) {
      if (result.error?.includes('No collection found')) {
        return `Committee "${committeeSlug}" not found. Use list_working_groups to see available committees.`;
      }
      return `Failed to create content: ${result.error}`;
    }

    let response = `## Content ${result.status === 'published' ? 'Published' : 'Submitted'}\n\n`;
    response += `**Title:** ${title}\n`;
    response += `**Status:** ${result.status === 'published' ? '✅ Published' : '⏳ Pending Review'}\n`;

    if (committeeSlug === 'editorial') {
      response += `**Collection:** Perspectives\n`;
    } else {
      response += `**Collection:** ${committeeSlug}\n`;
    }

    if (result.status === 'published') {
      if (committeeSlug === 'editorial') {
        response += `\n**View:** https://agenticadvertising.org/latest/perspectives\n`;
        response += `_Your perspective is now live in The Latest > Perspectives section._\n`;
      } else {
        response += `\n**View:** https://agenticadvertising.org/committees/${committeeSlug}\n`;
      }
    } else {
      if (committeeSlug === 'editorial') {
        response += `\n_Your perspective has been submitted for review. Once approved, it will appear in The Latest > Perspectives section._\n`;
      } else {
        response += `\n_Your content has been submitted for review. A committee lead will review it and you'll be notified when it's approved._\n`;
      }
    }

    if (coAuthorEmails && coAuthorEmails.length > 0) {
      response += `\n💡 **Note:** To add co-authors, you can edit this content at: https://agenticadvertising.org/admin/content/${result.id}`;
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
  // COMMITTEE DOCUMENTS
  // ============================================
  handlers.set('add_committee_document', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to add documents. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.committee_slug as string;
    const title = input.title as string;
    const documentUrl = input.document_url as string;
    const description = input.description as string | undefined;
    const isFeatured = input.is_featured as boolean | undefined;

    // Validate URL is a Google domain
    try {
      const url = new URL(documentUrl);
      const allowedDomains = ['docs.google.com', 'sheets.google.com', 'drive.google.com'];
      if (url.protocol !== 'https:' || !allowedDomains.includes(url.hostname)) {
        return `Invalid document URL. Only Google Docs, Sheets, and Drive URLs are supported (https://docs.google.com, sheets.google.com, or drive.google.com).`;
      }
    } catch {
      return 'Invalid URL format. Please provide a valid Google Docs URL.';
    }

    const result = await callApi(
      'POST',
      `/api/working-groups/${slug}/documents`,
      memberContext,
      {
        title,
        document_url: documentUrl,
        description,
        is_featured: isFeatured || false,
        document_type: documentUrl.includes('sheets.google.com') ? 'google_sheet' : 'google_doc',
      }
    );

    if (!result.ok) {
      if (result.status === 403) {
        return `You're not a leader of the "${slug}" committee. Only committee leaders can add documents.`;
      }
      if (result.status === 404) {
        return `Committee "${slug}" not found. Use list_working_groups to see available committees.`;
      }
      return `Failed to add document: ${result.error}`;
    }

    let response = `✅ Document added to "${slug}"!\n\n`;
    response += `**Title:** ${title}\n`;
    response += `**URL:** ${documentUrl}\n\n`;
    response += `The document will be automatically indexed and summarized within the hour. `;
    response += `You can view it at https://agenticadvertising.org/working-groups/${slug}`;

    return response;
  });

  handlers.set('list_committee_documents', async (input) => {
    const slug = input.committee_slug as string;

    const result = await callApi('GET', `/api/working-groups/${slug}/documents`, memberContext);

    if (!result.ok) {
      if (result.status === 404) {
        return `Committee "${slug}" not found. Use list_working_groups to see available committees.`;
      }
      return `Failed to list documents: ${result.error}`;
    }

    const data = result.data as { documents?: Array<{
      id: string;
      title: string;
      document_url: string;
      description?: string;
      document_summary?: string;
      index_status: string;
      is_featured: boolean;
      last_modified_at?: string;
    }> } | undefined;
    const documents = data?.documents || [];

    if (documents.length === 0) {
      return `No documents are being tracked for the "${slug}" committee yet.`;
    }

    let response = `## Documents for "${slug}"\n\n`;
    for (const doc of documents) {
      response += `### ${doc.title}${doc.is_featured ? ' ⭐' : ''}\n`;
      response += `**ID:** \`${doc.id}\`\n`;
      response += `**URL:** ${doc.document_url}\n`;
      response += `**Status:** ${doc.index_status}\n`;
      if (doc.document_summary) {
        response += `**Summary:** ${doc.document_summary}\n`;
      }
      if (doc.last_modified_at) {
        const date = new Date(doc.last_modified_at);
        response += `**Last updated:** ${date.toLocaleDateString()}\n`;
      }
      response += '\n';
    }

    return response;
  });

  handlers.set('update_committee_document', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to update documents. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.committee_slug as string;
    const documentId = input.document_id as string;
    const title = input.title as string | undefined;
    const description = input.description as string | undefined;
    const documentUrl = input.document_url as string | undefined;
    const isFeatured = input.is_featured as boolean | undefined;

    // Validate UUID format before API call
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(documentId)) {
      return 'Invalid document ID format. Use list_committee_documents to find valid document IDs.';
    }

    // Validate URL if provided
    if (documentUrl) {
      try {
        const url = new URL(documentUrl);
        const allowedDomains = ['docs.google.com', 'sheets.google.com', 'drive.google.com'];
        if (url.protocol !== 'https:' || !allowedDomains.includes(url.hostname)) {
          return `Invalid document URL. Only Google Docs, Sheets, and Drive URLs are supported (https://docs.google.com, sheets.google.com, or drive.google.com).`;
        }
      } catch {
        return 'Invalid URL format. Please provide a valid Google Docs URL.';
      }
    }

    // Build update payload with only provided fields
    const updateData: Record<string, unknown> = {};
    if (title !== undefined) updateData.title = title;
    if (description !== undefined) updateData.description = description;
    if (documentUrl !== undefined) {
      updateData.document_url = documentUrl;
      updateData.document_type = documentUrl.includes('sheets.google.com') ? 'google_sheet' : 'google_doc';
    }
    if (isFeatured !== undefined) updateData.is_featured = isFeatured;

    if (Object.keys(updateData).length === 0) {
      return 'No fields to update. Please provide at least one field to change (title, description, document_url, or is_featured).';
    }

    const result = await callApi(
      'PUT',
      `/api/working-groups/${slug}/documents/${documentId}`,
      memberContext,
      updateData
    );

    if (!result.ok) {
      if (result.status === 403) {
        return `You're not a leader of the "${slug}" committee. Only committee leaders can update documents.`;
      }
      if (result.status === 404) {
        return `Document not found. Either the committee "${slug}" doesn't exist or the document ID "${documentId}" is invalid.`;
      }
      return `Failed to update document: ${result.error}`;
    }

    const data = result.data as { document?: { title: string } } | undefined;
    const docTitle = data?.document?.title || title || 'Document';

    let response = `✅ Document updated!\n\n`;
    response += `**${docTitle}** has been updated in "${slug}".\n\n`;
    response += `View it at https://agenticadvertising.org/working-groups/${slug}`;

    return response;
  });

  handlers.set('delete_committee_document', async (input) => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to delete documents. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const slug = input.committee_slug as string;
    const documentId = input.document_id as string;

    // Validate UUID format before API call
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(documentId)) {
      return 'Invalid document ID format. Use list_committee_documents to find valid document IDs.';
    }

    const result = await callApi(
      'DELETE',
      `/api/working-groups/${slug}/documents/${documentId}`,
      memberContext
    );

    if (!result.ok) {
      if (result.status === 403) {
        return `You're not a leader of the "${slug}" committee. Only committee leaders can delete documents.`;
      }
      if (result.status === 404) {
        return `Document not found. Either the committee "${slug}" doesn't exist or the document ID "${documentId}" is invalid.`;
      }
      return `Failed to delete document: ${result.error}`;
    }

    return `✅ Document removed from "${slug}".\n\nThe document will no longer be tracked or displayed on the committee page.`;
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
  handlers.set('probe_adcp_agent', async (input) => {
    const agentUrl = input.agent_url as string;

    // Step 1: Health check (always do this first)
    const healthResult = await callApi('POST', '/api/adagents/validate-cards', memberContext, {
      agent_urls: [agentUrl],
    });

    if (!healthResult.ok) {
      return `## Agent Probe Failed\n\nUnable to probe agent at ${agentUrl}.\n\n**Error:** ${healthResult.error || 'Unknown error occurred while checking agent health.'}`;
    }

    const healthData = healthResult.data as {
      success: boolean;
      data: {
        agent_cards: Array<{
          agent_url: string;
          valid: boolean;
          errors?: string[];
          status_code?: number;
          response_time_ms?: number;
          card_data?: { name?: string; description?: string; protocol?: string; requires_auth?: boolean; extensions?: Array<{ uri?: string; params?: { adcp_version?: string } }> };
          card_endpoint?: string;
          oauth_required?: boolean;
        }>;
      };
    };

    const card = healthData?.data?.agent_cards?.[0];
    const isHealthy = card?.valid === true;
    const healthCheckRequiresOAuth = card?.oauth_required === true;

    // Step 2: Try capability discovery (non-blocking - show health status regardless of outcome)
    const encodedUrl = encodeURIComponent(agentUrl);
    const capResult = await callApi('GET', `/api/registry/agents?url=${encodedUrl}&capabilities=true`, memberContext);
    const capData = capResult.data as {
      agents: Array<{
        name: string;
        url: string;
        type: string;
        protocol: string;
        description?: string;
        capabilities?: {
          tools_count: number;
          tools: Array<{ name: string; description?: string }>;
          standard_operations?: string[];
          discovery_error?: string;
          oauth_required?: boolean;
        };
      }>;
    };
    const normalizedInput = agentUrl.replace(/\/$/, "");
    const agent = capData?.agents?.find((a) => a.url.replace(/\/$/, "") === normalizedInput);

    // Step 2.5: Check if OAuth is required (from either health check or capabilities discovery)
    const requiresOAuth = healthCheckRequiresOAuth || agent?.capabilities?.oauth_required;
    if (requiresOAuth) {
      const organizationId = memberContext?.organization?.workos_organization_id;
      if (organizationId) {
        try {
          // Get or create agent context for OAuth flow
          const baseUrl = new URL(agentUrl);
          let agentContext = await agentContextDb.getByOrgAndUrl(organizationId, agentUrl);
          if (!agentContext) {
            agentContext = await agentContextDb.create({
              organization_id: organizationId,
              agent_url: agentUrl,
              agent_name: agent?.name || baseUrl.hostname,
              protocol: (agent?.protocol as 'mcp' | 'a2a') || 'mcp',
            });
          }

          const authParams = new URLSearchParams({
            agent_context_id: agentContext.id,
          });
          const authUrl = `${getBaseUrl()}/api/oauth/agent/start?${authParams.toString()}`;

          let response = `## Agent Probe: ${agent?.name || agentUrl}\n\n`;
          response += `### Connectivity\n`;
          response += `**Status:** 🔒 Requires Authentication\n\n`;
          response += `This agent requires OAuth authorization before you can access it.\n\n`;
          response += `**[Click here to authorize this agent](${authUrl})**\n\n`;
          response += `After you authorize, try probing again to see the agent's capabilities.`;
          return response;
        } catch (oauthError) {
          logger.debug({ error: oauthError, agentUrl }, 'Failed to set up OAuth flow for probe');
        }
      } else {
        // User not logged in or no organization
        let response = `## Agent Probe: ${agent?.name || agentUrl}\n\n`;
        response += `### Connectivity\n`;
        response += `**Status:** 🔒 Requires Authentication\n\n`;
        response += `This agent requires OAuth authorization. Please sign in to an organization account to authorize and access this agent.`;
        return response;
      }
    }

    // Step 3: Extract AdCP version from agent card extensions
    const adcpVersion = extractAdcpVersion(card?.card_data?.extensions);

    // Step 4: Format unified response
    let response = `## Agent Probe: ${agent?.name || agentUrl}\n\n`;

    // Health section
    response += `### Connectivity\n`;
    if (isHealthy) {
      response += `**Status:** ✅ Online\n`;
      if (card.response_time_ms) {
        response += `**Response Time:** ${card.response_time_ms}ms\n`;
      }
      if (card.card_data?.protocol) {
        response += `**Protocol:** ${card.card_data.protocol}\n`;
      }
    } else {
      response += `**Status:** ❌ Unreachable\n`;
      if ((card?.errors?.length ?? 0) > 0) {
        response += `**Error:** ${card?.errors?.[0]}\n`;
      } else if (card?.status_code) {
        response += `**HTTP Status:** ${card.status_code}\n`;
      }
    }

    // AdCP version section
    if (adcpVersion) {
      response += `**AdCP Version:** ${adcpVersion}\n`;
      const majorVersion = parseInt(adcpVersion.split('.')[0], 10);
      if (majorVersion < 3) {
        response += `\n> ⚠️ **Version notice:** This agent implements AdCP v${adcpVersion}, which is a v2 specification. The current version is AdCP 3.0. We recommend upgrading to v3 for full compatibility with the latest protocol features. See [what's new in AdCP 3.0](https://adcontextprotocol.org/docs/reference/whats-new-in-v3) for details.\n`;
      }
    }

    // Capabilities section
    response += `\n### Capabilities\n`;
    if (agent?.capabilities?.tools && agent.capabilities.tools.length > 0) {
      if (!isHealthy) {
        response += `> ⚠️ **Warning:** Agent is currently unreachable. Showing cached capabilities.\n\n`;
      }
      response += `**Tools Available:** ${agent.capabilities.tools_count}\n\n`;
      agent.capabilities.tools.forEach((tool) => {
        response += `- **${tool.name}**`;
        if (tool.description) {
          response += `: ${tool.description}`;
        }
        response += `\n`;
      });

      if (agent.capabilities.standard_operations && agent.capabilities.standard_operations.length > 0) {
        response += `\n**Standard Operations:** ${agent.capabilities.standard_operations.join(', ')}\n`;
      }
    } else if (!isHealthy) {
      response += `No cached capabilities available. Agent must be online to discover tools.\n`;
    } else {
      response += `Agent is online but capabilities could not be discovered. It may not be in the public registry.\n`;
    }

    // Summary
    response += `\n---\n`;
    if (isHealthy && (agent?.capabilities?.tools?.length ?? 0) > 0) {
      response += `✅ Agent is **online** and responding. Run \`evaluate_agent_quality\` to verify protocol compliance.`;
    } else if (isHealthy) {
      response += `✅ Agent is **online** but not in the registry. Try calling it with \`get_products\` or run \`evaluate_agent_quality\` to verify it works correctly.`;
    } else {
      response += `❌ Agent is **not responding**. Check the URL and ensure the agent is running.`;
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

  // ============================================
  // E2E AGENT TESTING
  // ============================================
  // test_adcp_agent delegates to evaluate_agent_quality
  handlers.set('test_adcp_agent', async (input) => {
    const evaluateHandler = handlers.get('evaluate_agent_quality')!;
    return evaluateHandler(input);
  });

  // ============================================
  // AGENT QUALITY COACHING
  // ============================================

  handlers.set('evaluate_agent_quality', async (input) => {
    const agentUrl = input.agent_url as string;
    const tracks = input.tracks as ComplianceTrack[] | undefined;
    const platformType = input.platform_type as PlatformType | undefined;

    const urlError = validateAgentUrl(agentUrl);
    if (urlError) return `**Error:** ${urlError}`;

    const organizationId = memberContext?.organization?.workos_organization_id;
    const resolved = await resolveAgentAuth(agentUrl, organizationId);

    const complyOptions: ComplyOptions = {
      test_session_id: `quality-eval-${Date.now()}`,
      dry_run: true,
      auth: buildAuthOption(resolved),
    };
    if (tracks) complyOptions.tracks = tracks;
    if (platformType) complyOptions.platform_type = platformType;

    try {
      const result = await comply(resolved.resolvedUrl, complyOptions);

      // Record result if the user has an org with this agent saved
      if (organizationId) {
        try {
          const context = await agentContextDb.getByOrgAndUrl(organizationId, resolved.resolvedUrl);
          if (context) {
            await agentContextDb.recordTest({
              agent_context_id: context.id,
              scenario: 'quality_evaluation',
              overall_passed: result.summary.tracks_failed === 0,
              steps_passed: result.summary.tracks_passed,
              steps_failed: result.summary.tracks_failed,
              total_duration_ms: result.total_duration_ms,
              summary: result.summary.headline,
              dry_run: true,
              triggered_by: 'user',
              user_id: memberContext?.workos_user?.workos_user_id,
              agent_profile_json: result.agent_profile,
            });
          }
        } catch (error) {
          logger.debug({ error }, 'Could not record quality evaluation result');
        }
      }

      // Build structured output for Addie to interpret
      let output = '';
      if (resolved.source === 'saved') output += '_Using saved credentials._\n\n';
      else if (resolved.source === 'oauth') output += '_Using saved OAuth credentials._\n\n';
      else if (resolved.source === 'public') output += '_Using public test agent credentials._\n\n';

      output += `## Quality Evaluation: ${result.agent_profile.name || resolved.resolvedUrl}\n\n`;
      output += `**Agent:** ${resolved.resolvedUrl}\n`;
      output += `**Tools:** ${result.agent_profile.tools.length} (${result.agent_profile.tools.join(', ')})\n`;
      output += `**Duration:** ${(result.total_duration_ms / 1000).toFixed(1)}s\n\n`;

      output += `### Capability Tracks\n\n`;
      output += `**Summary:** ${result.summary.headline}\n\n`;

      const statusLabel: Record<string, string> = { pass: 'PASS', fail: 'FAIL', partial: 'PARTIAL', skip: 'SKIP', expected: 'EXPECTED' };
      for (const track of result.tracks) {
        const status = statusLabel[track.status] ?? track.status.toUpperCase();
        const scenarioCount = track.scenarios.length;
        const passedCount = track.scenarios.filter(s => s.overall_passed).length;

        if (track.status === 'skip') {
          output += `- **${track.label}** [${status}] — not applicable\n`;
        } else if (track.status === 'expected') {
          output += `- **${track.label}** [${status}] — expected for this platform type but not yet implemented\n`;
        } else {
          output += `- **${track.label}** [${status}] — ${passedCount}/${scenarioCount} scenarios pass (${(track.duration_ms / 1000).toFixed(1)}s)\n`;
          for (const scenario of track.scenarios) {
            if (!scenario.overall_passed) {
              output += `  - FAILED: ${scenario.scenario}\n`;
              const failedSteps = (scenario.steps ?? []).filter(s => !s.passed);
              for (const step of failedSteps.slice(0, 3)) {
                output += `    - ${step.step}${step.error ? `: ${step.error}` : ''}\n`;
              }
              if (failedSteps.length > 3) {
                output += `    - ... and ${failedSteps.length - 3} more\n`;
              }
            }
          }
        }
      }

      // Platform coherence section (only when platform_type was provided)
      if (result.platform_coherence) {
        const pc = result.platform_coherence;
        output += `\n### Platform Coherence: ${pc.label}\n\n`;
        output += `**Coherent:** ${pc.coherent ? 'yes' : 'no'}\n`;
        output += `**Expected tracks:** ${pc.expected_tracks.join(', ')}\n`;
        if (pc.missing_tracks.length > 0) {
          output += `**Missing tracks:** ${pc.missing_tracks.join(', ')}\n`;
        }
        if (pc.findings.length > 0) {
          output += `\n**Findings:**\n`;
          for (const finding of pc.findings) {
            const sev = finding.severity.toUpperCase();
            output += `- [${sev}] Expected: ${finding.expected} | Actual: ${finding.actual}\n`;
            output += `  → ${finding.guidance}\n`;
          }
        }
        output += '\n';
      }

      if (result.observations.length > 0) {
        output += `\n### Advisory Observations\n\n`;
        for (const obs of result.observations) {
          const severity = obs.severity === 'error' ? 'ERROR' : obs.severity === 'warning' ? 'WARNING' : obs.severity === 'suggestion' ? 'SUGGESTION' : 'INFO';
          output += `- [${severity}] (${obs.category}) ${obs.message}\n`;
          if (obs.evidence) {
            output += `  Evidence: ${JSON.stringify(obs.evidence).slice(0, 500)}\n`;
          }
        }
      }

      output += `\nInterpret these results conversationally. Highlight what's working well, identify the most impactful gaps, and suggest concrete next steps.${platformType ? ` Consider the platform coherence findings — missing tracks or capabilities that are expected for a ${platformType} are high-priority gaps.` : ''}`;

      return output;
    } catch (error) {
      logger.error({ error, agentUrl: resolved.resolvedUrl }, 'Addie: evaluate_agent_quality failed');
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('authentication')) {
        return `Agent at ${resolved.resolvedUrl} requires authentication. Use \`save_agent\` to store credentials first, then try again.`;
      }
      return `Failed to evaluate agent quality for ${resolved.resolvedUrl}: ${msg}`;
    }
  });

  handlers.set('compare_media_kit', async (input) => {
    const agentUrl = input.agent_url as string;
    const mediaKitSummary = (input.media_kit_summary as string).slice(0, 5000);
    const verticals = input.verticals as string[] | undefined;
    const channels = (input.channels as string[] | undefined)?.slice(0, 20);
    const formats = (input.formats as string[] | undefined)?.slice(0, 20);
    const platformType = input.platform_type as PlatformType | undefined;
    const sampleIo = input.sample_io as string | undefined;

    const urlError = validateAgentUrl(agentUrl);
    if (urlError) return `**Error:** ${urlError}`;

    const organizationId = memberContext?.organization?.workos_organization_id;
    const resolved = await resolveAgentAuth(agentUrl, organizationId);

    // Build briefs: prefer curated sample briefs from the library, fall back to generated
    const effectiveVerticals = verticals?.length ? verticals : ['general'];
    const effectiveChannels = channels?.length ? channels : [];
    const briefsToRun: Array<{ name: string; brief: string; vertical: string }> = [];

    for (const vertical of effectiveVerticals.slice(0, 5)) {
      // Try to find a curated sample brief for this vertical
      const sampleBriefs = getBriefsByVertical(vertical);
      if (sampleBriefs.length > 0) {
        // Use the first matching sample brief — it has realistic budget context and evaluation hints
        const sample = sampleBriefs[0];
        briefsToRun.push({ name: sample.name, brief: sample.brief, vertical });
      } else {
        // No curated brief for this vertical — construct one from media kit context
        let briefText = `Brand looking for advertising opportunities in the ${vertical} vertical.`;
        if (effectiveChannels.length > 0) {
          briefText += ` Interested in: ${effectiveChannels.join(', ')}.`;
        }
        if (formats?.length) {
          briefText += ` Preferred formats: ${formats.join(', ')}.`;
        }
        briefText += ` Budget: $100,000 over 4 weeks.`;
        briefsToRun.push({ name: `${vertical} brief`, brief: briefText, vertical });
      }
    }

    if (sampleIo) {
      briefsToRun.push({
        name: 'Sample IO comparison',
        brief: `Based on this previous IO/RFP response, find matching products:\n\n<user_provided_io>\n${sampleIo.slice(0, 2000)}\n</user_provided_io>`,
        vertical: 'io_comparison',
      });
    }

    if (briefsToRun.length === 0) {
      return 'No briefs could be constructed from the media kit summary. Provide at least one vertical or channel.';
    }

    // Get platform profile for expected channels/tools context
    const platformProfile = platformType ? getPlatformProfile(platformType) : undefined;

    try {
      const { AdCPClient } = await import('@adcp/client');

      const agentConfig = {
        id: 'target',
        name: 'target',
        agent_uri: resolved.resolvedUrl,
        protocol: 'mcp' as const,
        ...(resolved.authToken && resolved.authType === 'basic'
          ? { headers: { 'Authorization': `Basic ${resolved.authToken}` } }
          : resolved.authToken ? { auth_token: resolved.authToken } : {}),
      };

      const multiClient = new AdCPClient([agentConfig], { debug: false });
      const client = multiClient.agent('target');

      // Run each brief and collect results
      interface BriefResult {
        name: string;
        vertical: string;
        products_count: number;
        channels_found: string[];
        formats_found: string[];
        pricing_models_found: string[];
        has_audience_targeting: boolean;
        error?: string;
      }
      const briefResults: BriefResult[] = await Promise.all(briefsToRun.map(async (brief): Promise<BriefResult> => {
        try {
          const result = await client.executeTask('get_products', {
            buying_mode: 'brief',
            brief: brief.brief,
            brand: { name: 'Test Brand', url: 'https://example.com' },
          });

          if (!result.success) {
            return {
              name: brief.name, vertical: brief.vertical, products_count: 0,
              channels_found: [], formats_found: [], pricing_models_found: [],
              has_audience_targeting: false,
              error: typeof result.error === 'string' ? result.error : JSON.stringify(result.error),
            };
          }

          const products = (result.data as { products?: unknown[] })?.products ?? [];
          const channelsFound = new Set<string>();
          const formatsFound = new Set<string>();
          const pricingModelsFound = new Set<string>();
          let hasAudienceTargeting = false;

          for (const product of products) {
            const p = product as Record<string, unknown>;
            if (Array.isArray(p.channels)) {
              for (const ch of p.channels) if (typeof ch === 'string') channelsFound.add(ch);
            }
            if (Array.isArray(p.format_ids)) {
              for (const fid of p.format_ids) {
                const f = fid as Record<string, unknown>;
                if (typeof f.id === 'string') formatsFound.add(f.id);
              }
            }
            if (Array.isArray(p.pricing_options)) {
              for (const po of p.pricing_options) {
                const pricing = po as Record<string, unknown>;
                if (pricing.pricing_model && typeof pricing.pricing_model === 'string') {
                  pricingModelsFound.add(pricing.pricing_model);
                }
              }
            }
            if (p.audience || p.targeting || p.audiences) hasAudienceTargeting = true;
          }

          return {
            name: brief.name, vertical: brief.vertical, products_count: products.length,
            channels_found: Array.from(channelsFound), formats_found: Array.from(formatsFound),
            pricing_models_found: Array.from(pricingModelsFound),
            has_audience_targeting: hasAudienceTargeting,
          };
        } catch (error) {
          return {
            name: brief.name, vertical: brief.vertical, products_count: 0,
            channels_found: [], formats_found: [], pricing_models_found: [],
            has_audience_targeting: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }));

      // Aggregate across all briefs
      const allChannelsFound = new Set<string>();
      const allFormatsFound = new Set<string>();
      const allPricingModels = new Set<string>();
      let totalProducts = 0;
      let briefsWithProducts = 0;
      let hasAnyAudienceTargeting = false;

      for (const br of briefResults) {
        for (const ch of br.channels_found) allChannelsFound.add(ch);
        for (const f of br.formats_found) allFormatsFound.add(f);
        for (const pm of br.pricing_models_found) allPricingModels.add(pm);
        totalProducts += br.products_count;
        if (br.products_count > 0) briefsWithProducts++;
        if (br.has_audience_targeting) hasAnyAudienceTargeting = true;
      }

      // Build gap analysis output
      let output = `## Media Kit Comparison: ${resolved.resolvedUrl}\n\n`;

      output += `### What the media kit states\n\n`;
      output += `<user_provided_data>\n${mediaKitSummary}\n</user_provided_data>\n\n`;
      if (effectiveChannels.length > 0) output += `**Stated channels:** ${effectiveChannels.join(', ')}\n`;
      if (formats?.length) output += `**Stated formats:** ${formats.join(', ')}\n`;
      if (effectiveVerticals[0] !== 'general') output += `**Stated verticals:** ${effectiveVerticals.join(', ')}\n`;
      output += '\n';

      output += `### What the agent returns\n\n`;
      output += `**Briefs sent:** ${briefsToRun.length}\n`;
      output += `**Briefs with products:** ${briefsWithProducts}/${briefsToRun.length}\n`;
      output += `**Total products returned:** ${totalProducts}\n`;
      output += `**Channels found:** ${allChannelsFound.size > 0 ? Array.from(allChannelsFound).join(', ') : 'none'}\n`;
      output += `**Formats found:** ${allFormatsFound.size > 0 ? Array.from(allFormatsFound).join(', ') : 'none'}\n`;
      output += `**Pricing models:** ${allPricingModels.size > 0 ? Array.from(allPricingModels).join(', ') : 'none'}\n`;
      output += `**Audience targeting:** ${hasAnyAudienceTargeting ? 'yes' : 'not detected'}\n\n`;

      // Channel gap analysis — exact match then normalized comparison
      if (effectiveChannels.length > 0) {
        const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
        const foundSet = Array.from(allChannelsFound);
        const missingChannels = effectiveChannels.filter(ch =>
          !foundSet.some(found => normalize(found) === normalize(ch))
        );
        const foundChannels = effectiveChannels.filter(ch =>
          foundSet.some(found => normalize(found) === normalize(ch))
        );

        output += `### Channel coverage\n\n`;
        output += `**Found:** ${foundChannels.length > 0 ? foundChannels.join(', ') : 'none'}\n`;
        output += `**Missing:** ${missingChannels.length > 0 ? missingChannels.join(', ') : 'none — all channels covered'}\n`;
        output += `**Coverage:** ${foundChannels.length}/${effectiveChannels.length} stated channels\n\n`;
      }

      // Platform profile context (when platform_type provided)
      if (platformProfile) {
        const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, '');
        const foundChannelSet = Array.from(allChannelsFound);
        output += `### Platform expectations: ${platformProfile.label}\n\n`;
        if (platformProfile.expected_channels?.length) {
          const missingPlatformChannels = platformProfile.expected_channels.filter(ch =>
            !foundChannelSet.some(found => normalize(found) === normalize(ch))
          );
          if (missingPlatformChannels.length > 0) {
            output += `**Expected channels not found:** ${missingPlatformChannels.join(', ')}\n`;
          } else {
            output += `**All expected channels present**\n`;
          }
        }
        output += `**Expected tracks:** ${platformProfile.expected_tracks.join(', ')}\n`;
        output += `**Expected tools:** ${platformProfile.expected_tools.join(', ')}\n\n`;
      }

      // Per-brief results
      output += `### Per-brief results\n\n`;
      for (const br of briefResults) {
        if (br.error) {
          output += `- **${br.name}:** ERROR — ${br.error}\n`;
        } else {
          output += `- **${br.name}:** ${br.products_count} products`;
          if (br.channels_found.length > 0) output += ` | channels: ${br.channels_found.join(', ')}`;
          if (br.pricing_models_found.length > 0) output += ` | pricing: ${br.pricing_models_found.join(', ')}`;
          output += '\n';
        }
      }

      // Available sample briefs for context
      const availableVerticals = [...new Set(SAMPLE_BRIEFS.map(b => b.vertical))];
      output += `\n_Curated sample briefs available for: ${availableVerticals.join(', ')}_\n`;
      if (platformType) {
        output += `_Platform type: ${platformProfile?.label ?? platformType}_\n`;
      }

      output += `\nInterpret these results for the publisher. Highlight specific gaps between their media kit and what the agent returns. For missing channels or formats, explain what buyers would expect and suggest how to add them.${platformProfile ? ` Factor in the platform expectations — a ${platformProfile.label} should support ${platformProfile.expected_tracks.join(', ')} tracks.` : ''}`;

      return output;
    } catch (error) {
      logger.error({ error, agentUrl: resolved.resolvedUrl }, 'Addie: compare_media_kit failed');
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('authentication')) {
        return `Agent at ${resolved.resolvedUrl} requires authentication. Use \`save_agent\` to store credentials first, then try again.`;
      }
      return `Failed to compare media kit for ${resolved.resolvedUrl}: ${msg}`;
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
      return 'This feature requires an organization. Visit https://agenticadvertising.org/onboarding to create one (free, takes 2 minutes). You can still use the public test agent directly via `evaluate_agent_quality` without an organization.';
    }

    const agentUrl = input.agent_url as string;
    const agentName = input.agent_name as string | undefined;
    const authToken = input.auth_token as string | undefined;
    const rawAuthType = input.auth_type as string | undefined;
    const authType: 'bearer' | 'basic' = rawAuthType === 'basic' ? 'basic' : 'bearer';
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
          await agentContextDb.saveAuthToken(context.id, authToken, authType);
        }
        // Refresh context
        context = await agentContextDb.getById(context.id);

        let response = `✅ Updated saved agent: **${context?.agent_name || agentUrl}**\n\n`;
        if (authToken) {
          const typeLabel = authType === 'basic' ? 'Basic' : 'Bearer';
          response += `🔐 ${typeLabel} auth token saved securely (hint: ${context?.auth_token_hint})\n`;
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
        await agentContextDb.saveAuthToken(context.id, authToken, authType);
        context = await agentContextDb.getById(context.id);
      }

      let response = `✅ Saved agent: **${context?.agent_name || agentUrl}**\n\n`;
      response += `**URL:** ${agentUrl}\n`;
      response += `**Protocol:** ${protocol.toUpperCase()}\n`;
      if (authToken) {
        const typeLabel = authType === 'basic' ? 'Basic' : 'Bearer';
        response += `\n🔐 ${typeLabel} auth token saved securely (hint: ${context?.auth_token_hint})\n`;
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
      return 'This feature requires an organization. Visit https://agenticadvertising.org/onboarding to create one (free, takes 2 minutes). You can still use the public test agent directly via `evaluate_agent_quality` without an organization.';
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
        const authTypeLabel = agent.auth_type === 'basic' ? 'Basic' : 'Bearer';
        const hasToken = agent.has_auth_token ? `🔐 ${authTypeLabel} ${agent.auth_token_hint}` : '🔓 No token';

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
      return 'This feature requires an organization. Visit https://agenticadvertising.org/onboarding to create one (free, takes 2 minutes). You can still use the public test agent directly via `evaluate_agent_quality` without an organization.';
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
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to set up the test agent. Please log in at https://agenticadvertising.org first, then come back and try again.';
    }

    const setupOrgId = memberContext.organization?.workos_organization_id;
    let credentialsSaved = false;

    // If user has an org, save credentials so the whole team can use them
    if (setupOrgId) {
      try {
        let context = await agentContextDb.getByOrgAndUrl(setupOrgId, PUBLIC_TEST_AGENT.url);

        if (context && context.has_auth_token) {
          return `The test agent is already set up for your organization!\n\n**Agent:** ${PUBLIC_TEST_AGENT.name}\n**URL:** ${PUBLIC_TEST_AGENT.url}\n\nYou can now:\n- Run \`evaluate_agent_quality\` to run the full compliance evaluation\n- Get coaching on what to improve next`;
        }

        if (context) {
          await agentContextDb.saveAuthToken(context.id, PUBLIC_TEST_AGENT.token);
        } else {
          context = await agentContextDb.create({
            organization_id: setupOrgId,
            agent_url: PUBLIC_TEST_AGENT.url,
            agent_name: PUBLIC_TEST_AGENT.name,
            protocol: 'mcp',
            created_by: memberContext.workos_user.workos_user_id,
          });
          await agentContextDb.saveAuthToken(context.id, PUBLIC_TEST_AGENT.token);
        }
        credentialsSaved = true;
      } catch (error) {
        logger.error({ error, setupOrgId }, 'Addie: setup_test_agent failed to save org credentials');
      }
    }

    // The public test agent works for any logged-in user — evaluate_agent_quality
    // auto-injects public credentials when it detects the test agent URL.
    let response = `**Test agent is ready!**\n\n`;
    response += `**Agent:** ${PUBLIC_TEST_AGENT.name}\n`;
    response += `**URL:** ${PUBLIC_TEST_AGENT.url}\n\n`;
    response += `You can now:\n`;
    response += `- Run \`evaluate_agent_quality\` to run the full compliance evaluation\n`;
    response += `- Get coaching on what to improve next\n\n`;
    if (credentialsSaved) {
      response += `Credentials are saved for your organization so your teammates can use them too.\n\n`;
    }
    response += `Would you like me to run a quick test now?`;

    return response;
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
        logo_url: profile.resolved_brand?.logo_url || null,
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
      return 'Search analytics requires an organization. Visit https://agenticadvertising.org/onboarding to create one (free, takes 2 minutes).';
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

  // Set outreach preference (opt in/out of proactive messages, cadence control)
  handlers.set('set_outreach_preference', async (input) => {
    if (!slackUserId) {
      return '❌ Unable to identify your Slack user. This tool is only available in Slack.';
    }

    const optOutProvided = input.opt_out !== undefined;
    const optOut = input.opt_out === true;
    const validCadences = ['default', 'monthly', 'quarterly'] as const;
    const cadence = validCadences.includes(input.cadence as any)
      ? (input.cadence as (typeof validCadences)[number])
      : undefined;

    // Require at least one parameter — calling with empty params should not silently change state
    if (!optOutProvided && !cadence) {
      return 'Please specify what you\'d like to change: opt out of messages (`opt_out: true`), or set a cadence (`monthly` or `quarterly`). You can also set cadence to `default` to return to normal frequency.';
    }

    // Guard: calling with no parameters should not change state
    if (input.opt_out === undefined && !cadence) {
      return 'Please specify opt_out (true/false) or a cadence (monthly, quarterly, default).';
    }

    try {
      // Find the person relationship
      const relationship = await relationshipDb.getRelationshipBySlackId(slackUserId);
      if (!relationship) {
        return '❌ Could not find your profile. Please try again or contact support.';
      }

      if (optOut) {
        await relationshipDb.setCadence(relationship.id, true, null);
        await personEvents.recordEvent(relationship.id, 'preference_changed', {
          channel: 'slack',
          data: { preference: 'opted_out' },
        });
        return '✅ You\'ve been opted out of proactive outreach messages. You can opt back in anytime by asking me to turn them on again.';
      }

      // Handle cadence preference
      if (cadence && cadence !== 'default') {
        const cadenceDays = cadence === 'monthly' ? 30 : 90;
        const nextContact = new Date();
        nextContact.setDate(nextContact.getDate() + cadenceDays);

        // Clear opted_out — setting a cadence implies opting back in
        await relationshipDb.setOptedOut(relationship.id, false);
        await relationshipDb.setNextContactAfter(relationship.id, nextContact);
        await personEvents.recordEvent(relationship.id, 'preference_changed', {
          channel: 'slack',
          data: { cadence, nextContactAfter: nextContact.toISOString() },
        });
        return `✅ Got it — I'll reach out ${cadence === 'monthly' ? 'about once a month' : 'about once a quarter'}. You can change this anytime.`;
      }

      // Default: opt back in with normal cadence
      await relationshipDb.setOptedOut(relationship.id, false);
      await relationshipDb.setNextContactAfter(relationship.id, null);
      await personEvents.recordEvent(relationship.id, 'preference_changed', {
        channel: 'slack',
        data: { preference: 'opted_in', cadence: 'default' },
      });
      return '✅ Proactive outreach messages are now turned on with normal frequency. I\'ll send you helpful tips and reminders from time to time.';
    } catch (error) {
      logger.error({ error, slackUserId }, 'Addie: Error setting outreach preference');
      return '❌ Failed to update outreach preference. Please try again.';
    }
  });

  // ============================================
  // MEMBER ENGAGEMENT
  // ============================================
  handlers.set('get_member_engagement', async () => {
    if (!memberContext?.workos_user?.workos_user_id) {
      return 'You need to be logged in to view your engagement data. Please log in at https://agenticadvertising.org/dashboard first.';
    }

    const orgId = memberContext.organization?.workos_organization_id;
    if (!orgId) {
      return 'Your account is not yet associated with a member organization. Visit https://agenticadvertising.org/membership to learn about joining.';
    }

    try {
      const [orgData, milestones, signals, recommendedGroups] = await Promise.all([
        query<{
          journey_stage: string | null;
          engagement_score: number | null;
          persona: string | null;
          persona_source: string | null;
          aspiration_persona: string | null;
        }>(
          `SELECT journey_stage, engagement_score, persona, persona_source, aspiration_persona
           FROM organizations WHERE workos_organization_id = $1`,
          [orgId]
        ).then(r => r.rows[0] ?? null).catch(() => null),

        checkMilestones(orgId).catch(() => null),

        orgDb.getEngagementSignals(orgId).catch(() => null),

        getRecommendedGroupsForOrg(orgId, {
          limit: 5,
          excludeUserIds: memberContext.workos_user?.workos_user_id
            ? [memberContext.workos_user.workos_user_id]
            : [],
        }).catch((): GroupRecommendation[] => []),
      ]);


      const STAGES = ['aware', 'evaluating', 'joined', 'onboarding', 'participating', 'contributing', 'leading', 'advocating'];
      const stageIdx = orgData?.journey_stage ? STAGES.indexOf(orgData.journey_stage) : -1;
      const nextStage = stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;

      const result = {
        journey_stage: orgData?.journey_stage ?? null,
        next_stage: nextStage,
        engagement_score: orgData?.engagement_score ?? null,
        persona: orgData?.persona ? PERSONA_LABELS[orgData.persona] ?? orgData.persona : null,
        persona_key: orgData?.persona ?? null,
        persona_source: orgData?.persona_source ?? null,
        assessment_completed: orgData?.persona_source === 'diagnostic',
        assessment_url: 'https://agenticadvertising.org/persona-assessment',
        milestones: milestones ?? {},
        activity: signals ? {
          dashboard_logins_30d: signals.login_count_30d,
          working_group_count: signals.working_group_count,
          email_clicks_30d: signals.email_click_count_30d,
        } : null,
        recommended_groups: recommendedGroups.map(g => ({
          name: g.name,
          slug: g.slug,
          reason: g.reason,
          url: `https://agenticadvertising.org/working-groups/${g.slug}`,
        })),
        member_hub_url: 'https://agenticadvertising.org/member-hub',
      };

      return JSON.stringify(result, null, 2);
    } catch (error) {
      logger.error({ error, orgId }, 'Addie: get_member_engagement failed');
      return 'Unable to load engagement data right now. Please try again.';
    }
  });

  return handlers;
}
