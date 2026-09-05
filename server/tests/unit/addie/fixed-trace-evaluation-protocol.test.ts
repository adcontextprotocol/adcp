import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { fixedTraceEstimatedCostUsd } from '../../../src/addie/eval/fixed-trace-budget.js';
import { FIXED_TRACE_ARCHITECTURE_ABLATION_CONTROL, FIXED_TRACE_CONFIRMATORY_POWER_GATE, FIXED_TRACE_PROTOCOL_PRICING, FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES, assertFixedTraceEvaluationProtocol, assertFixedTraceEvaluationProtocolTrusted, estimateFixedTraceEvaluationProtocol, evaluateFixedTraceConfirmatoryClaim, fixedTraceEvaluationProtocolFingerprint, fixedTraceEvaluationProtocolRunnerBinding } from '../../../src/addie/eval/fixed-trace-evaluation-protocol.js';
import { OPENAI_GPT_5_6_LUNA_PRICING_VERSION, resolveModelCostPricing } from '../../../src/addie/model-cost-pricing.js';
import { snapshotFixedTraceJson } from '../../../src/addie/eval/fixed-trace-safe-snapshot.js';

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
    expect(estimateFixedTraceEvaluationProtocol(protocol)).toMatchObject({
      dispatchable: false,
      expectedSpendUsd: null,
      budgetProjection: {
        screeningTuning: { uniqueEvaluableCaseCount: 120, approvalCeilingUsd: null },
        confirmatory: { requiredIndependentEvaluableCaseCount: 10_562, unavailableTargetCaseCount: 38, approvalCeilingUsd: null },
      },
    });
  });

  it('labels nominal 38-case margins inconclusive and does not treat repeated generations as independent cases', () => {
    expect(FIXED_TRACE_CONFIRMATORY_POWER_GATE.primaryHypothesisFamily).toEqual({
      size: 2, correction: 'holm', orderedOneSidedAlpha: [0.0125, 0.025],
    });
    expect(FIXED_TRACE_CONFIRMATORY_POWER_GATE.superiorityRequiredIndependentEvaluableCases).toBe(3_803);
    expect(FIXED_TRACE_CONFIRMATORY_POWER_GATE.nonInferiorityRequiredIndependentEvaluableCases).toBe(10_562);
    const nominalAt38 = evaluateFixedTraceConfirmatoryClaim({
      pairedCaseIds: Array.from({ length: 38 }, (_, index) => `case-${index + 1}`),
      observedSuperiorityPercentagePoints: 5.1,
      observedNonInferiorityPercentagePoints: -2.9,
    });
    expect(nominalAt38).toMatchObject({
      independentEvaluableCaseCount: 38,
      nominalMarginsReached: true,
      confirmatoryClaim: 'refused_underpowered',
    });

    const repeatedGenerations = evaluateFixedTraceConfirmatoryClaim({
      pairedCaseIds: Array.from({ length: 38 * 3 }, (_, index) => `case-${index % 38}`),
      observedSuperiorityPercentagePoints: 5.1,
      observedNonInferiorityPercentagePoints: -2.9,
    });
    expect(repeatedGenerations).toMatchObject({
      independentEvaluableCaseCount: 38,
      repeatedObservationCount: 76,
      requiredIndependentEvaluableCaseCount: 10_562,
      confirmatoryClaim: 'refused_underpowered',
    });
    expect(FIXED_TRACE_CONFIRMATORY_POWER_GATE.requiredAnalysis).toEqual({
      resampling: 'grouped_stratified_case_level_bootstrap',
      multiplicityCorrection: 'holm',
      pairedDiscordancePower: 'evaluator_owned_exact_paired_discordance_contract_unavailable',
      pairedDiscordanceTest: 'predeclared_exact_paired_test_required',
    });
  });
  it('locks a same-generator, provider-excluding, two-judge architecture ablation', () => {
    expect(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.find((item) => item.id === 'router_screen')?.arms.map((arm) => arm.stages[0] && [arm.stages[0].model, arm.stages[0].reasoningEffort]))
      .toEqual([['claude-haiku-4-5', 'provider_default'], ['gpt-5.6-luna', 'none']]);
    expect(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.find((item) => item.id === 'oracle_generator_ceiling')?.arms.map((arm) => arm.stages[0] && [arm.stages[0].model, arm.stages[0].reasoningEffort]))
      .toEqual([['claude-sonnet-5', 'provider_default'], ['claude-haiku-4-5', 'provider_default']]);
    const phase = FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.find((item) => item.id === 'deployable_architecture')!;
    expect(phase.arms.map((arm) => arm.id)).toEqual(['routed-haiku-sonnet', 'safe-hybrid-sonnet', 'bounded-direct-sonnet']);
    expect(phase.arms.map((arm) => arm.ablationControlId)).toEqual([FIXED_TRACE_ARCHITECTURE_ABLATION_CONTROL.id, FIXED_TRACE_ARCHITECTURE_ABLATION_CONTROL.id, FIXED_TRACE_ARCHITECTURE_ABLATION_CONTROL.id]);
    for (const arm of phase.arms) {
      const candidate = arm.stages.filter((stage) => stage.role !== 'judge');
      const judges = arm.stages.filter((stage) => stage.role === 'judge');
      expect(candidate.filter((stage) => stage.role === 'generation')).toEqual([expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-5', reasoningEffort: 'provider_default' })]);
      expect(new Set(candidate.map((stage) => stage.provider))).toEqual(new Set(['anthropic']));
      expect(judges.map((stage) => stage.provider)).toEqual(['openai', 'google']);
      expect(arm.lunaJudgeCalibration).toBe('requires_verified_luna_judge_calibration');
    }
    expect(phase.arms[1]?.admission).toBe('requires_verified_hybrid_contract');
    expect(phase.arms[2]?.admission).toBe('requires_verified_direct_contract');
    const estimate = estimateFixedTraceEvaluationProtocol(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    expect(estimate.phases.find((item) => item.phaseId === 'deployable_architecture')).toMatchObject({ judgeCalls: 46 * 3 * 3 * 2 });
    expect(estimate.judgeCeilingUsd).toBeGreaterThan(0);
    expect(estimate.screening.contingencyUsd).toBeGreaterThan(0);
    expect(estimate.screening.totalCeilingUsd).toBe(
      estimate.screening.candidateCeilingUsd + estimate.screening.judgeCeilingUsd + estimate.screening.contingencyUsd,
    );
    const selfJudging = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    selfJudging.phases[3].arms[0].stages[2].provider = 'anthropic';
    expect(() => assertFixedTraceEvaluationProtocol(selfJudging)).toThrow('evaluator-owned stage configuration matrix');
    const uncalibratedLuna = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    uncalibratedLuna.phases[3].arms[0].lunaJudgeCalibration = 'not_applicable';
    expect(() => assertFixedTraceEvaluationProtocol(uncalibratedLuna)).toThrow('evaluator-owned arm matrix');
  });
  it('keeps Terra and Sol as unpriced inert descriptors', () => {
    expect(FIXED_TRACE_UNSUPPORTED_OPENAI_CANDIDATES).toEqual([{ provider: 'openai', model: 'gpt-5.6-terra', dispatchable: false, trustedPrice: null }, { provider: 'openai', model: 'gpt-5.6-sol', dispatchable: false, trustedPrice: null }]);
    const terra = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    terra.phases[1].arms[0].stages[0].provider = 'openai'; terra.phases[1].arms[0].stages[0].model = 'gpt-5.6-terra';
    expect(() => assertFixedTraceEvaluationProtocol(terra)).toThrow('evaluator-owned stage configuration matrix');
  });
  it('reuses only the exact approved Luna provider, model, pricing, and control identity', () => {
    const luna = resolveModelCostPricing('openai', 'gpt-5.6-luna');
    expect(luna).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna', version: OPENAI_GPT_5_6_LUNA_PRICING_VERSION });
    expect(luna?.estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(1_400_000);
    expect(resolveModelCostPricing('openai', 'gpt-5.6-luna-20260826')).toBeNull();
    expect(resolveModelCostPricing('openai', 'gpt-5.6-terra')).toBeNull();
    expect(resolveModelCostPricing('openai', 'gpt-5.6-sol')).toBeNull();
  });
  it('rejects reversed, duplicated, direct, smoke-promotion, and fabricated trust', () => {
    const reversed = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL); reversed.phases.reverse();
    expect(() => assertFixedTraceEvaluationProtocol(reversed)).toThrow('exact required order');
    const direct = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL); direct.phases[3].arms[0].architecture = 'direct_bounded_production_shaped';
    expect(() => assertFixedTraceEvaluationProtocol(direct)).toThrow('evaluator-owned arm matrix');
    const promotional = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any; promotional.phases[0].resultUse = 'promotional';
    expect(() => assertFixedTraceEvaluationProtocol(promotional)).toThrow();
    expect(() => assertFixedTraceEvaluationProtocolTrusted(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, () => ({}) as any)).toThrow('locked');
    expect(() => fixedTraceEvaluationProtocolRunnerBinding(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL, () => ({}) as any, 'bounded_smoke', [])).toThrow('locked');
  });

  it('rejects the reported caller substitutions before estimating a budget', () => {
    const substituted = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    const phase = substituted.phases[0];
    phase.arms[0].admission = 'caller_promotional';
    phase.uniqueCaseCount = 1;
    phase.repetitions = 999;
    phase.arms[0].stages[0].maxInvocationsPerCase = 999;
    expect(() => estimateFixedTraceEvaluationProtocol(substituted)).toThrow('evaluator-owned');
  });

  it('rejects missing, extra, reordered, and substituted available phases', () => {
    const missing = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    missing.phases.splice(2, 1);
    expect(() => estimateFixedTraceEvaluationProtocol(missing)).toThrow('exact required order');

    const extra = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    extra.phases.push(structuredClone(extra.phases[0]));
    expect(() => estimateFixedTraceEvaluationProtocol(extra)).toThrow('exact required order');

    const reordered = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    [reordered.phases[0], reordered.phases[1]] = [reordered.phases[1], reordered.phases[0]];
    expect(() => estimateFixedTraceEvaluationProtocol(reordered)).toThrow('exact required order');

    const substituted = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
    substituted.phases[3].arms[1] = structuredClone(substituted.phases[3].arms[0]);
    expect(() => estimateFixedTraceEvaluationProtocol(substituted)).toThrow('evaluator-owned arm matrix');
  });

  it('enforces evaluator-owned admission, result use, counts, repetitions, and stop conditions for every phase', () => {
    for (let phaseIndex = 0; phaseIndex < FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.length; phaseIndex += 1) {
      for (const mutate of [
        (phase: any) => { phase.uniqueCaseCount = 1; },
        (phase: any) => { phase.repetitions = 999; },
        (phase: any) => { phase.resultUse = 'caller_promotional'; },
      ]) {
        const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
        mutate(protocol.phases[phaseIndex]);
        expect(() => estimateFixedTraceEvaluationProtocol(protocol)).toThrow('evaluator-owned phase matrix');
      }
      for (let armIndex = 0; armIndex < FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases[phaseIndex].arms.length; armIndex += 1) {
        const admission = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
        admission.phases[phaseIndex].arms[armIndex].admission = 'caller_promotional';
        expect(() => estimateFixedTraceEvaluationProtocol(admission)).toThrow('evaluator-owned arm matrix');
        for (let stageIndex = 0; stageIndex < FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases[phaseIndex].arms[armIndex].stages.length; stageIndex += 1) {
          const stopCondition = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
          stopCondition.phases[phaseIndex].arms[armIndex].stages[stageIndex].maxInvocationsPerCase = 999;
          expect(() => estimateFixedTraceEvaluationProtocol(stopCondition)).toThrow('evaluator-owned stage configuration matrix');
        }
      }
    }
  });

  it('prices only exact evaluator-owned provider, model, and execution configurations', () => {
    const profile = (provider: 'anthropic' | 'google', model: string) =>
      FIXED_TRACE_PROTOCOL_PRICING.find((candidate) => candidate.provider === provider && candidate.model === model)!;
    const haiku = profile('anthropic', 'claude-haiku-4-5');
    const sonnet = profile('anthropic', 'claude-sonnet-5');
    const gemini = profile('google', 'gemini-3.7-flash');
    const reject = (mutate: (stage: any) => void) => {
      const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
      mutate(protocol.phases[1].arms[0].stages[0]);
      expect(() => estimateFixedTraceEvaluationProtocol(protocol)).toThrow('evaluator-owned stage configuration matrix');
    };

    reject((stage) => { stage.provider = gemini.provider; stage.model = gemini.model; stage.pricingProfileId = gemini.profileId; });
    reject((stage) => { stage.model = sonnet.model; stage.pricingProfileId = sonnet.profileId; });
    reject((stage) => { stage.model = 'claude-haiku-4.5'; });
    reject((stage) => { stage.pricingProfileId = sonnet.profileId; });
    expect(haiku.profileId).not.toBe(gemini.profileId);

    for (let phaseIndex = 0; phaseIndex < FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases.length; phaseIndex += 1) {
      for (let armIndex = 0; armIndex < FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases[phaseIndex].arms.length; armIndex += 1) {
        for (let stageIndex = 0; stageIndex < FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL.phases[phaseIndex].arms[armIndex].stages.length; stageIndex += 1) {
          for (const mutate of [
            (stage: any) => { stage.reasoningEffort = stage.reasoningEffort === 'low' ? 'medium' : 'low'; },
            (stage: any) => { stage.maxInputTokensPerInvocation += 1; },
            (stage: any) => { stage.maxOutputTokensPerInvocation += 1; },
            (stage: any) => { stage.timeoutMs += 1; },
            (stage: any) => { stage.maxInvocationsPerCase += 1; },
            (stage: any) => { stage.transportRetries = 1; },
            (stage: any) => { stage.cacheMode = 'caller_cache'; },
            (stage: any) => { stage.samplingMode = 'caller_sampling'; },
            (stage: any) => { stage.temperature = 0; },
          ]) {
            const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
            mutate(protocol.phases[phaseIndex].arms[armIndex].stages[stageIndex]);
            expect(() => estimateFixedTraceEvaluationProtocol(protocol)).toThrow('evaluator-owned stage configuration matrix');
          }
        }
      }
    }
  });

  it('rejects missing, extra, reordered, duplicated, and hostile stage records before pricing', () => {
    const reject = (mutate: (protocol: any) => void, message = 'evaluator-owned stage configuration matrix') => {
      const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
      mutate(protocol);
      expect(() => estimateFixedTraceEvaluationProtocol(protocol)).toThrow(message);
    };
    reject((protocol) => { protocol.phases[0].arms[0].stages.pop(); });
    reject((protocol) => { protocol.phases[0].arms[0].stages.push(structuredClone(protocol.phases[0].arms[0].stages[0])); });
    reject((protocol) => { protocol.phases[0].arms[0].stages.reverse(); });
    reject((protocol) => { protocol.phases[0].arms[0].stages[1] = structuredClone(protocol.phases[0].arms[0].stages[0]); });

    reject((protocol) => {
      const stage = protocol.phases[1].arms[0].stages[0];
      const { provider: ignoredProvider, ...own } = stage;
      void ignoredProvider;
      protocol.phases[1].arms[0].stages[0] = Object.assign(Object.create({ provider: 'google' }), own);
    }, 'plain object');
    reject((protocol) => {
      Object.defineProperty(protocol.phases[1].arms[0].stages[0], 'provider', {
        enumerable: true,
        get() { return 'google'; },
      });
    }, 'own enumerable data');
    reject((protocol) => { protocol.phases[1].arms[0].stages[0] = new Proxy(protocol.phases[1].arms[0].stages[0], {}); }, 'Proxy');
    reject((protocol) => { Object.setPrototypeOf(protocol.phases[1].arms[0].stages[0], { provider: 'google' }); }, 'plain object');
    reject((protocol) => {
      Object.defineProperty(protocol.phases[1].arms[0].stages[0], '__proto__', { enumerable: true, value: { poisoned: true } });
    }, 'dangerous prototype key');
  });

  it('keeps prototype-shaped JSON as visible data and rejects it at every protocol fingerprint boundary', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    const detached = snapshotFixedTraceJson(hostile, 'hostile JSON') as Record<string, unknown>;
    expect(Object.getPrototypeOf(detached)).toBe(null);
    expect(Object.keys(detached)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(detached, '__proto__')?.value).toEqual({ polluted: true });
    expect(JSON.stringify(detached)).toBe('{"__proto__":{"polluted":true}}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL) as any;
      Object.defineProperty(protocol, key, { enumerable: true, value: { poisoned: true } });
      expect(() => fixedTraceEvaluationProtocolFingerprint(protocol)).toThrow('dangerous prototype key');
    }
  });

  it('rejects inherited keys, symbols, accessors, Proxies, array extras, and cycles without mutating the snapshot', () => {
    const inherited = Object.create({ inherited: true });
    expect(() => snapshotFixedTraceJson(inherited, 'inherited')).toThrow('plain object');

    const symbol = { safe: true };
    Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true });
    expect(() => snapshotFixedTraceJson(symbol, 'symbol')).toThrow('without symbols');

    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'value', { enumerable: true, get() { reads += 1; return true; } });
    expect(() => snapshotFixedTraceJson(accessor, 'accessor')).toThrow('own enumerable data');
    expect(reads).toBe(0);
    expect(() => snapshotFixedTraceJson(new Proxy({}, {}), 'proxy')).toThrow('Proxy');

    const arrayExtra: any[] & { extra?: boolean } = [true];
    arrayExtra.extra = true;
    expect(() => snapshotFixedTraceJson(arrayExtra, 'array extra')).toThrow('extra array property');

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => snapshotFixedTraceJson(cycle, 'cycle')).toThrow('cycle');

    const mutable = { nested: { value: 1 } };
    const detached = snapshotFixedTraceJson(mutable, 'mutable') as { nested: { value: number } };
    mutable.nested.value = 2;
    expect(detached.nested.value).toBe(1);
    expect(Object.isFrozen(detached)).toBe(true);
    expect(Object.isFrozen(detached.nested)).toBe(true);
  });

  it('uses a detached closed snapshot for validation, hashing, and estimates', () => {
    const protocol = structuredClone(FIXED_TRACE_PROPOSED_EVALUATION_PROTOCOL);
    const expectedFingerprint = fixedTraceEvaluationProtocolFingerprint(protocol);
    const estimate = estimateFixedTraceEvaluationProtocol(protocol);
    protocol.phases[1].arms[0].stages[0].maxOutputTokensPerInvocation = 999;
    expect(estimate.stages.find((stage) => stage.phaseId === 'router_screen')?.outputTokenCeiling).toBe(46 * 3 * 300);
    expect(Object.isFrozen(estimate)).toBe(true);
    expect(Object.isFrozen(estimate.phases)).toBe(true);
    expect(expectedFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => fixedTraceEvaluationProtocolFingerprint(protocol)).toThrow('evaluator-owned stage configuration matrix');

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
