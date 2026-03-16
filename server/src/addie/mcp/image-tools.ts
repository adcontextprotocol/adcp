/**
 * Addie Image Library Tools
 *
 * Gives Addie the ability to search for approved illustrations to use
 * in conversations. All search events are logged automatically for
 * analytics — what she searched for, what was returned, and whether
 * results were empty (gap detection).
 *
 * Usage tracking (which image she actually used) and gap requests
 * are derived from the existing tool execution logs in the Threads view
 * rather than requiring separate tools.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import * as imageDb from '../../db/addie-image-db.js';

const logger = createLogger('addie-image-tools');

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const IMAGE_TOOLS: AddieTool[] = [
  {
    name: 'search_image_library',
    description: 'Search the approved illustration library for images that match a topic or concept. Returns image URLs and alt text that you can include in your response. All searches are logged automatically.',
    usage_hints: 'use when explaining a concept visually, illustrating a walkthrough, or when a diagram would help understanding',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What you are looking for (e.g., "governance workflow", "media buy lifecycle", "creative formats")',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic tags to filter by (e.g., ["governance", "campaign-governance"])',
        },
        category: {
          type: 'string',
          enum: ['diagram', 'scene', 'walkthrough', 'concept'],
          description: 'Image category: diagram for technical/conceptual, scene for narrative illustrations',
        },
        intent: {
          type: 'string',
          description: 'Why you want this image (e.g., "explaining governance to a new member", "certification module A1")',
        },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// HANDLER CREATION
// ============================================================================

export function createImageToolHandlers(
  slackUserId?: string,
  threadId?: string
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('search_image_library', async (input) => {
    const searchQuery = input.query as string;
    const topics = input.topics as string[] | undefined;
    const category = input.category as string | undefined;
    const intent = input.intent as string | undefined;

    try {
      const images = await imageDb.searchImages(searchQuery, {
        topics,
        category,
        limit: 6,
      });

      // Log the search event
      await imageDb.logImageSearch({
        query: searchQuery,
        intent,
        context_type: threadId ? 'conversation' : 'general',
        thread_id: threadId,
        slack_user_id: slackUserId,
        results_returned: images.length,
        result_ids: images.map(i => i.id),
      });

      if (images.length === 0) {
        return JSON.stringify({
          results: [],
          message: 'No matching images found.',
        });
      }

      return JSON.stringify({
        results: images.map(img => ({
          id: img.id,
          url: img.image_url,
          alt: img.alt_text,
          category: img.category,
          topics: img.topics,
        })),
      });
    } catch (error) {
      logger.error({ error, searchQuery }, 'Failed to search image library');
      return JSON.stringify({ error: 'Failed to search image library' });
    }
  });

  return handlers;
}
