import type { MemberContext } from '../../../member-context.js';

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
