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

const adagentsManager = new AdAgentsManager();

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
      'List active working groups in AgenticAdvertising.org. Shows public groups to everyone, and includes private groups for members. Use this to help users find groups that match their interests.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of groups to return (default 20, max 50)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_working_group',
    description:
      'Get details about a specific working group including its description, leaders, member count, and recent posts. Use the group slug (URL-friendly name).',
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
  // ACCOUNT LINKING
  // ============================================
  {
    name: 'get_account_link',
    description:
      'Get a link to connect the user\'s Slack account with their AgenticAdvertising.org account. Use this when a user\'s accounts are not linked and they want to access member features. IMPORTANT: Share the full tool output with the user - it contains the clickable sign-in link they need. The user clicks the link to sign in and their accounts are automatically connected.',
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

  // ============================================
  // GITHUB ISSUE DRAFTING
  // ============================================
  {
    name: 'draft_github_issue',
    description:
      'Draft a GitHub issue and generate a pre-filled URL for the user to create it. Use this when users report bugs, request features, or ask you to create a GitHub issue. IMPORTANT: Share the full tool output with the user - it contains the clickable link they need to create the issue. The user will click the link to create the issue from their own GitHub account. Infer the appropriate repo from context (channel name, conversation topic) - use "adcp" for protocol/docs issues, "aao-server" for website/community issues.',
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
            'Issue body in markdown format. Include context, steps to reproduce (for bugs), or detailed description (for features). Reference the Slack conversation if relevant.',
        },
        repo: {
          type: 'string',
          description:
            'Repository name within adcontextprotocol org (e.g., "adcp" for protocol/docs, "aao-server" for website/community). Default: "adcp"',
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
];

/**
 * Base URL for internal API calls
 * Uses BASE_URL env var in production, falls back to localhost for development
 */
function getBaseUrl(): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  const port = process.env.CONDUCTOR_PORT || process.env.PORT || '3000';
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
      signal: AbortSignal.timeout(10000),
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

    const result = await callApi('GET', `/api/working-groups?limit=${limit}`, memberContext);

    if (!result.ok) {
      return `Failed to fetch working groups: ${result.error}`;
    }

    const groups = result.data as Array<{
      slug: string;
      name: string;
      description: string;
      is_private: boolean;
      member_count: number;
    }>;

    if (groups.length === 0) {
      return 'No active working groups found.';
    }

    let response = `## AgenticAdvertising.org Working Groups\n\n`;
    groups.forEach((group) => {
      const privacy = group.is_private ? '🔒 Private' : '🌐 Public';
      response += `### ${group.name}\n`;
      response += `**Slug:** ${group.slug} | **Members:** ${group.member_count} | ${privacy}\n`;
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
  // ACCOUNT LINKING
  // ============================================
  handlers.set('get_account_link', async () => {
    // Check if already linked
    if (memberContext?.workos_user?.workos_user_id) {
      return '✅ Your Slack account is already linked to your AgenticAdvertising.org account! You have full access to member features.';
    }

    // Need slack_user_id to generate the link
    if (!memberContext?.slack_user?.slack_user_id) {
      return "I couldn't determine your Slack user ID. Please try typing `/aao link` in Slack to get a sign-in link.";
    }

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

  return handlers;
}
