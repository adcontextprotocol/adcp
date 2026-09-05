import { describe, expect, it, vi } from 'vitest';
import {
  BudgetedFixedTraceProvider,
  FixedTraceBudget,
  FixedTraceBudgetAdmissionError,
  fixedTraceEstimatedCostUsd,
} from '../../../src/addie/eval/fixed-trace-budget.js';
import { collectModelResponse } from '../../../src/addie/model-providers/events.js';
import { fixedTraceResponseUsesRecordedPricing } from '../../../src/addie/eval/fixed-trace-runner.js';
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
  model: 'budget-model',
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic request.' }] }],
  tools: [],
  maxOutputTokens: 100,
};

const RESPONSE: ModelResponse = {
  provider: 'openai',
  model: 'budget-model',
  id: 'response-1',
  content: [{ type: 'text', text: 'Synthetic response.' }],
  finishReason: 'stop',
  providerFinishReason: 'completed',
  usage: { inputTokens: 10, outputTokens: 5 },
};

const PRICING = {
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 5,
  source: 'Synthetic budget pricing.',
};

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
    expect(() => fixedTraceEstimatedCostUsd({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 1 }, PRICING))
      .toThrow('cache read accounting is unavailable');
  });

  it('closes shared admission rather than settling an unapproved returned model at requested rates', async () => {
    const mismatched = { ...RESPONSE, model: 'other-openai-model' };
    const delegate = new BudgetScriptedProvider([mismatched, RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, (response) =>
      fixedTraceResponseUsesRecordedPricing('openai', 'budget-model', 'openai-budget-model-v1', response));

    await expect(collectModelResponse(provider.respond(REQUEST))).resolves.toEqual(mismatched);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0,
      dispatchedCalls: 1,
      completedCalls: 0,
      exposureUnknown: true,
    });
    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toMatchObject({
      name: 'FixedTraceBudgetAdmissionError', reason: 'budget_exposure_unknown',
    });
    expect(delegate.dispatches).toHaveBeenCalledTimes(1);
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
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, () => true);

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
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, () => true);

    await expect(collectModelResponse(provider.respond(REQUEST))).resolves.toEqual(RESPONSE);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0.000035,
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
    const approved = vi.fn((response: ModelResponse) => {
      expect(Object.isFrozen(response)).toBe(true);
      expect(Object.isFrozen(response.usage)).toBe(true);
      return response.model === 'budget-model' && response.usage.inputTokens === 10;
    });
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, approved);

    const collected = await collectModelResponse(provider.respond(REQUEST));

    expect(collected).toEqual(RESPONSE);
    expect(collected).not.toBe(original);
    expect(approved).toHaveBeenCalledWith(collected);
    expect(budget.snapshot()).toMatchObject({
      accountedSpendUsd: 0.000035,
      dispatchedCalls: 1,
      completedCalls: 1,
      exposureUnknown: false,
    });
  });

  it('halts later calls after a dispatched response has unknown usage', async () => {
    const delegate = new BudgetScriptedProvider([new Error('transport failed'), RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, () => true);

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
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, () => true);

    await expect(collectModelResponse(provider.respond(REQUEST))).rejects.toThrow(
      'Fixed trace budget usage is invalid',
    );
    expect(budget.snapshot()).toMatchObject({
      reservedUsd: 0,
      remainingUsd: null,
      dispatchedCalls: 1,
      completedCalls: 0,
      exposureUnknown: true,
    });
  });

  it('does not mark exposure unknown when the caller hook blocks dispatch', async () => {
    const delegate = new BudgetScriptedProvider([RESPONSE]);
    const budget = new FixedTraceBudget(1);
    const provider = new BudgetedFixedTraceProvider(delegate, budget, PRICING, () => true);

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
