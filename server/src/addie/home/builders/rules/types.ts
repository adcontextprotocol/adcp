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
}
