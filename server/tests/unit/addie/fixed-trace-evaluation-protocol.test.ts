import { describe, expect, it } from 'vitest';
import { FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES, assertFixedTraceEvaluationProtocol, assertFixedTraceEvaluationProtocolTrusted, estimateFixedTraceEvaluationProtocol, fixedTraceEvaluationProtocolRunnerBinding } from '../../../src/addie/eval/fixed-trace-evaluation-protocol.js';

describe('fixed-trace evaluation protocol projection', () => {
  it('is ordered, diagnostic-only, non-dispatchable, and non-promotional', () => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    assertFixedTraceEvaluationProtocol(protocol);
    expect(protocol.phases.map((phase) => phase.id)).toEqual(['bounded_smoke', 'router_screen', 'oracle_generator_ceiling', 'deployable_architecture', 'controlled_tuning', 'sealed_final']);
    expect(protocol.phases.every((phase) => phase.resultUse === 'diagnostic_only')).toBe(true);
    expect(estimateFixedTraceEvaluationProtocol(protocol)).toMatchObject({ dispatchable: false, expectedSpendUsd: null });
  });
  it('keeps Terra and Sol as unpriced inert descriptors', () => {
    expect(FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES).toEqual([{ provider: 'openai', model: 'gpt-5.6-terra', dispatchable: false, trustedPrice: null }, { provider: 'openai', model: 'gpt-5.6-sol', dispatchable: false, trustedPrice: null }]);
    const terra = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    terra.phases[1].arms[0].stages[0].provider = 'openai'; terra.phases[1].arms[0].stages[0].model = 'gpt-5.6-terra';
    expect(() => assertFixedTraceEvaluationProtocol(terra)).toThrow('pricing profile does not match');
  });
  it('rejects reversed, duplicated, direct, smoke-promotion, and fabricated trust', () => {
    const reversed = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL); reversed.phases.reverse();
    expect(() => assertFixedTraceEvaluationProtocol(reversed)).toThrow('exact required order');
    const direct = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL); direct.phases[3].arms[0].architecture = 'direct_bounded_production_shaped';
    expect(() => assertFixedTraceEvaluationProtocol(direct)).toThrow('direct and hybrid');
    const promotional = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any; promotional.phases[0].resultUse = 'promotional';
    expect(() => assertFixedTraceEvaluationProtocol(promotional)).toThrow();
    expect(() => assertFixedTraceEvaluationProtocolTrusted(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, () => ({}) as any)).toThrow('locked');
    expect(() => fixedTraceEvaluationProtocolRunnerBinding(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, () => ({}) as any, 'bounded_smoke', [])).toThrow('locked');
  });
});
