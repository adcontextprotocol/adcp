import type { MemberContext } from '../../../member-context.js';
import type { DigestEmailRecipient } from '../../../../db/digest-db.js';

export interface PromptRuleContext {
  memberContext: MemberContext | null;
  isAdmin: boolean;
}

/**
 * A rule's display strings can be either static or a function of context.
 * Use functions when the prompt should reflect specific user state
 * (e.g. "Continue A1" instead of a generic "Continue certification").
 */
export type PromptString = string | ((ctx: PromptRuleContext) => string);

/**
 * The newsletter-digest facet of a rule. When present, this rule is a
 * candidate for the per-recipient nudge slot at the top of "The
 * Prompt" / "The Build" emails. Lower priority numbers win the slot.
 *
 * The digest's `when` clause is typed against `DigestEmailRecipient`
 * and is intentionally separate from the rule's pull-surface `when`
 * clause — the recipient shape is leaner than `MemberContext` and we
 * don't want lossy adapters in the middle. What we share is the
 * single CTA *catalog*, not the eligibility logic per surface.
 */
export interface DigestNudgeFacet {
  when: (recipient: DigestEmailRecipient) => boolean;
  /**
   * The pitch line. May be a function of the recipient when the copy
   * needs to reference specific user state (e.g. cert progress count).
   */
  text: string | ((recipient: DigestEmailRecipient) => string);
  ctaLabel: string;
  ctaUrl: string;
  priority: number;
}

export interface PromptRule {
  id: string;
  priority: number;
  when: (ctx: PromptRuleContext) => boolean;
  label: PromptString;
  prompt: PromptString;
  /**
   * When false, this rule is exempt from auto-suppression — it can fire
   * on every render even if the user has seen it many times. Use for
   * persona-anchored prompts where the user expects a stable entry
   * point rather than a one-time nudge.
   */
  decay?: boolean;
  /**
   * Optional override for click detection. Required for rules whose
   * `prompt` is a function — the static reverse-index can't represent
   * dynamic strings. Return true when the incoming user message looks
   * like a click on this rule.
   */
  matchClick?: (message: string) => boolean;
  /**
   * Optional newsletter-digest expression of this rule. When present,
   * this rule is a candidate for the digest nudge slot. Each surface
   * keeps its own `when` clause; only the CTA catalog is shared.
   */
  digest?: DigestNudgeFacet;
}

/**
 * Resolve a PromptString to its string value at evaluation time.
 */
export function resolvePromptString(
  s: PromptString,
  ctx: PromptRuleContext,
): string {
  return typeof s === 'function' ? s(ctx) : s;
}
