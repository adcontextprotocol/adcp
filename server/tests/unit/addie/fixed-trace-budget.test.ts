import { describe, expect, it, vi } from 'vitest';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  FixedTraceBudgetAdmissionError,
  fixedTraceDirectFullSuiteResponsePricingPolicy,
  fixedTraceEstimatedCostUsd,
  fixedTraceApprovedPricingProfiles,
  fixedTraceResponseUsesPricingPolicy,
  fixedTraceResponsePricingPolicy,
  fixedTraceSettlementDiagnosticCursor,
  fixedTraceSettlementDiagnosticLedger,
} from '../../../src/addie/eval/fixed-trace-budget.js';
import { datedPricingProfilesForFixedTrace } from '../../../src/addie/eval/dated-pricing-cohort.js';
import { collectModelResponse } from '../../../src/addie/model-providers/events.js';
import type {
  ModelProvider,
  ModelProviderCapabilities,
  ModelRequest,
  ModelRespondOptions,
  ModelResponse,
  NormalizedModelEvent,
  PreparedModelInvocation,
} from '../../../src/addie/model-providers/model-provider.js';

const CAPABILITIES: ModelProviderCapabilities = {
  streaming: false,
  structuredOutput: false,
  reasoning: false,
  reasoningEfforts: [],
  customTools: false,
  providerWebSearch: false,
  imageInput: false,
  documentInput: false,
};

const REQUEST: ModelRequest = {
  model: 'gpt-5.6-luna',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic request.' }] }],
  tools: [],
  maxOutputTokens: 100,
};

const RESPONSE: ModelResponse = {
  provider: 'openai',
  model: 'gpt-5.6-luna',
  id: 'response-1',
  content: [{ type: 'text', text: 'Synthetic response.' }],
  finishReason: 'stop',
  providerFinishReason: 'completed',
  usage: { inputTokens: 10, outputTokens: 5 },
};

const DATED_PROFILES = datedPricingProfilesForFixedTrace();
const PRICING = DATED_PROFILES.find((profile) => profile.candidateId === 'openai-router-generator')!;

const RESPONSE_PRICING_POLICY = fixedTraceResponsePricingPolicy(
  'openai',
  'gpt-5.6-luna',
  PRICING,
);

const SONNET_5_PRICING = DATED_PROFILES.find((profile) => profile.candidateId === 'anthropic-generation')!;
const HAIKU_4_5_PRICING = DATED_PROFILES.find((profile) => profile.candidateId === 'anthropic-router')!;
const GOOGLE_PRICING = DATED_PROFILES.find((profile) => profile.candidateId === 'google-router-generator')!;

class BudgetScriptedProvider implements ModelProvider {
  readonly id = 'openai' as const;
  readonly capabilities = CAPABILITIES;
  readonly dispatches = vi.fn();

  constructor(private readonly script: Array<ModelResponse | Error>) {}

  prepare(request: ModelRequest): PreparedModelInvocation {
    return {
      provider: this.id,
      model: request.model,
      capabilities: this.capabilities,
      providerRequest: { model: request.model, input: request.messages },
    };
  }

  async *respond(
    request: ModelRequest,
    options: ModelRespondOptions = {},
  ): AsyncIterable<NormalizedModelEvent> {
    await options.beforeDispatch?.(this.prepare(request));
    this.dispatches();
    const next = this.script.shift();
    if (!next) throw new Error('Script exhausted');
    if (next instanceof Error) throw next;
    yield { type: 'response_start', provider: this.id, model: next.model, id: next.id };
    yield { type: 'text_delta', index: 0, text: 'Synthetic response.' };
    yield { type: 'response_complete', response: next };
  }
}

