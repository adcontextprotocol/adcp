/**
 * Newsletter Suggestion Tools
 *
 * Allows community members to suggest content for The Prompt or The Build
 * via Addie conversation. Available to all users.
 */

import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { createSuggestion } from '../../db/newsletter-suggestions-db.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('newsletter-tools');

export const NEWSLETTER_TOOLS: AddieTool[] = [
  {
    name: 'suggest_newsletter_content',
    description: `Suggest content for the community newsletters. Use this when someone says "this should be in The Prompt" or "add this to The Build" or "suggest this for the newsletter." The Prompt is Addie's community newsletter (for everyone). The Build is Sage's contributor briefing (for contributor seats).`,
    input_schema: {
      type: 'object' as const,
      properties: {
        newsletter: {
          type: 'string',
          enum: ['the_prompt', 'the_build'],
          description: 'Which newsletter to suggest content for. Default to the_prompt unless the user specifically mentions The Build or contributor/protocol content.',
        },
        title: {
          type: 'string',
          description: 'Title or brief description of the suggested content (max 200 chars)',
        },
        url: {
          type: 'string',
          description: 'URL of the article, video, or resource being suggested (optional)',
        },
        reason: {
          type: 'string',
          description: "Why this should be included — the user's own words about why it matters (optional, max 500 chars)",
        },
      },
      required: ['newsletter', 'title'],
    },
  },
];

export function createNewsletterToolHandlers(
  memberContext: MemberContext | null,
  slackUserId?: string,
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('suggest_newsletter_content', async (input) => {
    const newsletterId = input.newsletter as string;
    const title = (input.title as string).slice(0, 200);
    const rawUrl = input.url as string | undefined;
    const url = rawUrl && (rawUrl.startsWith('https://') || rawUrl.startsWith('http://')) ? rawUrl : undefined;
    const reason = input.reason ? (input.reason as string).slice(0, 500) : undefined;

    if (rawUrl && !url) {
      return JSON.stringify({ success: false, error: 'URL must use https:// or http://' });
    }

    const userId = memberContext?.workos_user?.workos_user_id || slackUserId || 'unknown';
    const userName = memberContext?.workos_user?.first_name
      ? `${memberContext.workos_user.first_name} ${memberContext.workos_user.last_name || ''}`.trim()
      : memberContext?.slack_user?.display_name || undefined;

    try {
      const suggestion = await createSuggestion({
        newsletterId,
        suggestedByUserId: userId,
        suggestedByName: userName,
        title,
        url,
        description: reason,
        sourceChannel: slackUserId ? 'slack_dm' : 'web_chat',
      });

      const newsletterName = newsletterId === 'the_prompt' ? 'The Prompt' : 'The Build';
      logger.info({ suggestionId: suggestion.id, newsletterId, userId, title }, 'Newsletter suggestion created');

      return JSON.stringify({
        success: true,
        suggestion_id: suggestion.id,
        newsletter: newsletterName,
        title,
        message: `Suggestion recorded for ${newsletterName}. The editorial team will review it for the next edition.`,
      });
    } catch (err) {
      logger.error({ error: err, newsletterId, userId }, 'Failed to create newsletter suggestion');
      return JSON.stringify({ success: false, error: 'Failed to save suggestion' });
    }
  });

  return handlers;
}
