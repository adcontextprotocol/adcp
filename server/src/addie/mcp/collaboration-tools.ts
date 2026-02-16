/**
 * Addie Collaboration Tools
 *
 * Tools that allow Addie to facilitate collaboration between AAO members:
 * - Send DMs to other members with conversation context and attribution
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { sendDirectMessage } from '../../slack/client.js';
import { getThreadService } from '../thread-service.js';

const logger = createLogger('addie-collaboration-tools');
const slackDb = new SlackDatabase();
const wgDb = new WorkingGroupDatabase();

/**
 * Tool definitions for collaboration operations
 */
export const COLLABORATION_TOOLS: AddieTool[] = [
  {
    name: 'send_member_dm',
    description: `Send a direct message to another AgenticAdvertising.org member on Slack.

USE THIS WHEN a user explicitly asks you to:
- Reach out to another member on their behalf
- Forward a conversation summary to someone for feedback
- Send a follow-up or notification to a specific person

The message will include attribution showing who asked you to send it.
You can optionally include a summary of the current conversation as context.

Look up recipients by email (preferred), name (may need disambiguation), or Slack user ID.

DO NOT USE unless the user explicitly requests you to message someone.`,
    usage_hints: 'Use when user explicitly asks to send a DM to another member or forward conversation context',
    input_schema: {
      type: 'object' as const,
      properties: {
        email: { type: 'string', description: 'Recipient email address (preferred lookup)' },
        name: { type: 'string', description: 'Recipient name to search (may return multiple matches)' },
        slack_user_id: { type: 'string', description: 'Recipient Slack user ID (if already known)' },
        message: { type: 'string', description: 'Message content to send' },
        include_context: {
          type: 'boolean',
          description: 'Include a summary of the current conversation as context. Only set to true if the user explicitly asks to forward or share their conversation.',
        },
      },
      required: ['message'],
    },
  },
];

const MAX_MESSAGE_LENGTH = 4000;
const MAX_CONTEXT_LENGTH = 2000;
const CONTEXT_MESSAGE_COUNT = 5;

/**
 * Build a conversation excerpt from recent thread messages
 */
async function buildConversationExcerpt(
  threadId: string,
  senderDisplayName: string | undefined,
): Promise<string | null> {
  const threadService = getThreadService();
  const thread = await threadService.getThreadWithMessages(threadId);

  if (!thread?.messages || thread.messages.length === 0) {
    return null;
  }

  const recentMessages = thread.messages.slice(-CONTEXT_MESSAGE_COUNT);
  let excerpt = recentMessages
    .map((m) => {
      const speaker = m.role === 'user' ? (senderDisplayName || 'User') : 'Addie';
      // Truncate long individual messages
      const content = m.content.length > 500
        ? m.content.slice(0, 497) + '...'
        : m.content;
      return `> ${speaker}: ${content}`;
    })
    .join('\n');

  if (excerpt.length > MAX_CONTEXT_LENGTH) {
    excerpt = excerpt.slice(0, MAX_CONTEXT_LENGTH - 3) + '...';
  }

  return excerpt;
}

/**
 * Create handlers for collaboration tools
 */
