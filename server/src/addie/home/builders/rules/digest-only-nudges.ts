/**
 * Digest-only nudges: CTAs that only fire on the newsletter digest
 * surface and have no pull-surface equivalent. Live in their own array
 * because PromptRule's pull-surface fields are mandatory — these CTAs
 * don't need labels/prompts/priorities for the home, only the digest
 * facet.
 */

import type { DigestNudgeFacet } from './types.js';

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

export interface DigestOnlyNudge {
  id: string;
  digest: DigestNudgeFacet;
}

export const DIGEST_ONLY_NUDGES: DigestOnlyNudge[] = [
  // Strongest conversion: not a member and no Slack at all.
  {
    id: 'digest.become_member',
    digest: {
      priority: 1,
      when: (r) => !r.is_member && !r.has_slack,
      text: 'Join 1,300+ professionals building the future of agentic advertising.',
      ctaLabel: 'Become a member',
      ctaUrl: `${BASE_URL}/join`,
    },
  },
  // Member but missing Slack — get them into the live conversation.
  {
    id: 'digest.join_slack',
    digest: {
      priority: 2,
      when: (r) => r.is_member && !r.has_slack,
      text: 'The conversation happens in Slack — 400+ practitioners are there now.',
      ctaLabel: 'Join Slack',
      ctaUrl: `${BASE_URL}/join#slack`,
    },
  },
  // Contributor seat hasn't started cert yet — they're paying for the
  // contributor seat specifically to be listed in the registry.
  {
    id: 'digest.contributor_no_cert',
    digest: {
      priority: 5,
      when: (r) => r.seat_type === 'contributor' && r.cert_modules_completed === 0,
      text: 'Contributors who complete certification get listed in the registry.',
      ctaLabel: 'Start certification',
      ctaUrl: `${BASE_URL}/academy`,
    },
  },
];
