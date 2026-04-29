import { describe, it, expect } from 'vitest';
import {
  renderHintFixPlan,
  type ContextValueRejectedHint,
  type FormatMismatchHint,
  type MissingRequiredFieldHint,
  type MonotonicViolationHint,
  type ShapeDriftHint,
} from '../../src/addie/services/storyboard-fix-plan.js';

/**
 * Inline snapshots — capture the verbatim rendered output for the three
 * canonical scenarios. Reviewers should read the snapshots when
 * evaluating the conversational quality of the fix plan, not just the
 * field-level assertions in storyboard-fix-plan.test.ts.
 */

const catalogDriftHint: ContextValueRejectedHint = {
  kind: 'context_value_rejected',
  message: 'unused',
  context_key: 'pricing_option_id',
  source_step_id: 'search_by_spec',
  source_kind: 'context_outputs',
  response_path: 'signals[0].pricing_options[0].pricing_option_id',
  source_task: 'get_signals',
  rejected_value: 'po_prism_abandoner_cpm',
  request_field: 'packages[0].pricing_option_id',
  accepted_values: ['po_prism_cart_cpm'],
  error_code: 'INVALID_PRICING_MODEL',
};

describe('snapshot — canonical catalog drift, step surface', () => {
  it('renders the verbatim builder playbook', () => {
    const out = renderHintFixPlan({
      hint: catalogDriftHint,
      current_step_id: 'activate-signal',
      current_task: 'activate_signal',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Catalog drift detected.** This is the unique-to-AdCP diagnostic: a value your agent produced earlier was rejected by your agent later.

      **Diagnose** — \`get_signals\` advertised \`po_prism_abandoner_cpm\`, but \`activate_signal\` rejects it. The two tools' catalogs disagree.
      Seller's error code: \`INVALID_PRICING_MODEL\`.

      **Locate** — the rejected value comes from \`signals[0].pricing_options[0].pricing_option_id\` in step \`search_by_spec\`'s response; the runner injected it into \`packages[0].pricing_option_id\` of this \`activate_signal\` call.
      Seller's accepted values: \`po_prism_cart_cpm\`.

      **Fix** — pick the path that matches your business catalog:
      - **Widen \`activate_signal\`** — add \`po_prism_abandoner_cpm\` to the values it accepts, so it honors what \`get_signals\` advertises.
      - **Narrow \`get_signals\`** — stop returning \`po_prism_abandoner_cpm\` at \`signals[0].pricing_options[0].pricing_option_id\` so it's never advertised. Pick this when \`po_prism_abandoner_cpm\` shouldn't be a sellable option.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "activate-signal"\` and the same context. If you changed step \`search_by_spec\`, also re-run that step first to refresh context."
    `);
  });
});

describe('snapshot — convention extractor (no response_path)', () => {
  it('renders without claiming a response path it doesn\'t have', () => {
    const out = renderHintFixPlan({
      hint: {
        kind: 'context_value_rejected',
        message: 'unused',
        context_key: 'pricing_option_id',
        source_step_id: 'discover-signals',
        source_kind: 'convention',
        source_task: 'get_signals',
        rejected_value: 'po_abandoner',
        request_field: 'packages[0].pricing_option_id',
        accepted_values: ['po_cart'],
      },
      current_step_id: 'activate',
      current_task: 'activate_signal',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Catalog drift detected.** This is the unique-to-AdCP diagnostic: a value your agent produced earlier was rejected by your agent later.

      **Diagnose** — \`get_signals\` advertised \`po_abandoner\`, but \`activate_signal\` rejects it. The two tools' catalogs disagree.

      **Locate** — the rejected value was extracted by the AdCP convention extractor for \`get_signals\` (step \`discover-signals\`); the runner injected it into \`packages[0].pricing_option_id\` of this \`activate_signal\` call.
      Seller's accepted values: \`po_cart\`.

      **Fix** — pick the path that matches your business catalog:
      - **Widen \`activate_signal\`** — add \`po_abandoner\` to the values it accepts, so it honors what \`get_signals\` advertises.
      - **Narrow \`get_signals\`** — stop returning \`po_abandoner\` so it's never advertised. Pick this when \`po_abandoner\` shouldn't be a sellable option.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "activate"\` and the same context. If you changed step \`discover-signals\`, also re-run that step first to refresh context."
    `);
  });
});

describe('snapshot — same-tool inconsistency', () => {
  it('drops widen/narrow framing when source and current task are identical', () => {
    const out = renderHintFixPlan({
      hint: { ...catalogDriftHint, source_task: 'activate_signal' },
      current_step_id: 'activate-second',
      current_task: 'activate_signal',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Catalog drift detected.** This is the unique-to-AdCP diagnostic: a value your agent produced earlier was rejected by your agent later.

      **Diagnose** — \`activate_signal\` rejected the value \`po_prism_abandoner_cpm\`, but the same tool produced that value at step \`search_by_spec\`. Your tool's catalog disagrees with itself between calls.
      Seller's error code: \`INVALID_PRICING_MODEL\`.

      **Locate** — the rejected value comes from \`signals[0].pricing_options[0].pricing_option_id\` in step \`search_by_spec\`'s response; the runner injected it into \`packages[0].pricing_option_id\` of this \`activate_signal\` call.
      Seller's accepted values: \`po_prism_cart_cpm\`.

      **Fix** — pick the path that matches your business catalog:
      - Make \`activate_signal\` consistent with itself: either always accept \`po_prism_abandoner_cpm\` (if it should be sellable), or stop returning it from earlier responses.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "activate-second"\` and the same context. If you changed step \`search_by_spec\`, also re-run that step first to refresh context."
    `);
  });
});

describe('snapshot — shape_drift (bare array list_creatives)', () => {
  it('renders the wire-shape playbook', () => {
    const out = renderHintFixPlan({
      hint: {
        kind: 'shape_drift',
        message: 'unused',
        tool: 'list_creatives',
        observed_variant: 'bare_array',
        expected_variant: '{ creatives: [...] }',
        instance_path: '',
      } satisfies ShapeDriftHint,
      current_step_id: 'list-creatives',
      current_task: 'list_creatives',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Wire-shape drift detected.** Your \`list_creatives\` response doesn't match the envelope the spec requires.

      **Diagnose** — observed: \`bare_array\`. Expected: \`{ creatives: [...] }\`.

      **Locate** — at the response root.

      **Fix** — reshape the response to match the expected envelope. \`@adcp/sdk/server\` ships typed response builders (e.g. \`listCreativesResponse\`, \`getMediaBuysResponse\`, \`buildCreativeResponse\`) — using one of those gives you the spec-correct shape from a single helper call and keeps the typing tight when the spec evolves.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "list-creatives"\` and the same context."
    `);
  });
});

describe('snapshot — missing_required_field (multiple fields)', () => {
  it('renders the required-field playbook', () => {
    const out = renderHintFixPlan({
      hint: {
        kind: 'missing_required_field',
        message: 'unused',
        tool: 'list_creatives',
        instance_path: '',
        schema_path: '#/required',
        missing_fields: ['total_count', 'has_more'],
        schema_url: 'https://adcp/list-creatives-response.json',
      } satisfies MissingRequiredFieldHint,
      current_step_id: 'list-creatives',
      current_task: 'list_creatives',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Required-field gap detected.** Your \`list_creatives\` response is missing fields the spec requires.

      **Diagnose** — missing required fields: \`total_count\`, \`has_more\`.

      **Locate** — at the response root; the schema requirement is at \`#/required\` (schema: \`https://adcp/list-creatives-response.json\`).

      **Fix** — populate each missing field with a value matching the schema's type for it. The typed response builders in \`@adcp/sdk/server\` enforce the requirement at the type level, so emitting through one of those prevents this class of failure.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "list-creatives"\` and the same context."
    `);
  });
});

describe('snapshot — format_mismatch (uri format)', () => {
  it('renders the strict-format playbook with cheat sheet', () => {
    const out = renderHintFixPlan({
      hint: {
        kind: 'format_mismatch',
        message: 'unused',
        tool: 'list_creatives',
        instance_path: '/creatives/0/url',
        schema_path: '#/properties/creatives/items/properties/url',
        keyword: 'format',
        schema_url: 'https://adcp/list-creatives-response.json',
      } satisfies FormatMismatchHint,
      current_step_id: 'list-creatives',
      current_task: 'list_creatives',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Strict format violation.** Your \`list_creatives\` response has a value the lenient validator accepts but strict (AJV) rejects — the kind of thing a strict dispatcher would block in production.

      **Diagnose** — strict \`format\` keyword rejected at \`/creatives/0/url\`.

      **Locate** — schema names the constraint at \`#/properties/creatives/items/properties/url\` (schema: \`https://adcp/list-creatives-response.json\`).

      **Fix** — emit a value matching the constraint. Common cases:
      - \`format: date-time\` → ISO 8601 with timezone, e.g. \`2026-04-25T15:00:00Z\`
      - \`format: uri\` → fully-formed URL with scheme + host
      - \`format: uuid\` → 8-4-4-4-12 hex with hyphens
      - \`pattern\` → see the regex in the schema
      - \`enum\` → pick from the schema's allowed list

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "list-creatives"\` and the same context."
    `);
  });
});

describe('snapshot — monotonic_violation (illegal forward transition)', () => {
  it('renders the lifecycle playbook with legal alternatives', () => {
    const out = renderHintFixPlan({
      hint: {
        kind: 'monotonic_violation',
        message: 'unused',
        resource_type: 'media_buy',
        resource_id: 'mb_001',
        from_status: 'active',
        to_status: 'pending_creative',
        from_step_id: 'create_media_buy',
        legal_next_states: ['paused', 'completed', 'cancelled'],
        enum_url: 'https://adcp/enums/media-buy-status.json',
      } satisfies MonotonicViolationHint,
      current_step_id: 'update-media-buy',
      current_task: 'update_media_buy',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Lifecycle violation detected.** Your \`media_buy\` \`mb_001\` transitioned \`active\` → \`pending_creative\`, which isn't on the spec's lifecycle graph.

      **Diagnose** — from \`active\`, the only legal next states are: \`paused\`, \`completed\`, \`cancelled\`.

      **Locate** — the previous status was set at step \`create_media_buy\`. Lifecycle graph: \`https://adcp/enums/media-buy-status.json\`.

      **Fix** — pick one of: \`paused\`, \`completed\`, \`cancelled\`. If \`pending_creative\` should be reachable from \`active\`, that's a spec gap — file an issue against the lifecycle enum.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "update-media-buy"\` and the same context."
    `);
  });
});

describe('snapshot — monotonic_violation (terminal state)', () => {
  it('renders the terminal-state playbook', () => {
    const out = renderHintFixPlan({
      hint: {
        kind: 'monotonic_violation',
        message: 'unused',
        resource_type: 'media_buy',
        resource_id: 'mb_001',
        from_status: 'completed',
        to_status: 'active',
        from_step_id: 'finalize_media_buy',
        legal_next_states: [],
        enum_url: 'https://adcp/enums/media-buy-status.json',
      } satisfies MonotonicViolationHint,
      current_step_id: 'restart-media-buy',
      current_task: 'update_media_buy',
      surface: 'step',
    });
    expect(out).toMatchInlineSnapshot(`
      "💡 **Lifecycle violation: terminal state.** Your \`media_buy\` \`mb_001\` was \`completed\` (a terminal state per the spec) and transitioned to \`active\`.

      **Diagnose** — once a \`media_buy\` reaches \`completed\`, no forward transitions are legal. The transition to \`active\` violates the lifecycle graph.

      **Locate** — the previous status was set at step \`finalize_media_buy\`. Lifecycle graph: \`https://adcp/enums/media-buy-status.json\`.

      **Fix** — either (a) don't transition the resource at all once it's \`completed\`, or (b) avoid setting it to \`completed\` in the first place if you intended to make further changes.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "restart-media-buy"\` and the same context."
    `);
  });
});
