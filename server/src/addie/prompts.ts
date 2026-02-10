/**
 * Addie's system prompt and personality
 */

import type { SuggestedPrompt } from './types.js';
import type { MemberContext } from './member-context.js';
import { createLogger } from '../logger.js';
import {
  trimConversationHistory,
  getConversationTokenLimit,
  estimateTokens,
  type MessageTurn,
} from '../utils/token-limiter.js';

const logger = createLogger('addie-prompts');

/**
 * Tool reference documentation - always appended to system prompt.
 *
 * This is in code (not database) because tools are defined in code.
 * When you add/remove tools, update this constant.
 * Database rules handle behavioral guidance on *how* to use tools.
 */
export const ADDIE_TOOL_REFERENCE = `## Available Tools

You have access to these tools to help users:

**Knowledge Search:**
- search_docs: Search AdCP documentation
- search_repos: Search indexed ad tech specifications (OpenRTB, VAST, MCP, A2A, Prebid, etc.)
- search_slack: Search community discussions
- search_resources: Search curated industry articles
- get_recent_news: Get recent ad tech news
- web_search: Search the web (use only when search_repos doesn't have what you need)

**Adagents & Agent Testing:**
- validate_adagents: Check a domain's adagents.json configuration
- check_agent_health: Test if an agent is online
- check_publisher_authorization: Verify publisher has authorized an agent
- get_agent_capabilities: See what tools an agent supports

**Working Groups:**
- list_working_groups: Show available groups
- get_working_group: Get details about a specific group
- join_working_group: Join a public group
- get_my_working_groups: Show user's memberships
- create_working_group_post: Post in a group
- add_committee_document: Add a Google Doc to track (leader only)
- list_committee_documents: List tracked documents
- update_committee_document: Update a tracked document (leader only)
- delete_committee_document: Remove a tracked document (leader only)

**Events (admins and committee leads):**
- create_event: Create an event (meetup, webinar, summit, etc.)
- list_events: List events personalized for the user
- get_event_details: Get event details including registration counts
- manage_event_registrations: List, approve, or export registrations
- update_event: Modify event details

**Meetings (admins and committee leaders):**
- schedule_meeting: Schedule a meeting with Zoom and calendar invites. Requires working_group_slug, title, start_time (ISO format). Optional: description, agenda, duration_minutes, timezone, topic_slugs
- list_upcoming_meetings: List upcoming meetings (filter by working_group_slug)
- get_my_meetings: Get user's upcoming meetings
- get_meeting_details: Get meeting details with attendees and RSVP status
- rsvp_to_meeting: RSVP to a meeting (accepted, declined, tentative)
- cancel_meeting: Cancel a meeting (sends notices)
- add_meeting_attendee: Add someone to a meeting by email
- update_topic_subscriptions: Update meeting topic subscriptions

**Member Profile:**
- get_my_profile: Show user's profile
- update_my_profile: Update profile fields

**Find Help / Partner Discovery:**

- search_members: Search for member organizations by expertise, offerings, or capability
- connect_to_si_agent: Start a live conversation with a brand's SI agent (when SI context shows available brands)
- request_introduction: Request an email introduction to a member (fallback when SI not available)
- list_si_agents: List all brands with SI agents available
- get_my_search_analytics: Show the user's profile analytics

**Sponsored Intelligence (SI):**
When SI agents appear in your context, you can offer direct connections:
- Tell the user the brand is available for conversation
- When they agree, use connect_to_si_agent(brand_name)
- No need to call list_si_agents first - context already shows available agents

**SI Session Tools (for active conversations):**
- send_to_si_agent: Continue an active SI conversation
- end_si_session: End the current SI conversation
- get_si_session_status: Check if user is currently in an SI session

**During Active SI Sessions:**
When there is an active SI session, use send_to_si_agent for EVERY user message intended for the brand. You are a relay - let the actual SI agent respond.

**Content:**
- list_perspectives: Browse community articles

**Account Linking:**
- get_account_link: Generate a sign-in link

**File Handling:**
- read_slack_file: Read file content shared in Slack

**GitHub:**
- draft_github_issue: Draft a GitHub issue with pre-filled URL

**Escalation:**
- escalate_to_admin: Create a tracked request for the team
- list_escalations: List open escalations needing attention (admin only)
- resolve_escalation: Mark an escalation as resolved and notify the user (admin only)

**Closing the Loop on Escalations (IMPORTANT for admins):**
When handling a request that came from an escalation (e.g., admin replies in escalation channel thread):
1. Complete the requested action using your tools
2. Call resolve_escalation with the escalation ID to close it
3. Include a notification_message explaining what was done
This ensures users are notified when their escalated requests are handled.

**Admin Tools (admins only - user will have [ADMIN USER] prefix):**
- get_organization_details: Comprehensive company lookup
- find_prospect: Quick search for prospects
- add_prospect: Add a new prospect
- update_prospect: Update prospect info
- list_prospects: List prospects with filtering
- enrich_company: Research a company via Lusha
- prospect_search_lusha: Search Lusha for prospects
- lookup_organization: Look up membership status
- list_pending_invoices: List organizations with outstanding invoices
- create_industry_gathering: Create temporary committee for events
- list_industry_gatherings: List industry gatherings
- find_membership_products: Find membership product by type/revenue
- create_payment_link: Generate Stripe checkout URL
- send_invoice: Send invoice via email`;

