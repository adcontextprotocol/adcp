import type { SuggestedPrompt } from '../types.js';
import type { MemberContext } from '../../member-context.js';
import { ADMIN_RULES, MEMBER_RULES } from './rules/prompt-rules.js';
import type { PromptRule } from './rules/types.js';

const MAX_PROMPTS = 4;

/**
 * Pick the top N rules to show this user. Returns both the rendered
 * prompts and the rule IDs so callers can record telemetry for the
 * suppression layer.
 */
export function pickPrompts(
  memberContext: MemberContext | null,
  isAdmin: boolean,
): { prompts: SuggestedPrompt[]; ruleIds: string[] } {
  const rules = isAdmin ? ADMIN_RULES : MEMBER_RULES;
  return evaluate(rules, { memberContext, isAdmin });
}

/**
 * Convenience wrapper for callers that only need the rendered prompts.
 */
export function buildSuggestedPrompts(
  memberContext: MemberContext | null,
  isAdmin: boolean,
): SuggestedPrompt[] {
  return pickPrompts(memberContext, isAdmin).prompts;
}

function evaluate(
  rules: PromptRule[],
  ctx: { memberContext: MemberContext | null; isAdmin: boolean },
): { prompts: SuggestedPrompt[]; ruleIds: string[] } {
  const now = Date.now();
  const telemetry = ctx.memberContext?.prompt_telemetry;

  const matched = rules
    .filter((r) => {
      // Skip suppressed rules first — cheap check, avoids running the
      // rule's predicate when we know we won't pick it anyway. Rules
      // with decay: false are exempt and never get suppressed.
      if (r.decay !== false) {
        const t = telemetry?.get(r.id);
        if (t?.suppressed_until && t.suppressed_until.getTime() > now) {
          return false;
        }
      }
      try {
        return r.when(ctx);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const seenLabels = new Set<string>();
  const picked: PromptRule[] = [];
  for (const rule of matched) {
    if (seenLabels.has(rule.label)) continue;
    seenLabels.add(rule.label);
    picked.push(rule);
    if (picked.length >= MAX_PROMPTS) break;
  }
  // Web home renders these in a 2-column grid; an odd count leaves a stray cell.
  if (picked.length % 2 !== 0) picked.pop();

  // ruleIds returned to callers excludes decay: false rules — those should
  // not be recorded in telemetry, since they're exempt from suppression.
  const prompts = picked.map((r) => ({ label: r.label, prompt: r.prompt }));
  const ruleIds = picked.filter((r) => r.decay !== false).map((r) => r.id);
  return { prompts, ruleIds };
}
