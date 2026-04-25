import { describe, it, expect } from 'vitest';
import {
  renderHintFixPlan,
  type ContextValueRejectedHint,
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
