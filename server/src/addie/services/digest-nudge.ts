/**
 * Digest Nudge Picker
 *
 * Selects the single most relevant action for a newsletter recipient
 * based on their profile, engagement, and membership status.
 * Renders near the top of the email, right after the opening take.
 *
 * The CTA catalog lives in the suggested-prompts rule registry
 * (`server/src/addie/home/builders/rules/`). Cross-cut CTAs (cert,
 * working groups, profile completion) are defined there with both
 * `pull` (Addie home) and `digest` (this surface) facets, each with
 * its own typed `when` clause. Digest-only CTAs (membership, Slack
 * onboarding, contributor cert) live in `DIGEST_ONLY_NUDGES`.
 *
 * This picker just merges the two lists, filters by `digest.when`,
 * and returns the lowest-priority match. Surface-specific eligibility
 * stays in each facet — we don't try to share `when` clauses across
 * shapes (DigestEmailRecipient vs MemberContext are intentionally
 * different).
 */

import type { DigestEmailRecipient } from '../../db/digest-db.js';
import { MEMBER_RULES } from '../home/builders/rules/prompt-rules.js';
import { DIGEST_ONLY_NUDGES } from '../home/builders/rules/digest-only-nudges.js';
import type { DigestNudgeFacet, PromptRule } from '../home/builders/rules/types.js';

export interface DigestNudge {
  text: string;
  ctaLabel: string;
  ctaUrl: string;
}

type RuleWithDigest = PromptRule & { digest: DigestNudgeFacet };

interface DigestCandidate {
  id: string;
  facet: DigestNudgeFacet;
}

/**
 * All digest-eligible CTAs, sourced from both the cross-cut rule
 * registry (rules with a `digest` facet) and the digest-only list.
 *
 * Computed once at module load — both arrays are static.
 */
const ALL_DIGEST_CTAS: DigestCandidate[] = [
  ...DIGEST_ONLY_NUDGES.map((n) => ({ id: n.id, facet: n.digest })),
  ...MEMBER_RULES
    .filter((r): r is RuleWithDigest => !!r.digest)
    .map((r) => ({ id: r.id, facet: r.digest })),
];

export function pickNudge(recipient: DigestEmailRecipient): DigestNudge | null {
  // Lowest priority number wins. Ties are broken by `id` ascending so
  // ordering is deterministic across runs without relying on V8's
  // stable-sort guarantee.
  const matched = ALL_DIGEST_CTAS
    .filter((c) => c.facet.when(recipient))
    .sort((a, b) => a.facet.priority - b.facet.priority || a.id.localeCompare(b.id));

  const winner = matched[0];
  if (!winner) return null;

  const text = typeof winner.facet.text === 'function' ? winner.facet.text(recipient) : winner.facet.text;
  return {
    text,
    ctaLabel: winner.facet.ctaLabel,
    ctaUrl: winner.facet.ctaUrl,
  };
}
