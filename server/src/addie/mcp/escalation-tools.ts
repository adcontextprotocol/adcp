/**
 * Addie Escalation and Learning Tools
 *
 * Tools that allow Addie to:
 * - Escalate requests she cannot fulfill to human admins
 * - Capture valuable learnings from user conversations
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import {
  createEscalation,
  markNotificationSent,
  type EscalationCategory,
  type EscalationPriority,
} from '../../db/escalation-db.js';
import { getThreadService } from '../thread-service.js';
import { sendChannelMessage } from '../../slack/client.js';
import { getEscalationChannel } from '../../db/system-settings-db.js';
import { AddieDatabase } from '../../db/addie-db.js';

const logger = createLogger('addie-escalation-tools');

/**
 * Tool definitions for escalation and learning operations
 */
export const ESCALATION_TOOLS: AddieTool[] = [
  {
    name: 'escalate_to_admin',
    description: `Escalate a request to human admins when you cannot fulfill it yourself.

USE THIS WHEN:
- User asks you to perform an action you have no tool for (posting to channels, creating issues, renaming things)
- The request requires human judgment or approval
- The topic is too complex or sensitive for you to handle
- You've tried and failed to help with your available tools

DO NOT USE FOR:
- Questions you can answer with your tools
- Things that don't require admin attention
- General conversation

BEFORE ESCALATING — gather enough context to make the escalation actionable:
- Ask what specifically they need if the request is vague
- Confirm who the request is from: their name and organization. If someone is asking on behalf of another person, capture that person's name and contact details in the summary.
- Include any relevant context (timeline, urgency, what they've already tried)

When you escalate, be honest with the user that you're passing this to a human who can help.`,
    usage_hints: 'use when you cannot perform an action yourself and need human help',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what the user needs (1-2 sentences)',
        },
        category: {
          type: 'string',
          enum: ['capability_gap', 'needs_human_action', 'complex_request', 'sensitive_topic', 'other'],
          description: 'Type of escalation: capability_gap (no tool for this), needs_human_action (requires human to act), complex_request (too complex), sensitive_topic (needs human judgment), other',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'How urgent is this? Default: normal',
        },
        original_request: {
          type: 'string',
          description: 'What the user originally asked for',
        },
        addie_context: {
          type: 'string',
          description: 'Why you are escalating - what you tried or why you cannot help',
        },
      },
      required: ['summary', 'category'],
    },
  },
  {
    name: 'capture_learning',
    description: `Capture valuable knowledge or perspective shared by the user.

USE THIS WHEN the user shares:
- Strategic perspectives on the industry
- Adoption barriers or implementation experiences
- Feedback about AdCP or AgenticAdvertising.org
- Market intelligence or competitive insights
- Use cases or novel applications

This helps the team learn from community conversations and improve Addie's knowledge.

DO NOT use for:
- General questions or support requests
- Content already in the docs
- Off-topic conversations`,
    usage_hints: 'use when user shares valuable industry perspective or strategic insight',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic category: adoption, platform-strategy, trust, use-cases, market-intel, feedback, other',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of what the user shared (1-2 sentences)',
        },
        why_valuable: {
          type: 'string',
          description: 'Why this knowledge is worth capturing',
        },
      },
      required: ['topic', 'summary'],
    },
  },
];

/**
 * Get the configured escalation notification channel from system settings
 */
async function getEscalationChannelId(): Promise<string | null> {
  const setting = await getEscalationChannel();
  return setting.channel_id;
}

/**
 * Format and send escalation notification to Slack
 */
async function sendEscalationNotification(
  escalationId: number,
  channelId: string,
  summary: string,
  category: EscalationCategory,
  priority: EscalationPriority,
  context: {
    userDisplayName?: string;
    orgName?: string;
    slackUserId?: string;
    threadId?: string;
    originalRequest?: string;
    addieContext?: string;
  }
): Promise<{ ok: boolean; ts?: string }> {
  const priorityEmoji: Record<EscalationPriority, string> = {
    low: '',
    normal: '',
    high: ':warning:',
    urgent: ':rotating_light:',
  };

  const categoryLabel: Record<EscalationCategory, string> = {
    capability_gap: 'Capability Gap',
    needs_human_action: 'Needs Human Action',
    complex_request: 'Complex Request',
    sensitive_topic: 'Sensitive Topic',
    other: 'Other',
  };

  const userInfo = context.userDisplayName
    ? `${context.userDisplayName}${context.orgName ? ` (${context.orgName})` : ''}`
    : context.slackUserId
      ? `<@${context.slackUserId}>`
      : 'Unknown user';

  const lines = [
    `${priorityEmoji[priority]} *New Escalation #${escalationId}*`,
    '',
    `*From:* ${userInfo}`,
    `*Category:* ${categoryLabel[category]}`,
    `*Priority:* ${priority}`,
    '',
    `*Summary:* ${summary}`,
  ];

  if (context.originalRequest) {
    lines.push('', `*Original Request:* ${context.originalRequest}`);
  }

  if (context.addieContext) {
    lines.push('', `*Why Escalated:* ${context.addieContext}`);
  }

  if (context.threadId) {
    lines.push('', `<https://agenticadvertising.org/admin/addie?thread=${context.threadId}|View Thread>`);
  }

  return sendChannelMessage(channelId, { text: lines.join('\n') });
}

/**
 * Create handlers for escalation and learning tools
 */