/**
 * Minimal fallback prompt - used only when database is unavailable.
 *
 * The main system prompt comes from database rules (addie_rules table).
 * This fallback ensures Addie can still function if the database is down.
 * Tool reference is always appended separately.
 */
export const ADDIE_FALLBACK_PROMPT = `You are Addie, the AI assistant for AgenticAdvertising.org.

AgenticAdvertising.org is the membership organization. AdCP (Ad Context Protocol) is the technical protocol specification.

Be helpful, cite sources, and say "I don't know" rather than guess. Use "AgenticAdvertising.org" not "AAO" or "Alliance for Agentic Advertising".

Note: Running in fallback mode - some behavioral guidelines may not be loaded. Core functionality is available.`;

/**
 * Suggested prompts shown when user opens Assistant
 * Keep these casual and conversational - like things a person would actually say
 */
export const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  {
    title: 'What brings you here?',
    message: "Hey! I'm curious what brought you to AgenticAdvertising.org",
  },
  {
    title: 'Help me build something',
    message: "I'm trying to build an agent - where do I start?",
  },
  {
    title: 'What is this anyway?',
    message: "I keep hearing about agentic advertising but I'm not sure what it actually is",
  },
  {
    title: 'Connect me with people',
    message: 'Who else is working on this stuff? I want to meet people in the space',
  },
  {
    title: 'Show me the specs',
    message: 'Where can I find the technical documentation?',
  },
  {
    title: 'What can you do?',
    message: 'What kinds of things can you help me with?',
  },
];

/**
 * Status messages for different states
 */
export const STATUS_MESSAGES = {
  thinking: 'Thinking...',
  searching: 'Searching documentation...',
  generating: 'Generating response...',
};

/**
 * Build dynamic suggested prompts based on user context, role, and active goals
 *
 * @param memberContext - User's member context (or null if lookup failed)
 * @param isAAOAdmin - Whether the user is an AAO platform admin
 * @returns Array of suggested prompts tailored to the user
 */
export async function buildDynamicSuggestedPrompts(
  memberContext: MemberContext | null,
  isAAOAdmin: boolean
): Promise<SuggestedPrompt[]> {
  const isMapped = !!memberContext?.workos_user?.workos_user_id;

  // Not linked - prioritize casual discovery
  if (!isMapped) {
    const prompts: SuggestedPrompt[] = [
      {
        title: 'What brings you here?',
        message: "Hey! I'm curious what brought you to AgenticAdvertising.org",
      },
      {
        title: 'Help me get set up',
        message: 'I want to link my account and get started',
      },
    ];

    prompts.push({
      title: 'What is this anyway?',
      message: "I keep hearing about agentic advertising but I'm not sure what it actually is",
    });

    return prompts.slice(0, 4); // Slack limits to 4 prompts
  }

  // Admin users get admin-specific suggestions
  if (isAAOAdmin) {
    return [
      {
        title: 'Pending invoices',
        message: 'Show me all organizations with pending invoices',
      },
      {
        title: 'Look up a company',
        message: 'What is the membership status for [company name]?',
      },
      {
        title: 'Prospect pipeline',
        message: 'Show me the current prospect pipeline',
      },
      {
        title: 'My working groups',
        message: "What's happening in my working groups?",
      },
    ];
  }

  // Linked non-admin users - personalized prompts
  const prompts: SuggestedPrompt[] = [];

  // Show working groups if they have some, otherwise suggest finding one
  if (memberContext.working_groups && memberContext.working_groups.length > 0) {
    prompts.push({
      title: 'My working groups',
      message: "What's been happening in my working groups?",
    });
  } else {
    prompts.push({
      title: 'Find my people',
      message: 'What working groups would be a good fit for me?',
    });
  }

  prompts.push({
    title: 'Test my agent',
    message: 'Can you check if my agent is set up correctly?',
  });

  prompts.push({
    title: 'What can you do?',
    message: 'What kinds of things can you help me with?',
  });

  prompts.push({
    title: 'Explain it to me',
    message: "I'm still wrapping my head around agentic advertising - can you give me the quick version?",
  });

  return prompts.slice(0, 4); // Slack limits to 4 prompts
}

/**
 * Build context with thread history (legacy - flattens to single string)
 * @deprecated Use buildMessageTurns instead for proper conversation context
 */