describe('fixed trace provider budget', () => {
  it('exposes only reviewed production pricing and rejects former test profiles before dispatch', () => {
    const liveProfiles = fixedTraceApprovedPricingProfiles();
    expect(liveProfiles).toHaveLength(4);
    for (const profile of liveProfiles) {
      expect(`${profile.expectedModel}\n${profile.profileId}\n${profile.source}`).not.toMatch(/synthetic|test/i);
    }

    const delegate = new BudgetScriptedProvider([RESPONSE]);
    expect(() => fixedTraceResponsePricingPolicy('anthropic', 'synthetic-manual-model', {
      profileId: 'synthetic-manual-artifact-v1',
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 5,
      cacheReadUsdPerMillionTokens: null,
      cacheWriteUsdPerMillionTokens: null,
      cacheReadAccounting: 'unsupported',
      cacheWriteAccounting: 'unsupported',
      source: 'Synthetic manual artifact pricing.',
    })).toThrow('Fixed trace pricing profile is not evaluator approved');
    expect(delegate.dispatches).not.toHaveBeenCalled();
  });

  it('accepts only the reviewed September Sonnet 5 policy and applies its additive cache rates', () => {
    expect(fixedTraceApprovedPricingProfiles()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        expectedProvider: 'anthropic',
        expectedModel: 'claude-sonnet-5',
        profileId: 'anthropic-standard-2026-09:claude-sonnet-5',
      }),
      expect.objectContaining({
        expectedProvider: 'openai',
        expectedModel: 'gpt-5.6-luna',
        profileId: 'openai-gpt-5.6-luna-standard-2026-09-05',
      }),
      expect.objectContaining({
        expectedProvider: 'google',
        expectedModel: 'gemini-3.7-flash',
        profileId: 'google-gemini-3.7-flash-through-2026-12-31',
      }),
    ]));
    expect(fixedTraceResponsePricingPolicy('anthropic', 'claude-sonnet-5', SONNET_5_PRICING))
      .toMatchObject({ pricingProfileId: SONNET_5_PRICING.profileId });
    expect(fixedTraceEstimatedCostUsd({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
    }, SONNET_5_PRICING)).toBe(0.0011);
    // A previous live cohort is historical evidence, not an approval for a
    // new fixed-trace run at a new date.
    expect(() => fixedTraceResponsePricingPolicy('anthropic', 'claude-sonnet-5', {
      ...SONNET_5_PRICING,
      profileId: 'anthropic-standard-2026-08:claude-sonnet-5',
    })).toThrow('Fixed trace pricing profile is not evaluator approved');
  });

  it('retains the reviewed Haiku, Luna, and Gemini rate cohorts', () => {
    const haikuPolicy = fixedTraceResponsePricingPolicy('anthropic', 'claude-haiku-4-5', HAIKU_4_5_PRICING);
    expect(haikuPolicy)
      .toMatchObject({ pricingProfileId: HAIKU_4_5_PRICING.profileId });
    const datedHaikuResponse = {
      ...RESPONSE,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    } as const;
    expect(fixedTraceResponseUsesPricingPolicy(haikuPolicy, datedHaikuResponse)).toBe(false);
    expect(fixedTraceResponseUsesPricingPolicy(
      fixedTraceDirectFullSuiteResponsePricingPolicy('anthropic', 'claude-haiku-4-5', HAIKU_4_5_PRICING),
      datedHaikuResponse,
    )).toBe(true);
    expect(fixedTraceEstimatedCostUsd({
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 1_000, cacheWriteTokens: 200,
    }, HAIKU_4_5_PRICING)).toBe(0.00055);
    expect(fixedTraceEstimatedCostUsd({
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 0,
    }, PRICING)).toBeCloseTo(0.0000404);
    expect(fixedTraceResponsePricingPolicy('google', 'gemini-3.7-flash', GOOGLE_PRICING))
      .toMatchObject({ pricingProfileId: GOOGLE_PRICING.profileId });
    expect(fixedTraceEstimatedCostUsd({
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 0,
    }, GOOGLE_PRICING)).toBeCloseTo(0.0001365);
  });

  it('prices Google-style subset reads plus additive writes explicitly', () => {
    expect(fixedTraceEstimatedCostUsd({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 20 }, {
      ...PRICING,
      cacheReadUsdPerMillionTokens: 0.5,
      cacheWriteUsdPerMillionTokens: 1,
      cacheReadAccounting: 'subset',
      cacheWriteAccounting: 'additive',
    })).toBeCloseTo(0.00015);
  });

  it('prices additive Anthropic cache buckets without treating them as input subsets', () => {
    expect(fixedTraceEstimatedCostUsd({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
    }, {
      ...PRICING,
      cacheReadUsdPerMillionTokens: 2,
      cacheWriteUsdPerMillionTokens: 3,
      cacheReadAccounting: 'additive',
      cacheWriteAccounting: 'additive',
    })).toBeCloseTo(0.00014);
  });

  it('fails closed when a nonzero cache bucket has no recorded formula', () => {
    expect(() => fixedTraceEstimatedCostUsd({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 1 }, {
      ...PRICING,
      cacheReadUsdPerMillionTokens: null,
      cacheReadAccounting: 'unsupported',
    }))
      .toThrow('cache read accounting is unavailable');
  });

  it('closes shared admission rather than settling an attacker-controlled returned model suffix at requested rates', async () => {
    const mismatched = { ...RESPONSE, model: 'gpt-5.6-luna-attacker-controlled' };
    const delegate = new BudgetScriptedProvider([mismatched, RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);
    const cursor = fixedTraceSettlementDiagnosticCursor(provider);

    await expect(collectModelResponse(provider.respond(REQUEST))).resolves.toEqual(mismatched);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0,
      dispatchedCalls: 1,
      completedCalls: 0,
      exposureUnknown: true,
    });
    expect(fixedTraceSettlementDiagnosticLedger(provider, cursor)).toEqual({
      fromDispatchExclusive: 0,
      throughDispatch: 1,
      truncated: false,
      entries: [{
        dispatchSequence: 1,
        status: 'exposure_unknown',
        reason: 'identity_policy_rejected',
        errorFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toMatchObject({
      name: 'FixedTraceBudgetAdmissionError', reason: 'budget_exposure_unknown',
    });
    expect(delegate.dispatches).toHaveBeenCalledTimes(1);
  });

  it('rejects a caller callback as returned-model pricing authority', () => {
    const delegate = new BudgetScriptedProvider([RESPONSE]);
    const budget = new FixedTraceBudget(1);
    expect(() => new BudgetedFixedTraceProvider(
      delegate,
      budget,
      PRICING,
      (() => true) as unknown as typeof RESPONSE_PRICING_POLICY,
    )).toThrow('Fixed trace returned-model pricing policy is not evaluator approved');
  });

  it('reserves an additive cache-write worst case before dispatch', () => {
    const delegate = new BudgetScriptedProvider([RESPONSE]);
    const budget = new FixedTraceBudget(10_000);
    const reservation = budget.reserve(delegate.prepare(REQUEST), 1, {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
      cacheReadUsdPerMillionTokens: null,
      cacheWriteUsdPerMillionTokens: 1_000_000,
      cacheReadAccounting: 'unsupported',
      cacheWriteAccounting: 'additive',
      source: 'synthetic additive cache-write worst case',
    });
    // The cache-write rate is deliberately much larger than input. A reserve
    // that only charged base input would be zero here.
    expect(budget.snapshot().reservedUsd).toBeGreaterThan(1);
    budget.cancel(reservation);
  });
  it('rejects over-budget work before provider dispatch', async () => {
    const delegate = new BudgetScriptedProvider([RESPONSE]);
    const budget = new FixedTraceBudget(0.000001);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);

    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toMatchObject({
      name: 'FixedTraceBudgetAdmissionError',
      reason: 'soft_limit_exceeded',
      terminalStatus: 'not_dispatched_budget',
    });
    expect(delegate.dispatches).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0,
      dispatchedCalls: 0,
      completedCalls: 0,
      budgetRejectedCalls: 1,
      admissionClosed: true,
      exposureUnknown: false,
    });
  });

  it('releases the reserve and accounts terminal usage', async () => {
    const delegate = new BudgetScriptedProvider([RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);

    await expect(collectModelResponse(provider.respond(REQUEST))).resolves.toEqual(RESPONSE);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0.000008,
      reservedUsd: 0,
      dispatchedCalls: 1,
      completedCalls: 1,
      budgetRejectedCalls: 0,
      exposureUnknown: false,
    });
  });

  it('uses one frozen terminal snapshot despite delegate mutation after response_complete', async () => {
    const original = structuredClone(RESPONSE);
    const delegate: ModelProvider = {
      id: 'openai',
      capabilities: CAPABILITIES,
      prepare(request): PreparedModelInvocation {
        return {
          provider: 'openai', model: request.model, capabilities: CAPABILITIES,
          providerRequest: { model: request.model },
        };
      },
      async *respond(request, options = {}): AsyncIterable<NormalizedModelEvent> {
        await options.beforeDispatch?.(this.prepare(request));
        yield { type: 'response_start', provider: 'openai', model: original.model, id: original.id };
        yield { type: 'text_delta', index: 0, text: 'Synthetic response.' };
        yield { type: 'response_complete', response: original };
        original.id = 'mutated-response-id';
        original.model = 'mutated-model';
        original.content[0] = { type: 'text', text: 'Mutated response.' };
        original.usage.inputTokens = 999_999;
        original.usage.outputTokens = 999_999;
      },
    };
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);

    const collected = await collectModelResponse(provider.respond(REQUEST));

    expect(collected).toEqual(RESPONSE);
    expect(collected).not.toBe(original);
    expect(Object.isFrozen(collected)).toBe(true);
    expect(Object.isFrozen(collected.usage)).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0.000008,
      dispatchedCalls: 1,
      completedCalls: 1,
      exposureUnknown: false,
    });
  });

  it('rejects an adapter snapshot hook that mutates the canonical response before accounting', async () => {
    const original = structuredClone(RESPONSE);
    const delegate: ModelProvider = {
      id: 'openai',
      capabilities: CAPABILITIES,
      prepare(request): PreparedModelInvocation {
        return {
          provider: 'openai', model: request.model, capabilities: CAPABILITIES,
          providerRequest: { model: request.model },
        };
      },
      snapshotResponse(response): ModelResponse {
        response.usage.inputTokens = 0;
        response.usage.outputTokens = 0;
        return response;
      },
      async *respond(request, options = {}): AsyncIterable<NormalizedModelEvent> {
        await options.beforeDispatch?.(this.prepare(request));
        yield { type: 'response_complete', response: original };
      },
    };
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);

    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toThrow(
      'Fixed trace provider response snapshot differs from its terminal response',
    );
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0,
      dispatchedCalls: 1,
      completedCalls: 0,
      exposureUnknown: true,
    });
  });

  it('forwards an adapter continuation snapshot hook through the budget boundary', () => {
    const snapshotResponse = vi.fn((response: ModelResponse) => structuredClone(response));
    const delegate: ModelProvider = {
      id: 'openai', capabilities: CAPABILITIES,
      prepare(request): PreparedModelInvocation {
        return { provider: 'openai', model: request.model, capabilities: CAPABILITIES, providerRequest: { model: request.model } };
      },
      async *respond(): AsyncIterable<NormalizedModelEvent> { throw new Error('not used'); },
      snapshotResponse,
    };
    const provider = new BudgetedFixedTraceProvider(delegate, new FixedTraceBudget(1), PRICING, RESPONSE_PRICING_POLICY);

    expect(provider.snapshotResponse!(RESPONSE)).toEqual(RESPONSE);
    expect(snapshotResponse).toHaveBeenCalledWith(RESPONSE);
  });

  it('halts later calls after a dispatched response has unknown usage', async () => {
    const delegate = new BudgetScriptedProvider([new Error('transport failed'), RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);

    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toThrow('transport failed');
    expect(budget.snapshot()).toMatchObject({
      dispatchedCalls: 1,
      completedCalls: 0,
      exposureUnknown: true,
    });
    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toBeInstanceOf(
      FixedTraceBudgetAdmissionError,
    );
    expect(delegate.dispatches).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().budgetRejectedCalls).toBe(1);
  });

  it('treats malformed terminal usage as unknown exposure', async () => {
    const delegate = new BudgetScriptedProvider([{
      ...RESPONSE,
      usage: { inputTokens: -1, outputTokens: 5 },
    }]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);
    const cursor = fixedTraceSettlementDiagnosticCursor(provider);

    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toThrow(
      'Invalid normalized usage field: inputTokens',
    );
    expect(budget.snapshot()).toMatchObject({
      reservedUsd: 0,
      remainingUsd: null,
      dispatchedCalls: 1,
      completedCalls: 0,
      exposureUnknown: true,
    });
    expect(fixedTraceSettlementDiagnosticLedger(provider, cursor).entries).toEqual([{
      dispatchSequence: 1,
      status: 'exposure_unknown',
      reason: 'usage_or_cost_settlement_failed',
      errorFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
  });

  it('treats missing terminal usage as unknown exposure and rejects every later dispatch', async () => {
    const missingUsage = { ...RESPONSE, usage: undefined } as unknown as ModelResponse;
    const delegate = new BudgetScriptedProvider([missingUsage, RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);
    const cursor = fixedTraceSettlementDiagnosticCursor(provider);

    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toThrow();
    expect(fixedTraceSettlementDiagnosticLedger(provider, cursor).entries).toEqual([{
      dispatchSequence: 1,
      status: 'exposure_unknown',
      reason: 'usage_or_cost_settlement_failed',
      errorFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toMatchObject({
      name: 'FixedTraceBudgetAdmissionError', reason: 'budget_exposure_unknown',
    });
    expect(delegate.dispatches).toHaveBeenCalledTimes(1);
  });

  it('fingerprints interrupted provider errors by safe category without retaining their raw contents', async () => {
    const firstSecret = 'provider output: keep-this-out-of-artifacts';
    const firstDelegate = new BudgetScriptedProvider([new Error(firstSecret)]);
    const firstProvider = new BudgetedFixedTraceProvider(
      firstDelegate, new FixedTraceBudget(1), PRICING, RESPONSE_PRICING_POLICY,
    );
    const firstCursor = fixedTraceSettlementDiagnosticCursor(firstProvider);

    await expect(collectModelResponse(firstProvider.respond(REQUEST))).rejects.toThrow(firstSecret);
    const firstLedger = fixedTraceSettlementDiagnosticLedger(firstProvider, firstCursor);
    expect(firstLedger.entries).toEqual([{
      dispatchSequence: 1,
      status: 'exposure_unknown',
      reason: 'response_stream_interrupted',
      errorFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(JSON.stringify(firstLedger)).not.toContain(firstSecret);

    const secondSecret = 'a distinct provider failure that must also stay private';
    const secondDelegate = new BudgetScriptedProvider([new Error(secondSecret)]);
    const secondProvider = new BudgetedFixedTraceProvider(
      secondDelegate, new FixedTraceBudget(1), PRICING, RESPONSE_PRICING_POLICY,
    );
    const secondCursor = fixedTraceSettlementDiagnosticCursor(secondProvider);
    await expect(collectModelResponse(secondProvider.respond(REQUEST))).rejects.toThrow(secondSecret);
    const secondLedger = fixedTraceSettlementDiagnosticLedger(secondProvider, secondCursor);
    expect(JSON.stringify(secondLedger)).not.toContain(secondSecret);
    expect(secondLedger.entries[0]!.errorFingerprintSha256)
      .toBe(firstLedger.entries[0]!.errorFingerprintSha256);
  });

  it('does not mark exposure unknown when the caller hook blocks dispatch', async () => {
    const delegate = new BudgetScriptedProvider([RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, RESPONSE_PRICING_POLICY);

    await expect(collectModelResponse(provider.respond(REQUEST, {
      beforeDispatch: () => { throw new Error('local policy rejected'); },
    }))).rejects.toThrow('local policy rejected');
    expect(delegate.dispatches).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({
      reservedUsd: 0,
      dispatchedCalls: 0,
      exposureUnknown: false,
    });
  });
});
