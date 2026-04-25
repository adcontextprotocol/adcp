/**
 * Turn a `context_value_rejected` runner hint into a deterministic
 * Diagnose / Locate / Fix / Verify playbook a builder can act on.
 *
 * The runner already produces a one-line `hint.message`; what's lossy
 * about that string is the structured fields underneath it
 * (`source_step_id`, `source_task`, `response_path`, `request_field`,
 * `accepted_values`, ...). Those name *exactly* the two tools that
 * disagree and where the bad value came from — enough to write a
 * concrete fix plan instead of asking the LLM to infer one from prose.
 *
 * Pure function: deterministic given identical input. Safe to call
 * regardless of the agent's response shape — the caller decides which
 * hints to format.
 */

import type { ContextValueRejectedHint, StoryboardStepHint } from '@adcp/client/testing';

export type { ContextValueRejectedHint };

export interface FixPlanInput {
  hint: ContextValueRejectedHint;
  /** Step that just failed. From `StoryboardStepResult.step_id`. */
  current_step_id: string;
  /** AdCP task the failed step called. From `StoryboardStepResult.task`. */
  current_task: string;
  /**
   * `step` when produced for `run_storyboard_step` (caller can re-run a
   * single step), `full` for `run_storyboard` (no single-step verify
   * available — the whole run is the unit). Changes only the verify
   * line; the diagnosis is identical.
   */
  surface: 'step' | 'full';
}

const MAX_VALUE_LEN = 80;
// Cap accepted-values at 5 per hint. Seller-controlled, so this is a
// prompt-injection budget — not a UX choice. Don't raise without
// thinking about the per-hint payload size a hostile seller can claim.
const MAX_ACCEPTED_VALUES = 5;
const MAX_REQUEST_FIELD_LEN = 120;
const MAX_ERROR_CODE_LEN = 64;

/**
 * Returns a multi-line markdown block. The caller decides how to wrap
 * it (e.g., under a step's `**Error:**` line in the MCP tool output).
 *
 * Trust model — every string the formatter emits falls into one of:
 *   - Seller-controlled (the tested agent picks the bytes): `rejected_value`,
 *     `accepted_values[]`, `error_code`, AND `request_field`. The runner
 *     copies `errors[].field` from the seller's response verbatim onto
 *     `request_field` (see rejection-hints.ts `findFieldPointer`). All four
 *     pass through `sanitizeAgentString` before interpolation.
 *   - Storyboard-author-controlled (compliance cache YAML): `context_key`,
 *     `source_step_id`, `source_task`, `response_path`. These come from
 *     storyboards shipped with `@adcp/client` and are trusted bytes — they
 *     reach the LLM unsanitized.
 *   - Runner-controlled enum: `source_kind` (`'context_outputs' | 'convention'`).
 */
export function renderHintFixPlan(input: FixPlanInput): string {
  const { hint, current_step_id, current_task, surface } = input;
  const sourceTask = hint.source_task ?? null;
  const sourceStep = hint.source_step_id;
  const responsePath = hint.response_path;
  // Seller-controlled — the runner copies the seller's `errors[].field`
  // pointer here verbatim. Sanitize at the boundary.
  const requestField = hint.request_field
    ? sanitizeAgentString(hint.request_field, MAX_REQUEST_FIELD_LEN)
    : undefined;
  const sameTool = sourceTask !== null && sourceTask === current_task;

  const rejectedRepr = formatValue(hint.rejected_value);
  const acceptedRepr = formatAcceptedList(hint.accepted_values);
  const errorCode = hint.error_code ? sanitizeAgentString(hint.error_code, MAX_ERROR_CODE_LEN) : null;

  const lines: string[] = [];
  lines.push(`💡 **Catalog drift detected.** This is the unique-to-AdCP diagnostic: a value your agent produced earlier was rejected by your agent later.`);
  lines.push('');

  // Diagnose
  if (sameTool) {
    lines.push(
      `**Diagnose** — \`${current_task}\` rejected the value \`${rejectedRepr}\`, ` +
        `but the same tool produced that value at step \`${sourceStep}\`. ` +
        `Your tool's catalog disagrees with itself between calls.`
    );
  } else if (sourceTask) {
    lines.push(
      `**Diagnose** — \`${sourceTask}\` advertised \`${rejectedRepr}\`, but \`${current_task}\` ` +
        `rejects it. The two tools' catalogs disagree.`
    );
  } else {
    lines.push(
      `**Diagnose** — \`${current_task}\` rejected \`${rejectedRepr}\`, ` +
        `which step \`${sourceStep}\` had written into \`$context.${hint.context_key}\`. ` +
        `Whatever produced that context value disagrees with \`${current_task}\`.`
    );
  }
  if (errorCode) lines.push(`Seller's error code: \`${errorCode}\`.`);
  lines.push('');

  // Locate
  const locateBits: string[] = [];
  if (responsePath) {
    locateBits.push(
      `the rejected value comes from \`${responsePath}\` in step \`${sourceStep}\`'s response`
    );
  } else if (hint.source_kind === 'convention' && sourceTask) {
    locateBits.push(
      `the rejected value was extracted by the AdCP convention extractor for \`${sourceTask}\` ` +
        `(step \`${sourceStep}\`)`
    );
  } else {
    locateBits.push(`the rejected value was written by step \`${sourceStep}\``);
  }
  if (requestField) {
    locateBits.push(`the runner injected it into \`${requestField}\` of this \`${current_task}\` call`);
  } else {
    locateBits.push(`the runner injected it into the \`${current_task}\` request via \`$context.${hint.context_key}\``);
  }
  lines.push(`**Locate** — ${locateBits.join('; ')}.`);
  lines.push(`Seller's accepted values: ${acceptedRepr}.`);
  lines.push('');

  // Fix
  lines.push(`**Fix** — pick the path that matches your business catalog:`);
  if (sameTool) {
    lines.push(
      `- Make \`${current_task}\` consistent with itself: either always accept \`${rejectedRepr}\` ` +
        `(if it should be sellable), or stop returning it from earlier responses.`
    );
  } else if (sourceTask) {
    lines.push(
      `- **Widen \`${current_task}\`** — add \`${rejectedRepr}\` to the values it accepts, so it ` +
        `honors what \`${sourceTask}\` advertises.`
    );
    lines.push(
      `- **Narrow \`${sourceTask}\`** — stop returning \`${rejectedRepr}\`${responsePath ? ` at \`${responsePath}\`` : ''} ` +
        `so it's never advertised. Pick this when \`${rejectedRepr}\` shouldn't be a sellable option.`
    );
  } else {
    lines.push(
      `- Either widen \`${current_task}\` to accept \`${rejectedRepr}\`, or stop writing it into ` +
        `\`$context.${hint.context_key}\` from step \`${sourceStep}\`.`
    );
  }
  lines.push('');

  // Verify
  if (surface === 'step') {
    lines.push(
      `**Verify** — re-run \`run_storyboard_step\` with \`step_id: "${current_step_id}"\` and the ` +
        `same context. If you changed step \`${sourceStep}\`, also re-run that step first to ` +
        `refresh context.`
    );
  } else {
    lines.push(
      `**Verify** — re-run this storyboard. The failing step is \`${current_step_id}\`; if you ` +
        `changed step \`${sourceStep}\` instead, the runner will pick up the new context on the ` +
        `next run.`
    );
  }

  return lines.join('\n');
}

