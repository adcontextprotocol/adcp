/**
 * Addie Portrait Tools
 *
 * Gives Addie the ability to offer portrait generation to members
 * conversationally. "Want me to create your portrait?" after membership
 * activation.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { MemberDatabase } from '../../db/member-db.js';
import * as portraitDb from '../../db/portrait-db.js';
import { VIBE_OPTIONS } from '../../services/portrait-generator.js';

const memberDb = new MemberDatabase();

const logger = createLogger('addie-portrait-tools');

export const PORTRAIT_TOOLS: AddieTool[] = [
  {
    name: 'check_portrait_status',
    description:
      'Check if the current member has an illustrated portrait, and whether they can generate one. Use this before offering portrait generation.',
    usage_hints:
      'use when a member asks about their portrait, or when you want to offer portrait generation after membership activation',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'offer_portrait_generation',
    description:
      'Explain the portrait generation feature to the member and provide a link to generate their portrait. ' +
      'Members upload a headshot and pick a vibe (at-my-desk, on-stage, in-a-studio, boardroom, casual). ' +
      'The result is an illustrated graphic novel portrait in amber/gold tones.',
    usage_hints:
      'use when a member expresses interest in getting a portrait, or proactively after they become a paid member',
    input_schema: {
      type: 'object' as const,
      properties: {
        context: {
          type: 'string',
          description: 'Why you are offering this (e.g., "new member activation", "member asked about it")',
        },
      },
      required: ['context'],
    },
  },
];

export function createPortraitToolHandlers(
  memberContext: MemberContext | null,
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('check_portrait_status', async () => {
    const orgId = memberContext?.organization?.workos_organization_id;
    if (!orgId) {
      return JSON.stringify({
        has_portrait: false,
        can_generate: false,
        reason: 'No member profile found. The user needs to create a member profile first.',
      });
    }

    try {
      const profile = await memberDb.getProfileByOrgId(orgId);
      if (!profile) {
        return JSON.stringify({
          has_portrait: false,
          can_generate: false,
          reason: 'No member profile found.',
        });
      }

      const profileId = profile.id;
      const active = await portraitDb.getActivePortrait(profileId);
      const pending = await portraitDb.getLatestGenerated(profileId);
      const monthlyCount = await portraitDb.countMonthlyGenerations(profileId);

      return JSON.stringify({
        has_portrait: !!active,
        portrait_url: active ? `/api/portraits/${active.id}.png` : null,
        has_pending: !!pending,
        generations_this_month: monthlyCount,
        can_generate: monthlyCount < 3,
        is_paid_member: memberContext.is_member,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to check portrait status');
      return JSON.stringify({ error: 'Failed to check portrait status' });
    }
  });

  handlers.set('offer_portrait_generation', async (input) => {
    const context = input.context as string;

    const vibeList = Object.entries(VIBE_OPTIONS)
      .map(([key, desc]) => `- **${key}**: ${desc}`)
      .join('\n');

    return JSON.stringify({
      message:
        'The member can generate their illustrated portrait at their profile page. ' +
        'They upload a headshot photo, pick a vibe setting, and get an illustrated ' +
        'graphic novel portrait in amber/gold tones — matching the AAO art style. ' +
        'The original photo is used only for reference and is never stored.',
      profile_url: '/community/profile/edit',
      vibe_options: vibeList,
      context,
    });
  });

  return handlers;
}