export function createEscalationToolHandlers(
  memberContext: MemberContext | null,
  slackUserId?: string,
  threadId?: string
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // ============================================
  // ESCALATE TO ADMIN
  // ============================================
  handlers.set('escalate_to_admin', async (input) => {
    // Validate required inputs
    if (typeof input.summary !== 'string' || !input.summary.trim()) {
      return 'Error: summary is required and must be a non-empty string';
    }

    const validCategories: EscalationCategory[] = [
      'capability_gap', 'needs_human_action', 'complex_request', 'sensitive_topic', 'other'
    ];
    if (!validCategories.includes(input.category as EscalationCategory)) {
      return `Error: category must be one of: ${validCategories.join(', ')}`;
    }

    const validPriorities: EscalationPriority[] = ['low', 'normal', 'high', 'urgent'];
    if (input.priority && !validPriorities.includes(input.priority as EscalationPriority)) {
      return `Error: priority must be one of: ${validPriorities.join(', ')}`;
    }

    const summary = input.summary as string;
    const category = input.category as EscalationCategory;
    const priority = (input.priority as EscalationPriority) || 'normal';
    const originalRequest = input.original_request as string | undefined;
    const addieContext = input.addie_context as string | undefined;

    // Get display name from slack_user or workos_user
    const userDisplayName = memberContext?.slack_user?.display_name
      ?? (memberContext?.workos_user?.first_name
        ? `${memberContext.workos_user.first_name} ${memberContext.workos_user.last_name || ''}`.trim()
        : undefined);
    const orgName = memberContext?.organization?.name;

    try {
      // 1. Create escalation record
      const escalation = await createEscalation({
        thread_id: threadId,
        slack_user_id: slackUserId,
        workos_user_id: memberContext?.workos_user?.workos_user_id,
        user_display_name: userDisplayName,
        category,
        priority,
        summary,
        original_request: originalRequest,
        addie_context: addieContext,
      });

      logger.info(
        { escalationId: escalation.id, category, priority, threadId },
        'Created escalation'
      );

      // 2. Flag the thread
      if (threadId) {
        const threadService = getThreadService();
        await threadService.flagThread(threadId, `Escalation: ${category}`);
      }

      // 3. Send notification to escalation channel
      const escalationChannelId = await getEscalationChannelId();
      if (escalationChannelId) {
        const result = await sendEscalationNotification(
          escalation.id,
          escalationChannelId,
          summary,
          category,
          priority,
          {
            userDisplayName,
            orgName,
            slackUserId,
            threadId,
            originalRequest,
            addieContext,
          }
        );

        if (result.ok && result.ts) {
          try {
            await markNotificationSent(escalation.id, escalationChannelId, result.ts);
            logger.info({ escalationId: escalation.id, channelId: escalationChannelId }, 'Sent escalation notification');
          } catch (notifyError) {
            logger.error(
              { escalationId: escalation.id, error: notifyError },
              'Failed to record notification status - notification was sent but DB update failed'
            );
          }
        }
      } else {
        logger.warn({ escalationId: escalation.id }, 'No escalation channel configured - notification not sent');
      }

      return `Escalation created (ID: ${escalation.id}). I've notified the AgenticAdvertising.org team and they'll follow up with you soon.`;
    } catch (error) {
      logger.error({ error, category, threadId }, 'Failed to create escalation');
      return 'I tried to escalate this but encountered an error. Please reach out directly to the AgenticAdvertising.org team for help.';
    }
  });

  // ============================================
  // CAPTURE LEARNING
  // ============================================
  handlers.set('capture_learning', async (input) => {
    // Validate required inputs
    if (typeof input.topic !== 'string' || !input.topic.trim()) {
      return 'Error: topic is required and must be a non-empty string';
    }
    if (typeof input.summary !== 'string' || !input.summary.trim()) {
      return 'Error: summary is required and must be a non-empty string';
    }

    const topic = input.topic as string;
    const summary = input.summary as string;
    const whyValuable = input.why_valuable as string | undefined;

    // Get display name from slack_user or workos_user
    const authorDisplayName = memberContext?.slack_user?.display_name
      ?? (memberContext?.workos_user?.first_name
        ? `${memberContext.workos_user.first_name} ${memberContext.workos_user.last_name || ''}`.trim()
        : undefined);
    const authorOrgName = memberContext?.organization?.name;

    try {
      // Get recent conversation content for context
      let content = summary;
      if (threadId) {
        const threadService = getThreadService();
        const thread = await threadService.getThreadWithMessages(threadId);
        if (thread?.messages && thread.messages.length > 0) {
          // Get last few messages for context
          const recentMessages = thread.messages.slice(-5);
          content = recentMessages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n\n');
        }
      }

      // Create insight source record
      const addieDb = new AddieDatabase();
      const source = await addieDb.createInsightSource({
        source_type: 'conversation',
        source_ref: threadId,
        content,
        topic,
        author_name: authorDisplayName,
        author_context: authorOrgName,
        tagged_by: 'addie',
        notes: whyValuable,
      });

      logger.info(
        { insightId: source.id, topic, threadId, authorName: authorDisplayName },
        'Captured learning from conversation'
      );

      return `Learning captured (ID: ${source.id}). Thank you for sharing this insight - it helps us improve!`;
    } catch (error) {
      logger.error({ error, topic, threadId }, 'Failed to capture learning');
      return 'I noted this insight but encountered an error saving it. The team may follow up.';
    }
  });

  return handlers;
}
