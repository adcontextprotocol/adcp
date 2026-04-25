/**
 * End-to-end: real `@adcp/client` runner emits a `context_value_rejected`
 * hint, our formatter renders the verbatim fix plan.
 *
 * Drives the full `runAgainstLocalAgent` loop — `createAdcpServer` with
 * a deliberately-broken signals catalog, real HTTP MCP transport, the
 * runner's hint detector — and asserts that the structured hint reaches
 * `renderAllHintFixPlans` and produces the Diagnose / Locate / Fix /
 * Verify playbook a builder can act on.
 *
 * If `@adcp/client`'s hint emission ever silently regresses (e.g. the
 * detector stops firing, the StoryboardStepResult contract drops the
 * `hints` field, or runAgainstLocalAgent re-shapes the result), this
 * test fails before the regression reaches Addie.
 */
import { describe, it, expect } from 'vitest';
import { runAgainstLocalAgent } from '@adcp/client/testing';
import { createAdcpServer } from '@adcp/client/server';
import type { Storyboard } from '@adcp/client/testing';
import { renderAllHintFixPlans } from '../../src/addie/services/storyboard-fix-plan.js';

/**
 * Two-step storyboard: discover → activate. Step 1 writes
 * `first_signal_pricing_option_id` via `context_outputs`; step 2
 * sends it; the broken seller rejects with an `available[]` list
 * that points at a *different* pricing_option_id. Identical shape to
 * the canonical adcp-client#870 reporter case.
 *
 * Cast through `unknown` because we authored a minimal inline fixture
 * — `Storyboard`'s required-field surface is much wider than what the
 * runner actually consumes for a two-step signals case.
 */
const storyboard = {
  id: 'addie_rejection_hint_e2e',
  version: '1.0.0',
  title: 'Addie rejection hints E2E',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'p1',
      title: 'discover → activate',
      steps: [
        {
          id: 'search_by_spec',
          title: 'discover signals',
          task: 'get_signals',
          sample_request: {
            signal_spec: 'bogus',
            destinations: [{ type: 'platform', platform: 'the-trade-desk' }],
          },
          context_outputs: [
            { key: 'first_signal_id', path: 'signals[0].signal_agent_segment_id' },
            {
              key: 'first_signal_pricing_option_id',
              path: 'signals[0].pricing_options[0].pricing_option_id',
            },
          ],
        },
        {
          id: 'activate',
          title: 'activate signal',
          task: 'activate_signal',
          sample_request: {
            signal_agent_segment_id: '$context.first_signal_id',
            pricing_option_id: '$context.first_signal_pricing_option_id',
            destinations: [{ type: 'platform', platform: 'the-trade-desk' }],
          },
        },
      ],
    },
  ],
} as unknown as Storyboard;

const searchResponse = {
  signals: [
    {
      signal_id: { source: 'catalog', data_provider_domain: 'prism.example', id: 'abandoner' },
      signal_agent_segment_id: 'sig_prism_abandoner',
      name: 'PRISM abandoner audience',
      description: 'Users who abandoned checkout in the last 30 days.',
      signal_type: 'marketplace',
      data_provider: 'PRISM Data Co.',
      coverage_percentage: 42,
      deployments: [{ type: 'platform', platform: 'the-trade-desk', is_live: true }],
      pricing_options: [
        {
          pricing_option_id: 'po_prism_abandoner_cpm',
          model: 'cpm',
          cpm: 3.5,
          currency: 'USD',
        },
      ],
    },
  ],
};

/**
 * The catalog drift: `activate_signal` only accepts `po_prism_cart_cpm`,
 * but `get_signals` advertised `po_prism_abandoner_cpm`. Same symptom
 * the rejection-hints feature was built to surface.
 */
const activateRejection = {
  errors: [
    {
      code: 'INVALID_PRICING_MODEL',
      message: 'Pricing option not found: po_prism_abandoner_cpm',
      field: 'pricing_option_id',
      details: { available: ['po_prism_cart_cpm'] },
    },
  ],
};

function createBrokenSignalsAgent() {
  return createAdcpServer({
    name: 'Addie hint e2e — broken signals seller',
    version: '0.0.1',
    // Both directions off: the success response and the rejection
    // envelope are intentionally hand-shaped to exercise the hint
    // detector, not to satisfy the strict Zod surface.
    validation: { requests: 'off', responses: 'off' },
    signals: {
      getSignals: async () => searchResponse,
      activateSignal: async () => ({
        content: [{ type: 'text', text: 'Rejected: pricing option mismatch' }],
        structuredContent: activateRejection,
        isError: true,
      }),
    },
  });
}