export function buildContextWithThread(
  userMessage: string,
  threadContext?: Array<{ user: string; text: string }>
): string {
  if (!threadContext || threadContext.length === 0) {
    return userMessage;
  }

  const threadSummary = threadContext
    .slice(-5)
    .map((msg) => `${msg.user}: ${msg.text}`)
    .join('\n');

  return `Previous messages in thread:
${threadSummary}

Current message: ${userMessage}`;
}

/**
 * Thread context entry from conversation history
 */
export interface ThreadContextEntry {
  user: string; // 'User' or 'Addie'
  text: string;
}

// Re-export MessageTurn from token-limiter for backwards compatibility
export type { MessageTurn };

/**
 * Options for building message turns
 */
export interface BuildMessageTurnsOptions {
  /** Maximum number of messages to include (default: 10, 0 = unlimited) */
  maxMessages?: number;
  /** Token limit for conversation history (default: calculated from model limit) */
  tokenLimit?: number;
  /** Model name for determining context limits */
  model?: string;
  /** Number of tools being used (for more accurate token budget calculation) */
  toolCount?: number;
}

/**
 * Result of building message turns with metadata
 */
export interface BuildMessageTurnsResult {
  messages: MessageTurn[];
  /** Estimated token count of messages */
  estimatedTokens: number;
  /** Number of messages removed due to limits */
  messagesRemoved: number;
  /** Whether messages were trimmed to fit limits */
  wasTrimmed: boolean;
}

/**
 * Build proper message turns from thread context for Claude API
 *
 * This converts conversation history into alternating user/assistant messages
 * which Claude understands as actual conversation context (not just informational text).
 *
 * Token-aware: Automatically trims older messages if conversation exceeds context limits.
 *
 * @param userMessage - The current user message
 * @param threadContext - Previous messages in the thread
 * @param options - Optional configuration for message limits
 * @returns Array of message turns suitable for Claude API
 */
export function buildMessageTurns(
  userMessage: string,
  threadContext?: ThreadContextEntry[],
  options?: BuildMessageTurnsOptions
): MessageTurn[] {
  const result = buildMessageTurnsWithMetadata(userMessage, threadContext, options);
  return result.messages;
}

/**
 * Build message turns with full metadata about trimming and token estimates.
 * Use this when you need visibility into whether conversation was trimmed.
 */
export function buildMessageTurnsWithMetadata(
  userMessage: string,
  threadContext?: ThreadContextEntry[],
  options?: BuildMessageTurnsOptions
): BuildMessageTurnsResult {
  const maxMessages = options?.maxMessages ?? 10;
  // Pass toolCount for more accurate token budget when available
  const tokenLimit = options?.tokenLimit ?? getConversationTokenLimit(options?.model, options?.toolCount);

  let messages: MessageTurn[] = [];

  if (threadContext && threadContext.length > 0) {
    // First pass: apply message count limit if specified
    let recentHistory = maxMessages > 0
      ? threadContext.slice(-maxMessages)
      : threadContext;

    // Convert each entry to proper message turn
    // The 'user' field is 'User' or 'Addie' from bolt-app.ts
    // Skip empty messages defensively
    for (const entry of recentHistory) {
      const trimmedText = entry.text?.trim();
      if (!trimmedText) continue;
      const role: 'user' | 'assistant' = entry.user === 'Addie' ? 'assistant' : 'user';
      messages.push({ role, content: trimmedText });
    }

    // Claude API requires messages to start with 'user' role
    // If history starts with assistant, we need to handle this
    if (messages.length > 0 && messages[0].role === 'assistant') {
      // Prepend a placeholder user message to maintain valid structure
      messages.unshift({ role: 'user', content: '[conversation continued]' });
    }

    // Claude API requires alternating user/assistant messages
    // Merge consecutive same-role messages
    const mergedMessages: MessageTurn[] = [];
    for (const msg of messages) {
      if (mergedMessages.length === 0 || mergedMessages[mergedMessages.length - 1].role !== msg.role) {
        mergedMessages.push({ ...msg });
      } else {
        // Merge with previous message of same role
        mergedMessages[mergedMessages.length - 1].content += '\n\n' + msg.content;
      }
    }

    messages = mergedMessages;
  }

  // Add the current user message
  // If the last message in history is from user, merge with it
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    messages[messages.length - 1].content += '\n\n' + userMessage;
  } else {
    messages.push({ role: 'user', content: userMessage });
  }

  // Second pass: apply token limit trimming
  // This removes oldest messages until we fit within the token budget
  const trimResult = trimConversationHistory(messages, tokenLimit);

  return {
    messages: trimResult.messages,
    estimatedTokens: trimResult.estimatedTokens,
    messagesRemoved: trimResult.messagesRemoved,
    wasTrimmed: trimResult.wasTrimmed,
  };
}
