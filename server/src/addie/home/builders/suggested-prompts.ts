import type { SuggestedPrompt } from '../types.js';
import type { MemberContext } from '../../member-context.js';
import { ADMIN_RULES, MEMBER_RULES } from './rules/prompt-rules.js';
import type { PromptRule } from './rules/types.js';

const MAX_PROMPTS = 4;

export function buildSuggestedPrompts(
  memberContext: MemberContext | null,
  isAdmin: boolean
): SuggestedPrompt[] {
  if (isAdmin) {
    return evaluate(ADMIN_RULES, { memberContext, isAdmin });
  }
  return evaluate(MEMBER_RULES, { memberContext, isAdmin });
}

function evaluate(
  rules: PromptRule[],
  ctx: { memberContext: MemberContext | null; isAdmin: boolean }
): SuggestedPrompt[] {
  const matched = rules
    .filter((r) => {
      try {
        return r.when(ctx);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const seen = new Set<string>();
  const picked: SuggestedPrompt[] = [];
  for (const rule of matched) {
    if (seen.has(rule.label)) continue;
    seen.add(rule.label);
    picked.push({ label: rule.label, prompt: rule.prompt });
    if (picked.length >= MAX_PROMPTS) break;
  }
  // Web home renders these in a 2-column grid; an odd count leaves a stray cell.
  if (picked.length % 2 !== 0) picked.pop();
  return picked;
}