describe('e2e: real runner → formatter — context_value_rejected fix plan', () => {
  it('the runner emits a hint that names both tools, and the formatter renders the playbook', async () => {
    const result = await runAgainstLocalAgent({
      createAgent: () => createBrokenSignalsAgent(),
      storyboards: [storyboard],
      fixtures: false,
      webhookReceiver: false,
    });

    expect(result.results).toHaveLength(1);
    const sb = result.results[0]!;
    const steps = sb.phases[0]!.steps;
    expect(steps).toHaveLength(2);

    const search = steps.find(s => s.step_id === 'search_by_spec')!;
    expect(search.passed).toBe(true);

    const activate = steps.find(s => s.step_id === 'activate')!;
    expect(activate.passed).toBe(false);

    // Runner-side contract: hints[] is populated on the failing step.
    expect(activate.hints).toBeDefined();
    expect(activate.hints!.length).toBeGreaterThan(0);
    const hint = activate.hints!.find(h => h.kind === 'context_value_rejected')!;
    expect(hint).toBeDefined();
    expect(hint.context_key).toBe('first_signal_pricing_option_id');
    expect(hint.source_step_id).toBe('search_by_spec');
    expect(hint.source_kind).toBe('context_outputs');
    expect(hint.response_path).toBe('signals[0].pricing_options[0].pricing_option_id');
    expect(hint.source_task).toBe('get_signals');
    expect(hint.rejected_value).toBe('po_prism_abandoner_cpm');
    expect(hint.accepted_values).toEqual(['po_prism_cart_cpm']);
    expect(hint.error_code).toBe('INVALID_PRICING_MODEL');

    // Formatter contract: feed the runner-emitted hint through, get the
    // verbatim builder playbook out.
    const fixPlan = renderAllHintFixPlans(activate.hints, {
      current_step_id: activate.step_id,
      current_task: activate.task,
      surface: 'step',
    });
    expect(fixPlan).not.toBeNull();
    expect(fixPlan).toContain('💡 **Catalog drift detected.**');
    expect(fixPlan).toContain('`get_signals` advertised `po_prism_abandoner_cpm`');
    expect(fixPlan).toContain('`activate_signal` rejects it');
    expect(fixPlan).toContain('`signals[0].pricing_options[0].pricing_option_id`');
    expect(fixPlan).toContain('`po_prism_cart_cpm`');
    expect(fixPlan).toContain('**Widen `activate_signal`**');
    expect(fixPlan).toContain('**Narrow `get_signals`**');
    expect(fixPlan).toContain('"activate"'); // verify call cites the failing step id
    expect(fixPlan).toContain('search_by_spec'); // verify call mentions the source step

    // The verbatim render — captured here so reviewers can read what a
    // builder will actually see when the broken-catalog drift fires
    // through real MCP transport (not synthesized from hand-written
    // hint fixtures like the snapshot suite).
    expect(fixPlan).toMatchInlineSnapshot(`
      "💡 **Catalog drift detected.** This is the unique-to-AdCP diagnostic: a value your agent produced earlier was rejected by your agent later.

      **Diagnose** — \`get_signals\` advertised \`po_prism_abandoner_cpm\`, but \`activate_signal\` rejects it. The two tools' catalogs disagree.
      Seller's error code: \`INVALID_PRICING_MODEL\`.

      **Locate** — the rejected value comes from \`signals[0].pricing_options[0].pricing_option_id\` in step \`search_by_spec\`'s response; the runner injected it into \`pricing_option_id\` of this \`activate_signal\` call.
      Seller's accepted values: \`po_prism_cart_cpm\`.

      **Fix** — pick the path that matches your business catalog:
      - **Widen \`activate_signal\`** — add \`po_prism_abandoner_cpm\` to the values it accepts, so it honors what \`get_signals\` advertises.
      - **Narrow \`get_signals\`** — stop returning \`po_prism_abandoner_cpm\` at \`signals[0].pricing_options[0].pricing_option_id\` so it's never advertised. Pick this when \`po_prism_abandoner_cpm\` shouldn't be a sellable option.

      **Verify** — re-run \`run_storyboard_step\` with \`step_id: "activate"\` and the same context. If you changed step \`search_by_spec\`, also re-run that step first to refresh context."
    `);
  }, 30_000);
});
