// ILLUSTRATION_TOOLS: the tool definitions of illustration-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

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