export function createCollaborationToolHandlers(
  memberContext: MemberContext | null,
  slackUserId?: string,
  threadId?: string,
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('send_member_dm', async (input) => {
    // Require sender to be a member
    if (!memberContext?.is_member) {
      return 'You must be an AgenticAdvertising.org member to send messages to other members.';
    }

    const email = (input.email as string | undefined)?.trim();
    const name = (input.name as string | undefined)?.trim();
    const recipientSlackId = (input.slack_user_id as string | undefined)?.trim();
    const message = input.message as string | undefined;
    const includeContext = input.include_context === true; // default false - only forward context when explicitly requested

    if (!email && !name && !recipientSlackId) {
      return 'Must provide email, name, or slack_user_id to identify the recipient.';
    }

    if (!message || message.trim().length === 0) {
      return 'Message content is required.';
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return `Message too long (${message.length} characters). Maximum is ${MAX_MESSAGE_LENGTH} characters.`;
    }

    let targetSlackUserId: string | null = null;
    let recipientInfo: { name?: string; email?: string } = {};

    try {
      // Priority 1: Direct Slack user ID
      if (recipientSlackId) {
        if (!/^[UW][A-Z0-9]{8,12}$/i.test(recipientSlackId)) {
          return 'Invalid Slack user ID format. Expected format: U01234ABCD';
        }
        targetSlackUserId = recipientSlackId;
        const mapping = await slackDb.getBySlackUserId(recipientSlackId);
        recipientInfo = {
          name: mapping?.slack_real_name || mapping?.slack_display_name || undefined,
          email: mapping?.slack_email || undefined,
        };
      }
      // Priority 2: Email lookup
      else if (email) {
        const mapping = await slackDb.findByEmail(email);
        if (!mapping) {
          return `No Slack user found with email: ${email}\n\nThe member may not have linked their Slack account, or uses a different email in Slack.`;
        }
        targetSlackUserId = mapping.slack_user_id;
        recipientInfo = {
          name: mapping.slack_real_name || mapping.slack_display_name || undefined,
          email: mapping.slack_email || undefined,
        };
      }
      // Priority 3: Name search
      else if (name) {
        const SEARCH_LIMIT = 10;
        const matches = await wgDb.searchUsersForLeadership(name, SEARCH_LIMIT);

        if (matches.length === 0) {
          return `No members found matching name: "${name}"`;
        }

        if (matches.length > 1) {
          const matchList = matches.map((m, i) =>
            `${i + 1}. **${m.name}** (${m.email}) - ${m.org_name}`
          ).join('\n');

          const truncationNote = matches.length >= SEARCH_LIMIT
            ? `\n\n_(Showing first ${SEARCH_LIMIT} results. Use a more specific search or email address.)_`
            : '';

          return `Multiple members found matching "${name}". Please specify the email address:\n\n${matchList}${truncationNote}\n\nCall again with the specific email address.`;
        }

        // Single match - look up their Slack ID
        const match = matches[0];
        const mapping = await slackDb.findByEmail(match.email);

        if (!mapping) {
          return `Found member **${match.name}** (${match.email}) but they don't have a linked Slack account.\n\nConsider reaching out via email instead.`;
        }

        targetSlackUserId = mapping.slack_user_id;
        recipientInfo = {
          name: match.name,
          email: match.email,
        };
      }

      if (!targetSlackUserId) {
        return 'Could not resolve recipient Slack ID.';
      }

      // Prevent self-DM
      if (targetSlackUserId === slackUserId) {
        return 'You cannot send a DM to yourself through Addie.';
      }

      // Build the DM content with attribution
      const senderName = memberContext.slack_user?.display_name
        ?? (memberContext.workos_user?.first_name
          ? `${memberContext.workos_user.first_name} ${memberContext.workos_user.last_name || ''}`.trim()
          : undefined);
      const senderOrg = memberContext.organization?.name;

      const parts: string[] = [];

      // Always include attribution so the recipient knows who initiated
      const attribution = senderOrg
        ? `_Message from Addie AI, on behalf of ${senderName || 'a member'} (${senderOrg})_`
        : `_Message from Addie AI, on behalf of ${senderName || 'a member'}_`;
      parts.push(attribution);
      parts.push('');

      parts.push(message);

      // Context forwarding
      if (includeContext && threadId) {
        const excerpt = await buildConversationExcerpt(threadId, senderName);
        if (excerpt) {
          parts.push('');
          parts.push('---');
          parts.push('_Conversation context:_');
          parts.push(excerpt);
        }
      }

      const fullMessage = parts.join('\n');

      // Send the DM
      const result = await sendDirectMessage(targetSlackUserId, {
        text: fullMessage,
      });

      if (result.ok) {
        const recipientDisplay = recipientInfo.name
          ? `**${recipientInfo.name}** (${recipientInfo.email || targetSlackUserId})`
          : targetSlackUserId;

        logger.info({
          targetSlackUserId,
          recipientName: recipientInfo.name,
          recipientEmail: recipientInfo.email,
          senderSlackUserId: slackUserId,
          senderWorkosUserId: memberContext.workos_user?.workos_user_id,
          messageLength: fullMessage.length,
          includeContext,
        }, 'Member sent DM via Addie');

        return `Message sent to ${recipientDisplay}`;
      } else {
        logger.warn({
          targetSlackUserId,
          error: result.error,
        }, 'Failed to send member DM via Addie');

        return `Failed to send message: ${result.error || 'Unknown error'}`;
      }
    } catch (error) {
      logger.error({ error, email, name, slackUserId: recipientSlackId }, 'Error in send_member_dm');
      return `Error sending message: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  return handlers;
}
