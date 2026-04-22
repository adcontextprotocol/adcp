/**
 * Addie Illustration Tools
 *
 * Gives Addie the ability to generate editorial illustrations for
 * perspective articles conversationally. Authors describe the visual
 * they want; the system controls the style.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import * as illustrationDb from '../../db/illustration-db.js';
import { generateIllustration } from '../../services/illustration-generator.js';
import { checkToolRateLimit } from './tool-rate-limiter.js';

const logger = createLogger('addie-illustration-tools');

export const ILLUSTRATION_TOOLS: AddieTool[] = [
  {
    name: 'check_illustration_status',
    description:
      'Check if a perspective article has an editorial illustration and whether the author can generate one.',
    usage_hints:
      'use when an author asks about their article image, or after article publication',
    input_schema: {
      type: 'object' as const,
      properties: {
        perspective_slug: {
          type: 'string',
          description: 'The slug of the perspective article',
        },
      },
      required: ['perspective_slug'],
    },
  },
  {
    name: 'generate_perspective_illustration',
    description:
      'Generate an editorial illustration for a perspective article. ' +
      'The author describes what they want to see and the system generates a ' +
      'magazine-style illustration in the amber editorial palette. ' +
      'The author\'s portrait is automatically composited onto the final card.',
    usage_hints:
      'use when an author wants to create or update the illustration for their article. ' +
      'Guide the author to describe the visual concept — subject matter, mood, setting. ' +
      'The style (amber palette, editorial feel) is controlled by the system.',
    input_schema: {
      type: 'object' as const,
      properties: {
        perspective_slug: {
          type: 'string',
          description: 'The slug of the perspective article',
        },
        visual_description: {
          type: 'string',
          description: 'Author\'s description of what they want the illustration to depict',
        },
      },
      required: ['perspective_slug', 'visual_description'],
    },
  },
];

export function createIllustrationToolHandlers(
  memberContext: MemberContext | null,
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('check_illustration_status', async (input) => {
    const slug = input.perspective_slug as string;

    try {
      const perspective = await illustrationDb.getPerspectiveWithIllustration(slug);
      if (!perspective) {
        return JSON.stringify({ error: 'Perspective not found with that slug.' });
      }

      const hasIllustration = !!perspective.illustration_id;
      let pending = null;
      if (!hasIllustration) {
        pending = await illustrationDb.getLatestGenerated(perspective.id);
      }

      const userId = memberContext?.workos_user?.workos_user_id;
      let canGenerate = false;
      let monthlyCount = 0;
      if (userId) {
        monthlyCount = await illustrationDb.countMonthlyGenerations(userId);
        canGenerate = monthlyCount < 5;
      }

      return JSON.stringify({
        perspective_title: perspective.title,
        has_illustration: hasIllustration,
        illustration_url: hasIllustration
          ? `/api/perspectives/${slug}/card.png`
          : null,
        has_pending: !!pending,
        pending_preview: pending
          ? `/api/illustrations/${pending.id}/image.png`
          : null,
        can_generate: canGenerate,
        generations_this_month: monthlyCount,
        max_per_month: 5,
        is_logged_in: !!userId,
      });
    } catch (err) {
      logger.error({ err, slug }, 'Failed to check illustration status');
      return JSON.stringify({ error: 'Failed to check illustration status.' });
    }
  });

  handlers.set('generate_perspective_illustration', async (input) => {
    const slug = input.perspective_slug as string;
    const visualDescription = input.visual_description as string;

    const userId = memberContext?.workos_user?.workos_user_id;
    if (!userId) {
      return JSON.stringify({
        error: 'You need to be logged in to generate illustrations.',
      });
    }

    // Per-session tool rate limit (10/10min) — complements the existing
    // monthly per-user quota below. Bounds an automated loop that
    // stays under the monthly ceiling but still burns Gemini credits.
    const toolRate = checkToolRateLimit('generate_perspective_illustration', userId);
    if (!toolRate.ok) {
      const retrySeconds = Math.max(1, Math.ceil((toolRate.retryAfterMs ?? 60000) / 1000));
      return JSON.stringify({
        error: `Rate limit exceeded on generate_perspective_illustration. Try again in ~${retrySeconds} seconds.`,
      });
    }

    try {
      // Look up perspective and verify author BEFORE surfacing quota
      // state. Using different error strings for "not found", "not
      // author", and "over quota" would let a non-author probe for
      // existence of unpublished drafts by slug — see the security
      // review for #2794. Collapse "doesn't exist" and "not yours" to
      // one opaque response, and only reveal quota state to people
      // who actually have access to this perspective.
      const perspective = await illustrationDb.getPerspectiveWithIllustration(slug);
      const isAuthor = perspective
        ? await illustrationDb.isAuthorOfPerspective(perspective.id, userId)
        : false;
      if (!perspective || !isAuthor) {
        return JSON.stringify({ error: 'Perspective not found or you are not an author of it.' });
      }

      // Check monthly quota (5/month per user — separate from the
      // session-level 10/10min tool limit above).
      const monthlyCount = await illustrationDb.countMonthlyGenerations(userId);
      if (monthlyCount >= 5) {
        return JSON.stringify({
          error: 'You\'ve reached the monthly illustration limit (5 per month).',
          generations_this_month: monthlyCount,
        });
      }

      // Generate
      const { imageBuffer, promptUsed, c2pa } = await generateIllustration({
        title: perspective.title,
        category: perspective.category || undefined,
        authorDescription: visualDescription,
      });

      // Store
      const illustration = await illustrationDb.createIllustration({
        perspective_id: perspective.id,
        image_data: imageBuffer,
        prompt_used: promptUsed,
        author_description: visualDescription,
        status: 'generated',
        c2pa_signed_at: c2pa?.signedAt,
        c2pa_manifest_digest: c2pa?.manifestDigest,
      });

      // Auto-approve (the author generated it, they can see the preview)
      await illustrationDb.approveIllustration(illustration.id, perspective.id);

      return JSON.stringify({
        success: true,
        illustration_id: illustration.id,
        preview_url: `/api/illustrations/${illustration.id}/image.png`,
        card_url: `/api/perspectives/${slug}/card.png`,
        message:
          'Illustration generated and applied. The card image now shows your ' +
          'illustration with your portrait and article title composited on top. ' +
          'You can generate a new one if you want a different look (up to 5 per month).',
      });
    } catch (err) {
      logger.error({ err, slug }, 'Failed to generate illustration');
      return JSON.stringify({
        error: 'Failed to generate illustration. Please try again.',
      });
    }
  });

  return handlers;
}
