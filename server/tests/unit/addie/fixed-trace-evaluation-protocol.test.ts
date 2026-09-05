import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fixedTraceEstimatedCostUsd } from '../../../src/addie/eval/fixed-trace-budget.js';
import { FIXED_TRACE_PROTOCOL_PRICING, FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES, assertFixedTraceEvaluationProtocol, assertFixedTraceEvaluationProtocolTrusted, estimateFixedTraceEvaluationProtocol, fixedTraceEvaluationProtocolFingerprint, fixedTraceEvaluationProtocolRunnerBinding } from '../../../src/addie/eval/fixed-trace-evaluation-protocol.js';

function historicalOwnEnumerableFingerprint(value: unknown): string {
  const canonical = (current: unknown): string => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string' || typeof current === 'number') return JSON.stringify(current);
    if (Array.isArray(current)) return `[${current.map(canonical).join(',')}]`;
    if (typeof current === 'object') return `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${canonical((current as Record<string, unknown>)[key])}`).join(',')}}`;
    throw new Error('not JSON');
  };
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

describe('fixed-trace evaluation protocol projection', () => {
  it('is ordered, diagnostic-only, non-dispatchable, and non-promotional', () => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    assertFixedTraceEvaluationProtocol(protocol);
    expect(protocol.phases.map((phase) => phase.id)).toEqual(['bounded_smoke', 'router_screen', 'oracle_generator_ceiling', 'deployable_architecture', 'controlled_tuning']);
    expect(protocol.unavailableFinalTarget).toEqual({ availability: 'unavailable', uniqueCaseCount: 38, repetitions: 3, missingCaseCount: 38 });
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

  it('uses a detached closed snapshot for validation, hashing, and estimates', () => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    const expectedFingerprint = fixedTraceEvaluationProtocolFingerprint(protocol);
    const estimate = estimateFixedTraceEvaluationProtocol(protocol);
    protocol.phases[1].arms[0].stages[0].maxOutputTokensPerInvocation = 999;
    expect(estimate.stages.find((stage) => stage.phaseId === 'router_screen')?.outputTokenCeiling).toBe(46 * 3 * 300);
    expect(Object.isFrozen(estimate)).toBe(true);
    expect(Object.isFrozen(estimate.phases)).toBe(true);
    expect(expectedFingerprint).not.toBe(fixedTraceEvaluationProtocolFingerprint(protocol));

    const arrayExtra = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    arrayExtra.phases.extra = true;
    expect(() => assertFixedTraceEvaluationProtocol(arrayExtra)).toThrow('extra array property');
    let getterReads = 0;
    const accessor = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    Object.defineProperty(accessor, 'id', { enumerable: true, get() { getterReads += 1; return 'forged'; } });
    expect(() => assertFixedTraceEvaluationProtocol(accessor)).toThrow('own enumerable data');
    expect(getterReads).toBe(0);
    expect(() => assertFixedTraceEvaluationProtocol(new Proxy(protocol, {}))).toThrow('Proxy');
  });

  it('rejects inherited Anthropic-to-Google stage substitution before it can alter cost or a fingerprint', () => {
    const inheritedProtocol = (provider: 'anthropic' | 'google', model: string, pricingProfileId: string) => {
      const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
      const stage = protocol.phases[1].arms[0].stages[0];
      const { provider: ignoredProvider, model: ignoredModel, pricingProfileId: ignoredPricing, ...ownFields } = stage;
      void ignoredProvider; void ignoredModel; void ignoredPricing;
      protocol.phases[1].arms[0].stages[0] = Object.assign(Object.create({ provider, model, pricingProfileId }), ownFields);
      return protocol;
    };
    const anthropic = FIXED_TRACE_PROTOCOL_PRICING.find((profile) => profile.provider === 'anthropic' && profile.model === 'claude-haiku-4-5')!;
    const google = FIXED_TRACE_PROTOCOL_PRICING.find((profile) => profile.provider === 'google')!;
    const inheritedAnthropic = inheritedProtocol('anthropic', anthropic.model, anthropic.profileId);
    const inheritedGoogle = inheritedProtocol('google', google.model, google.profileId);
    expect(historicalOwnEnumerableFingerprint(inheritedGoogle)).toBe(historicalOwnEnumerableFingerprint(inheritedAnthropic));
    expect(fixedTraceEstimatedCostUsd({ inputTokens: 46 * 3 * 4_096, outputTokens: 46 * 3 * 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, google))
      .not.toBe(fixedTraceEstimatedCostUsd({ inputTokens: 46 * 3 * 4_096, outputTokens: 46 * 3 * 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, anthropic));
    expect(() => fixedTraceEvaluationProtocolFingerprint(inheritedAnthropic)).toThrow('plain object');
    expect(() => fixedTraceEvaluationProtocolFingerprint(inheritedGoogle)).toThrow('plain object');
  });
});
