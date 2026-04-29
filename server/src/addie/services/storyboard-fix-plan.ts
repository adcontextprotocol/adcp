/**
 * Turn a `StoryboardStepHint` into a deterministic Diagnose / Locate /
 * Fix / Verify playbook a builder can act on.
 *
 * The runner already produces a one-line `hint.message`; what's lossy
 * about that string is the structured fields underneath it. Those name
 * *exactly* the contract violation, where it is, and what it would
 * take to fix — enough to write a concrete plan instead of asking the
 * LLM to infer one from prose.
 *
 * Pure functions: deterministic given identical input. Safe to call
 * regardless of the agent's response shape — the caller decides which
 * hints to format.
 */

import type {
  ContextValueRejectedHint,
  FormatMismatchHint,
  MissingRequiredFieldHint,
  MonotonicViolationHint,
  ShapeDriftHint,
  StoryboardStepHint,
} from '@adcp/sdk/testing';

export type {
  ContextValueRejectedHint,
  FormatMismatchHint,
  MissingRequiredFieldHint,
  MonotonicViolationHint,
  ShapeDriftHint,
  StoryboardStepHint,
};

export interface FixPlanInput {
  hint: StoryboardStepHint;
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

interface RenderCtx {
  current_step_id: string;
  current_task: string;
  surface: 'step' | 'full';
}

const MAX_VALUE_LEN = 80;
// Cap accepted-values at 5 per hint. Seller-controlled, so this is a
// prompt-injection budget — not a UX choice. Don't raise without
// thinking about the per-hint payload size a hostile seller can claim.
const MAX_ACCEPTED_VALUES = 5;
const MAX_REQUEST_FIELD_LEN = 120;
const MAX_ERROR_CODE_LEN = 64;
const MAX_TOOL_NAME_LEN = 80;
const MAX_PATH_LEN = 200;
const MAX_SCHEMA_PATH_LEN = 400;
const MAX_SCHEMA_URL_LEN = 300;
const MAX_VARIANT_LEN = 200;
// Tightened to 120 — the longest legitimate `expected_variant` literal
// in `shape-drift-hints.js` is ~70 chars. This is a runner-controlled
// field today; the cap is defense in depth in case future emitters
// pass through agent-influenced bytes.
const MAX_EXPECTED_VARIANT_LEN = 120;
const MAX_KEYWORD_LEN = 40;
const MAX_RESOURCE_TYPE_LEN = 60;
const MAX_RESOURCE_ID_LEN = 100;
const MAX_STATUS_LEN = 60;
const MAX_STEP_ID_LEN = 80;
const MAX_LEGAL_STATES_SHOWN = 8;
const MAX_MISSING_FIELDS_SHOWN = 10;

/**
 * Returns a multi-line markdown block for any hint kind the formatter
 * recognizes, or `null` for unknown future kinds (the runner's
 * `hint.message` still surfaces those at the caller's discretion).
 *
 * Trust model — the runner emits each hint kind from a different
 * detection path with different field provenance:
 *   - `context_value_rejected`: seller-controlled fields are
 *     `rejected_value`, `accepted_values[]`, `error_code`, AND
 *     `request_field` (the runner copies `errors[].field` from the
 *     seller's response verbatim — see rejection-hints.ts
 *     `findFieldPointer`). Storyboard-author-controlled: `context_key`,
 *     `source_step_id`, `source_task`, `response_path`. Runner-
 *     controlled enum: `source_kind`.
 *   - `shape_drift`: all fields runner-controlled (the `tool` is from
 *     storyboard YAML, the variant tokens are runner-defined enums,
 *     `instance_path` is structural).
 *   - `missing_required_field` / `format_mismatch`: `instance_path` can
 *     theoretically encode seller-chosen keys when `additionalProperties`
 *     allows them — defensive sanitization. `missing_fields[]`,
 *     `schema_path`, `keyword`, `schema_url`, `tool` are spec/runner
 *     controlled.
 *   - `monotonic_violation`: `resource_id`, `to_status`, AND `from_status`
 *     are seller-controlled. `to_status` and `resource_id` are read from
 *     the failing step's response; `from_status` is the previously-
 *     observed status the runner recorded from a *prior* step's seller
 *     response (see `default-invariants.js` `pushMediaBuy` /
 *     `pushCreative` etc.) — earlier-step seller, but still seller-emitted
 *     bytes. `from_step_id`, `legal_next_states[]`, `enum_url`, and
 *     `resource_type` are runner/storyboard controlled.
 *
 * Every string the formatter emits passes through `sanitizeAgentString`
 * regardless of provenance — defense in depth.
 */
export function renderHintFixPlan(input: FixPlanInput): string | null {
  const { hint, current_step_id, current_task, surface } = input;
  const ctx: RenderCtx = { current_step_id, current_task, surface };
  switch (hint.kind) {
    case 'context_value_rejected':
      return renderContextValueRejectedPlan(hint, ctx);
    case 'shape_drift':
      return renderShapeDriftPlan(hint, ctx);
    case 'missing_required_field':
      return renderMissingRequiredFieldPlan(hint, ctx);
    case 'format_mismatch':
      return renderFormatMismatchPlan(hint, ctx);
    case 'monotonic_violation':
      return renderMonotonicViolationPlan(hint, ctx);
    default:
      // Unknown future kind — let the upstream `hint.message` surface
      // through whatever caller is rendering it; we don't synthesize a
      // plan for a discriminator we don't understand.
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// context_value_rejected — catalog drift between two tools
// ────────────────────────────────────────────────────────────────────

function renderContextValueRejectedPlan(hint: ContextValueRejectedHint, ctx: RenderCtx): string {
  const { current_step_id, current_task, surface } = ctx;
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

// ────────────────────────────────────────────────────────────────────
// shape_drift — wrong response envelope
// ────────────────────────────────────────────────────────────────────

function renderShapeDriftPlan(hint: ShapeDriftHint, ctx: RenderCtx): string {
  const tool = sanitizeAgentString(hint.tool, MAX_TOOL_NAME_LEN);
  const observed = sanitizeAgentString(hint.observed_variant, MAX_VARIANT_LEN);
  const expected = sanitizeAgentString(hint.expected_variant, MAX_EXPECTED_VARIANT_LEN);
  const instancePath = sanitizeAgentString(hint.instance_path, MAX_PATH_LEN);

  const lines: string[] = [];
  lines.push(`💡 **Wire-shape drift detected.** Your \`${tool}\` response doesn't match the envelope the spec requires.`);
  lines.push('');
  lines.push(`**Diagnose** — observed: \`${observed}\`. Expected: \`${expected}\`.`);
  lines.push('');
  lines.push(
    `**Locate** — ${instancePath ? `at \`${instancePath}\` in the response` : `at the response root`}.`
  );
  lines.push('');
  lines.push(
    `**Fix** — reshape the response to match the expected envelope. \`@adcp/sdk/server\` ships typed ` +
      `response builders (e.g. \`listCreativesResponse\`, \`getMediaBuysResponse\`, \`buildCreativeResponse\`) — ` +
      `using one of those gives you the spec-correct shape from a single helper call and keeps the typing ` +
      `tight when the spec evolves.`
  );
  lines.push('');
  lines.push(verifyLine(ctx));

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// missing_required_field — strict required-keyword breach
// ────────────────────────────────────────────────────────────────────

function renderMissingRequiredFieldPlan(hint: MissingRequiredFieldHint, ctx: RenderCtx): string {
  const tool = sanitizeAgentString(hint.tool, MAX_TOOL_NAME_LEN);
  const path = sanitizeAgentString(hint.instance_path, MAX_PATH_LEN);
  const schemaPath = sanitizeAgentString(hint.schema_path, MAX_SCHEMA_PATH_LEN);
  const fields = hint.missing_fields
    .slice(0, MAX_MISSING_FIELDS_SHOWN)
    .map(f => sanitizeAgentString(f, 80));
  const overflow = hint.missing_fields.length - fields.length;
  const fieldsRepr =
    fields.map(f => `\`${f}\``).join(', ') + (overflow > 0 ? ` (and ${overflow} more)` : '');
  const schemaUrl = hint.schema_url ? sanitizeAgentString(hint.schema_url, MAX_SCHEMA_URL_LEN) : null;
  const plural = fields.length > 1 || overflow > 0;

  const lines: string[] = [];
  lines.push(`💡 **Required-field gap detected.** Your \`${tool}\` response is missing field${plural ? 's' : ''} the spec requires.`);
  lines.push('');
  lines.push(`**Diagnose** — missing required field${plural ? 's' : ''}: ${fieldsRepr}.`);
  lines.push('');
  lines.push(
    `**Locate** — at ${path ? `\`${path}\`` : 'the response root'}; the schema requirement is at ` +
      `\`${schemaPath}\`${schemaUrl ? ` (schema: \`${schemaUrl}\`)` : ''}.`
  );
  lines.push('');
  lines.push(
    `**Fix** — populate ${plural ? 'each missing field' : 'the missing field'} with a value matching ` +
      `the schema's type for it. The typed response builders in \`@adcp/sdk/server\` enforce the ` +
      `requirement at the type level, so emitting through one of those prevents this class of failure.`
  );
  lines.push('');
  lines.push(verifyLine(ctx));

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// format_mismatch — strict-only format / pattern / enum breach
// ────────────────────────────────────────────────────────────────────

function renderFormatMismatchPlan(hint: FormatMismatchHint, ctx: RenderCtx): string {
  const tool = sanitizeAgentString(hint.tool, MAX_TOOL_NAME_LEN);
  // Branch on the raw keyword for the runner-internal `'truncated'`
  // sentinel — it's runner-controlled, not seller-controlled, and
  // matching the post-sanitize value would silently miss a sentinel
  // that ever got non-ASCII or whitespace-flanked.
  if (hint.keyword === 'truncated') {
    const lines: string[] = [];
    lines.push(`💡 **Strict validation truncated.** \`${tool}\` produced more strict findings than this surface renders.`);
    lines.push('');
    lines.push(
      `**Diagnose** — the runner caps \`format_mismatch\` hints at 5 per validation to keep the per-step ` +
        `payload bounded. Your response triggered more.`
    );
    lines.push('');
    lines.push(
      `**Fix** — see \`strict_validation_summary\` on the run result for the full count, then run a ` +
        `strict validator locally to enumerate the issues. Cleaning the most common one usually ` +
        `surfaces the rest in the next run.`
    );
    lines.push('');
    lines.push(verifyLine(ctx));
    return lines.join('\n');
  }

  const keyword = sanitizeAgentString(hint.keyword, MAX_KEYWORD_LEN);
  const path = sanitizeAgentString(hint.instance_path, MAX_PATH_LEN);
  const schemaPath = sanitizeAgentString(hint.schema_path, MAX_SCHEMA_PATH_LEN);
  const schemaUrl = hint.schema_url ? sanitizeAgentString(hint.schema_url, MAX_SCHEMA_URL_LEN) : null;

  const lines: string[] = [];
  lines.push(`💡 **Strict format violation.** Your \`${tool}\` response has a value the lenient validator accepts but strict (AJV) rejects — the kind of thing a strict dispatcher would block in production.`);
  lines.push('');
  lines.push(
    `**Diagnose** — strict \`${keyword}\` keyword rejected at ${path ? `\`${path}\`` : 'the response root'}.`
  );
  lines.push('');
  lines.push(
    `**Locate** — schema names the constraint at \`${schemaPath}\`${schemaUrl ? ` (schema: \`${schemaUrl}\`)` : ''}.`
  );
  lines.push('');
  lines.push(`**Fix** — emit a value matching the constraint. Common cases:`);
  lines.push(`- \`format: date-time\` → ISO 8601 with timezone, e.g. \`2026-04-25T15:00:00Z\``);
  lines.push(`- \`format: uri\` → fully-formed URL with scheme + host`);
  lines.push(`- \`format: uuid\` → 8-4-4-4-12 hex with hyphens`);
  lines.push(`- \`pattern\` → see the regex in the schema`);
  lines.push(`- \`enum\` → pick from the schema's allowed list`);
  lines.push('');
  lines.push(verifyLine(ctx));

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// monotonic_violation — illegal lifecycle transition
// ────────────────────────────────────────────────────────────────────

function renderMonotonicViolationPlan(hint: MonotonicViolationHint, ctx: RenderCtx): string {
  const resourceType = sanitizeAgentString(hint.resource_type, MAX_RESOURCE_TYPE_LEN);
  // Seller-controlled — emitted from the seller's response payload.
  const resourceId = sanitizeAgentString(hint.resource_id, MAX_RESOURCE_ID_LEN);
  const fromStatus = sanitizeAgentString(hint.from_status, MAX_STATUS_LEN);
  // Seller-controlled — comes from the response under test. Defense in depth.
  const toStatus = sanitizeAgentString(hint.to_status, MAX_STATUS_LEN);
  const fromStepId = sanitizeAgentString(hint.from_step_id, MAX_STEP_ID_LEN);
  const enumUrl = sanitizeAgentString(hint.enum_url, MAX_SCHEMA_URL_LEN);
  const legal = hint.legal_next_states
    .slice(0, MAX_LEGAL_STATES_SHOWN)
    .map(s => sanitizeAgentString(s, MAX_STATUS_LEN));
  const overflow = hint.legal_next_states.length - legal.length;
  const isTerminal = hint.legal_next_states.length === 0;

  const lines: string[] = [];

  if (isTerminal) {
    lines.push(`💡 **Lifecycle violation: terminal state.** Your \`${resourceType}\` \`${resourceId}\` was \`${fromStatus}\` (a terminal state per the spec) and transitioned to \`${toStatus}\`.`);
    lines.push('');
    lines.push(
      `**Diagnose** — once a \`${resourceType}\` reaches \`${fromStatus}\`, no forward transitions are ` +
        `legal. The transition to \`${toStatus}\` violates the lifecycle graph.`
    );
    lines.push('');
    lines.push(`**Locate** — the previous status was set at step \`${fromStepId}\`. Lifecycle graph: \`${enumUrl}\`.`);
    lines.push('');
    lines.push(
      `**Fix** — either (a) don't transition the resource at all once it's \`${fromStatus}\`, or ` +
        `(b) avoid setting it to \`${fromStatus}\` in the first place if you intended to make ` +
        `further changes.`
    );
    lines.push('');
    lines.push(verifyLine(ctx));
    return lines.join('\n');
  }

  const legalRepr =
    legal.map(s => `\`${s}\``).join(', ') + (overflow > 0 ? ` (and ${overflow} more)` : '');

  lines.push(`💡 **Lifecycle violation detected.** Your \`${resourceType}\` \`${resourceId}\` transitioned \`${fromStatus}\` → \`${toStatus}\`, which isn't on the spec's lifecycle graph.`);
  lines.push('');
  lines.push(`**Diagnose** — from \`${fromStatus}\`, the only legal next states are: ${legalRepr}.`);
  lines.push('');
  lines.push(`**Locate** — the previous status was set at step \`${fromStepId}\`. Lifecycle graph: \`${enumUrl}\`.`);
  lines.push('');
  lines.push(
    `**Fix** — pick one of: ${legalRepr}. If \`${toStatus}\` should be reachable from \`${fromStatus}\`, ` +
      `that's a spec gap — file an issue against the lifecycle enum.`
  );
  lines.push('');
  lines.push(verifyLine(ctx));

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// shared
// ────────────────────────────────────────────────────────────────────

function verifyLine(ctx: RenderCtx): string {
  const { current_step_id, surface } = ctx;
  if (surface === 'step') {
    return (
      `**Verify** — re-run \`run_storyboard_step\` with \`step_id: "${current_step_id}"\` and the ` +
      `same context.`
    );
  }
  return (
    `**Verify** — re-run this storyboard. The failing step is \`${current_step_id}\`; the runner will ` +
    `pick up the new response shape on the next run.`
  );
}

/**
 * Strip newlines + control chars + backticks from any string that
 * originated from the tested agent before it lands in markdown the LLM
 * reads. Mirrors `sanitizeAgentField` in member-tools.ts; defined
 * locally so this module has no upstream coupling to that file.
 *
 * Strips ASCII C0 controls + backtick + DEL + Unicode line breaks
 * (NEL U+0085, LSEP U+2028, PSEP U+2029). The Unicode breaks aren't
 * matched by `\s+` in V8's default regex, and many LLM tokenizers treat
 * them as line breaks — leaving them in lets a U+2028 inside a string
 * fake a paragraph break inside what should be a single inline code
 * span.
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
 * hints (lets callers omit the section entirely). Hints whose `kind`
 * the formatter doesn't recognize are dropped silently — their
 * `hint.message` is the runner's documented fallback for unknown kinds.
 */
export function renderAllHintFixPlans(
  hints: StoryboardStepHint[] | undefined,
  ctx: { current_step_id: string; current_task: string; surface: 'step' | 'full' }
): string | null {
  if (!hints || !hints.length) return null;
  // Dedup keys: scoped per-kind so a duplicate `context_value_rejected`
  // (rare — runner already de-dupes) doesn't suppress an unrelated
  // `format_mismatch` that happens to share the same `kind` discriminator.
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const h of hints) {
    const key = dedupKey(h);
    if (seen.has(key)) continue;
    seen.add(key);
    const block = renderHintFixPlan({ hint: h, ...ctx });
    if (block !== null) blocks.push(block);
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

function dedupKey(h: StoryboardStepHint): string {
  switch (h.kind) {
    case 'context_value_rejected':
      return `cvr::${h.source_step_id}::${h.context_key}::${stableStringify(h.rejected_value)}`;
    case 'shape_drift':
      return `sd::${h.tool}::${h.observed_variant}::${h.instance_path}`;
    case 'missing_required_field':
      return `mrf::${h.tool}::${h.instance_path}::${h.missing_fields.join(',')}`;
    case 'format_mismatch':
      return `fm::${h.tool}::${h.instance_path}::${h.schema_path}::${h.keyword}`;
    case 'monotonic_violation':
      return `mv::${h.resource_type}::${h.resource_id}::${h.from_status}::${h.to_status}`;
    default:
      // Unknown kind — dedup by message alone so we don't multi-render
      // an identical fallback message.
      return `unknown::${(h as { message?: string }).message ?? ''}`;
  }
}

function stableStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'undefined';
  } catch {
    return String(v);
  }
}
