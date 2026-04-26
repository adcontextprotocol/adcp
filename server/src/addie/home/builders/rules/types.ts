import type { MemberContext } from '../../../member-context.js';

export interface PromptRuleContext {
  memberContext: MemberContext | null;
  isAdmin: boolean;
}

export interface PromptRule {
  id: string;
  priority: number;
  when: (ctx: PromptRuleContext) => boolean;
  label: string;
  prompt: string;
  /**
   * When false, this rule is exempt from auto-suppression — it can fire
   * on every render even if the user has seen it many times. Use for
   * persona-anchored prompts where the user expects a stable entry
   * point rather than a one-time nudge.
   */
  decay?: boolean;
}