/**
 * Strip newlines + control chars + backticks from any string that
 * originated from the tested agent before it lands in markdown the LLM
 * reads. Mirrors `sanitizeAgentField` in member-tools.ts; defined
 * locally so this module has no upstream coupling to that file.
 */
function sanitizeAgentString(value: string, maxLen: number): string {
  return value
    .replace(/[\r\n`\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Render a rejected/accepted scalar so it reads naturally inside
 * backticks. Strings: sanitized + truncated. Numbers/booleans: raw.
 * Objects/arrays: JSON, truncated. `null`/`undefined`: literal labels
 * (the runner shouldn't emit these, but be defensive).
 */
function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return sanitizeAgentString(v, MAX_VALUE_LEN);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const json = JSON.stringify(v);
    return sanitizeAgentString(json ?? '', MAX_VALUE_LEN);
  } catch {
    return '<unrenderable>';
  }
}

function formatAcceptedList(values: unknown[]): string {
  if (!values.length) return '*(seller advertised an empty accepted-values list)*';
  const shown = values.slice(0, MAX_ACCEPTED_VALUES).map(v => `\`${formatValue(v)}\``);
  const overflow = values.length - MAX_ACCEPTED_VALUES;
  return overflow > 0 ? `${shown.join(', ')} (and ${overflow} more)` : shown.join(', ');
}

/**
 * Convenience: render every hint on a step result as fix plans, joined
 * by horizontal rules. Returns `null` when there are no actionable
 * hints (lets callers omit the section entirely).
 *
 * Accepts the broader `StoryboardStepHint[]` union the SDK now emits and
 * filters to `context_value_rejected` internally — other hint kinds
 * (shape_drift, missing_required_field, format_mismatch, monotonic_violation)
 * will get their own fix-plan templates as they're added; until then they're
 * silently dropped here.
 */
export function renderAllHintFixPlans(
  hints: StoryboardStepHint[] | undefined,
  ctx: { current_step_id: string; current_task: string; surface: 'step' | 'full' }
): string | null {
  if (!hints || !hints.length) return null;
  // Dedup on (source_step_id, context_key, rejected_value) — the runner's
  // detector already de-dupes by `(context_key, rejected_value)` per error
  // (rejection-hints.ts), but a single response may carry the same drift
  // through both the field-pointer and value-scan paths. Two near-identical
  // fix plans separated by a horizontal rule reads like a bug.
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const h of hints) {
    if (h.kind !== 'context_value_rejected') continue;
    const cvr = h as ContextValueRejectedHint;
    const key = `${cvr.source_step_id}::${cvr.context_key}::${stableStringify(cvr.rejected_value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(renderHintFixPlan({ hint: cvr, ...ctx }));
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

function stableStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'undefined';
  } catch {
    return String(v);
  }
}
