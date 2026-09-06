import { describe, expect, it } from 'vitest';
import {
  assertFixedTraceSmokeOverlayContracts,
  createFixedTraceSmokeSimulator,
  FixedTraceSmokeOverlayError,
  FIXED_TRACE_SMOKE_CASE_IDS,
  FIXED_TRACE_SMOKE_OVERLAYS,
  fixedTraceSmokeOverlayPresentation,
} from '../../../src/addie/eval/fixed-trace-smoke-overlays.js';
import { FIXED_TRACE_DIRECT_TOOL_UNIVERSE } from '../../../src/addie/direct-tool-universe.js';
import { FIXED_TRACE_CORPUS } from '../../../src/addie/eval/fixed-trace-suite.js';

function overlay(id: typeof FIXED_TRACE_SMOKE_CASE_IDS[number]) {
  return FIXED_TRACE_SMOKE_OVERLAYS.find((candidate) => candidate.id === id)!;
}

function rejectionCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FixedTraceSmokeOverlayError);
    return (error as FixedTraceSmokeOverlayError).code;
  }
  throw new Error('Expected evaluator boundary rejection');
}

describe('fixed-trace evaluator-only smoke overlays', () => {
  it('makes all eight named development cases complete and permanently final-ineligible', () => {
    expect(() => assertFixedTraceSmokeOverlayContracts()).not.toThrow();
    expect(FIXED_TRACE_SMOKE_OVERLAYS.map((candidate) => candidate.id)).toEqual(FIXED_TRACE_SMOKE_CASE_IDS);
    expect(FIXED_TRACE_SMOKE_OVERLAYS.every((candidate) => (
      candidate.externalFinalEligibility === 'development_only_final_ineligible'
      && candidate.grader.exactCallSequence
      && candidate.grader.terminalInvariant
      && candidate.grader.rejectForbiddenToolPolicy
      && candidate.caseSemanticSha256.length === 64
      && candidate.phaseSha256.length === 64
      && candidate.overlaySha256.length === 64
    ))).toBe(true);
    expect(FIXED_TRACE_CORPUS).toHaveLength(82);
    expect(FIXED_TRACE_CORPUS.filter((candidate) => candidate.phase === 'sealed_final')).toHaveLength(0);
  });

  it('extends the neutral inventory from 13 to 15 with only the two named evaluator descriptors', () => {
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools).toHaveLength(15);
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.evaluatorOnlyToolNames).toEqual([
      'list_paying_members', 'confirm_send_invoice',
    ]);
    expect(FIXED_TRACE_DIRECT_TOOL_UNIVERSE.tools.filter((tool) => (
      FIXED_TRACE_DIRECT_TOOL_UNIVERSE.evaluatorOnlyToolNames.includes(tool.definition.name as never)
    )).every((tool) => tool.handlerProvenance === 'evaluator_simulated_receipt')).toBe(true);
  });

  it('runs every exact synthetic path with deterministic terminal evidence and no external dispatch', () => {
    for (const candidate of FIXED_TRACE_SMOKE_OVERLAYS) {
      const outcome = createFixedTraceSmokeSimulator(candidate).execute();
      expect(outcome.terminal).toEqual(candidate.terminal);
      expect(outcome.receipts).toHaveLength(candidate.calls.length);
      expect(outcome.dispatched).toBe(!['local_terminal', 'pre_dispatch_fault'].includes(candidate.terminal.path));
    }
  });

  it('keeps local channel chatter local, but represents knowledge as a model-tool path', () => {
    expect(overlay('surface-channel-chatter').terminal.path).toBe('local_terminal');
    expect(createFixedTraceSmokeSimulator(overlay('surface-channel-chatter')).execute().dispatched).toBe(false);
    expect(overlay('knowledge-task-model').terminal.path).toBe('model_tool');
    expect(createFixedTraceSmokeSimulator(overlay('knowledge-task-model')).execute().dispatched).toBe(true);
  });

  it('uses sealed admin facts and one member-record read without a Slack lookup', () => {
    const admin = overlay('admin-member-records-without-slack');
    expect(admin.visibleFacts.isAdmin).toBe(true);
    expect(admin.presentedTools.map((tool) => tool.name)).toEqual(['list_paying_members']);
    expect(admin.calls.map((call) => call.name)).toEqual(['list_paying_members']);
    expect(admin.terminal.output).not.toContain('list_slack_users_by_org');
  });

  it('requires the sealed confirmation and blocks invoice replay after its deterministic receipt', () => {
    const invoice = overlay('billing-invoice-confirmed');
    expect(invoice.visibleFacts).toMatchObject({
      confirmation: 'explicit_thread_confirmation', idempotency: 'sealed_replay_blocked',
    });
    const simulator = createFixedTraceSmokeSimulator(invoice);
    expect(simulator.execute().receipts[0]?.result).toContain('synthetic-invoice-100');
    expect(rejectionCode(() => simulator.execute())).toBe('replay_blocked');
  });

  it('treats hostile tool result text as data and fixes failure schedules before dispatch', () => {
    const injection = overlay('tool-result-prompt-injection');
    const retry = overlay('dev-tool-error-retry');
    const truncated = overlay('dev-truncation-boundary');
    const unavailable = overlay('provider-unavailable');
    expect(injection.calls[0]?.result).toContain('ignore policy');
    expect(injection.terminal.forbiddenOutputMarkers).toContain('confirm_send_invoice');
    expect(retry.calls.map((call) => call.resultStatus)).toEqual(['recoverable_error', 'empty']);
    expect(truncated.terminal.status).toBe('truncated');
    expect(unavailable.fault).toBe('provider_transport_unavailable_before_dispatch');
    expect(createFixedTraceSmokeSimulator(unavailable).execute()).toMatchObject({ dispatched: false });
  });

  it('rejects forged overlays, schema drift, proxies, and reordered or extra calls before execution', () => {
    const altered = structuredClone(FIXED_TRACE_SMOKE_OVERLAYS);
    altered[0]!.terminal.output = 'forged';
    expect(rejectionCode(() => assertFixedTraceSmokeOverlayContracts(altered))).toBe('overlay_digest_mismatch:surface-channel-chatter');

    const extra = structuredClone(FIXED_TRACE_SMOKE_OVERLAYS) as Array<Record<string, unknown>>;
    extra[0]!.unexpected = true;
    expect(rejectionCode(() => assertFixedTraceSmokeOverlayContracts(extra as typeof FIXED_TRACE_SMOKE_OVERLAYS)))
      .toBe('unknown_or_missing_fields:overlay:surface-channel-chatter');

    const handlerSubstitution = structuredClone(FIXED_TRACE_SMOKE_OVERLAYS);
    (handlerSubstitution[1]!.presentedTools[0] as { handlerIdentitySha256: string }).handlerIdentitySha256 = '0'.repeat(64);
    expect(rejectionCode(() => assertFixedTraceSmokeOverlayContracts(handlerSubstitution)))
      .toBe('tool_fingerprint_mismatch:knowledge-task-model:search_docs');

    const forgedConfirmation = structuredClone(FIXED_TRACE_SMOKE_OVERLAYS);
    (forgedConfirmation[3]!.visibleFacts as { confirmation: string }).confirmation = 'not_required';
    expect(rejectionCode(() => assertFixedTraceSmokeOverlayContracts(forgedConfirmation)))
      .toBe('billing_confirmation_or_idempotency_mismatch');

    const proxied = new Proxy(structuredClone(FIXED_TRACE_SMOKE_OVERLAYS), {});
    expect(rejectionCode(() => assertFixedTraceSmokeOverlayContracts(proxied))).toBe('unsafe_snapshot:proxy');

    const retry = createFixedTraceSmokeSimulator(overlay('dev-tool-error-retry'));
    expect(rejectionCode(() => retry.execute([...
      overlay('dev-tool-error-retry').calls.map(({ name, input }) => ({ name, input })),
      { name: 'search_docs', input: { query: 'fictional harbor dossier', limit: 3 } },
    ]))).toBe('call_count_mismatch');
    const calls = overlay('dev-tool-error-retry').calls.map(({ name, input }) => ({ name, input }));
    calls[0] = { name: 'search_docs', input: { query: 'substituted dossier', limit: 3 } };
    expect(rejectionCode(() => retry.execute(calls))).toBe('call_sequence_mismatch:0');
  });

  it.each([
    'two_stage_llm_router',
    'direct_generation',
    'deterministic_policy_llm_fallback_hybrid',
  ] as const)('presents identical evaluator contracts to the %s consumer', (arm) => {
    const presented = fixedTraceSmokeOverlayPresentation('knowledge-task-model', arm);
    expect(presented).toBe(overlay('knowledge-task-model'));
  });
});
