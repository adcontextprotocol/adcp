import { describe, expect, it, vi } from 'vitest';
import type {
  ModelProvider,
  ModelRequest,
  ModelRespondOptions,
  NormalizedModelEvent,
} from '../../../src/addie/model-providers/model-provider.js';
import {
  buildRouterEvalRequest,
  evaluateRouterCase,
  MODEL_ROUTER_CORPUS,
  parseStrictRouterPlan,
  RouterPlanParseError,
  scoreRouterPlan,
  shouldDispatchWithinSoftBudget,
  accountRouterCallCostUsd,
  runRouterEvalMatrix,
  summarizeRouterEval,
  SYNTHETIC_ROUTER_CORPUS,
} from '../../../src/addie/testing/provider-router-eval.js';
import {
  AddieRouter,
  buildRouterModelRequest,
  buildRoutingPrompt,
} from '../../../src/addie/router.js';
import { getValidToolSetNames } from '../../../src/addie/tool-sets.js';

function fakeProvider(text: string | string[], finishReason: 'stop' | 'length' | 'refusal' = 'stop'): ModelProvider {
  return {
    id: 'openai',
    capabilities: {
      streaming: false,
      structuredOutput: true,
      reasoning: false,
      reasoningEfforts: ['provider_default'],
      customTools: false,
      providerWebSearch: false,
      imageInput: false,
      documentInput: false,
    },
    prepare: (request) => ({
      provider: 'openai',
      model: request.model,
      capabilities: {
        streaming: false,
        structuredOutput: true,
        reasoning: false,
        reasoningEfforts: ['provider_default'],
        customTools: false,
        providerWebSearch: false,
        imageInput: false,
        documentInput: false,
      },
      providerRequest: { model: request.model, marker: 'actual-dispatch' },
    }),
    async *respond(request: ModelRequest, options?: ModelRespondOptions): AsyncIterable<NormalizedModelEvent> {
      await options?.beforeDispatch?.(this.prepare(request));
      const textBlocks = Array.isArray(text) ? text : text ? [text] : [];
      yield { type: 'response_start', provider: 'openai', model: request.model, id: 'id' };
      for (const [index, block] of textBlocks.entries()) {
        yield { type: 'text_delta', index, text: block };
      }
      yield {
        type: 'response_complete',
        response: {
          provider: 'openai', model: request.model, id: 'id',
          content: textBlocks.map((block) => ({ type: 'text' as const, text: block })),
          finishReason, providerFinishReason: finishReason,
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      };
    },
  };
}

describe('strict router eval', () => {
  it('returns the production plan even when its detached observer rejects', async () => {
    const provider = fakeProvider(
      '{"action":"ignore","reason":"authoritative"}',
    );
    const observer = vi.fn(async () => {
      throw new Error('shadow failed');
    });
    const plan = await new AddieRouter('unused', provider).route(
      { message: 'route this', source: 'channel' },
      { observer },
    );
    expect(plan).toMatchObject({ action: 'ignore', reason: 'authoritative' });
    expect(observer).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observer).toHaveBeenCalledOnce();
  });

  it('observes the exact primary request and terminal provider failure without changing fallback', async () => {
    const provider = fakeProvider('unused');
    provider.respond = async function* (request, options) {
      await options?.beforeDispatch?.(this.prepare(request));
      throw new Error('private provider failure');
    };
    const observer = vi.fn();
    const plan = await new AddieRouter('unused', provider).route(
      { message: 'route failure safely', source: 'channel' },
      { observer },
    );
    expect(plan).toMatchObject({ action: 'respond', tool_sets: ['knowledge'] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      requestedProvider: 'openai',
      returnedProvider: null,
      primaryErrorCategory: 'provider_error',
      primaryInvocation: expect.objectContaining({
        provider: 'openai',
        providerRequest: expect.objectContaining({ marker: 'actual-dispatch' }),
      }),
      canonicalRequest: expect.objectContaining({
        model: 'claude-haiku-4-5',
        tools: [],
      }),
    }));
  });

  it('uses the exact production request for the prompt-parity profile', () => {
    const testCase = MODEL_ROUTER_CORPUS[0];
    expect(buildRouterEvalRequest('router-model', 'prompt_parity', testCase))
      .toEqual(buildRouterModelRequest(testCase.context, 'router-model'));
  });

  it('scores only the first response block, matching production routing', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'off-topic')!;
    const result = await evaluateRouterCase(fakeProvider([
      '{"action":"ignore","reason":"first block wins"}',
      '{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"ignored"}',
    ]), 'router-model', 'prompt_parity', testCase);

    expect(result.status).toBe('valid_plan');
    expect(result.plan).toEqual({ action: 'ignore', reason: 'first block wins' });
    expect(result.scores.actionExact).toBe(true);
  });

  it('uses a frozen synthetic corpus covering every tool set', () => {
    expect(SYNTHETIC_ROUTER_CORPUS).toHaveLength(54);
    expect(new Set(SYNTHETIC_ROUTER_CORPUS.map((testCase) => testCase.id)).size).toBe(54);
    const expectedSets = new Set(SYNTHETIC_ROUTER_CORPUS.flatMap((testCase) => testCase.expected.toolSets ?? []));
    expect(expectedSets).toEqual(new Set([
      'knowledge', 'member', 'directory', 'agent_testing', 'agent_conformance',
      'adcp_operations', 'sponsored_intelligence', 'content', 'publishing', 'github', 'illustrations',
      'member_billing', 'billing', 'events', 'meetings',
      'committee_leadership', 'admin_events', 'admin_prospects', 'admin_feeds',
      'admin_groups', 'admin_organizations', 'admin_workflows', 'admin_brands',
      'outreach', 'collaboration', 'certification',
    ]));
    const productionRouter = new AddieRouter('unused');
    expect(MODEL_ROUTER_CORPUS).toHaveLength(53);
    for (const testCase of MODEL_ROUTER_CORPUS) {
      expect(productionRouter.quickMatch(testCase.context), testCase.id).toBeNull();
    }
  });

  it('accepts production-compatible markdown fences without relaxing the plan schema', () => {
    expect(parseStrictRouterPlan(
      '```json\n{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"documented"}\n```',
      false,
    )).toEqual({
      action: 'respond',
      tool_sets: ['knowledge'],
      confidence: 'high',
      requires_depth: false,
      reason: 'documented',
    });
    expect(() => parseStrictRouterPlan(
      '```json\n{"action":"respond","tool_sets":["admin"],"confidence":"high","requires_depth":false,"reason":"no"}\n```',
      false,
    )).toThrow(RouterPlanParseError);
  });

  it('generates internally consistent tool eligibility policy', () => {
    const nonAdmin = buildRoutingPrompt({ message: 'invoice please', source: 'dm' });
    const admin = buildRoutingPrompt({ message: 'invoice please', source: 'dm', isAAOAdmin: true });
    expect(nonAdmin).toContain(`Valid sets: ${[...getValidToolSetNames(false)].join(', ')}`);
    expect(nonAdmin).toContain('→ ["member_billing"]');
    expect(nonAdmin).toContain('Refunds, disputes, failed charges');
    expect(admin).toContain(`Valid sets: ${[...getValidToolSetNames(true)].join(', ')}`);
    expect(admin).toContain('→ ["billing"]');
    expect(admin).not.toContain('- **admin**:');
    expect(getValidToolSetNames(true).has('admin')).toBe(false);
    expect(nonAdmin).toContain('Exact bare acknowledgments');
  });

  it('accepts exact plans and rejects fallback-shaped, unauthorized, or extra-field output', () => {
    expect(parseStrictRouterPlan('{"action":"ignore","reason":"not needed"}', false)).toEqual({ action: 'ignore', reason: 'not needed' });
    expect(parseStrictRouterPlan('{"action":"ignore","reason":"not needed","emoji":null,"tool_sets":[],"confidence":null,"requires_depth":null}', false)).toEqual({ action: 'ignore', reason: 'not needed' });
    expect(() => parseStrictRouterPlan('```json\n{"action":"ignore","reason":"x","extra":true}\n```', false)).toThrow(RouterPlanParseError);
    expect(() => parseStrictRouterPlan('{"action":"respond","tool_sets":["admin"],"confidence":"high","requires_depth":false,"reason":"x"}', false)).toThrow('unauthorized');
    expect(() => parseStrictRouterPlan('{"action":"ignore","reason":"x","extra":true}', false)).toThrow('invalid fields');
  });

  it('scores action, tools, depth, confidence, and privilege independently', () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'protocol-schema')!;
    expect(scoreRouterPlan(testCase, {
      action: 'respond', tool_sets: ['admin_workflows'], confidence: 'low', requires_depth: true, reason: 'x',
    })).toEqual({ actionExact: true, toolsExact: false, privilegeLeak: true, invalidToolSet: false, confidenceExact: false, depthExact: false, emojiExact: true });
  });

  it('keeps malformed, truncated, and refusal rows in the denominator', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS[0];
    const results = await Promise.all([
      evaluateRouterCase(fakeProvider('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"x"}'), 'model', 'prompt_parity', testCase),
      evaluateRouterCase(fakeProvider('not json'), 'model', 'prompt_parity', testCase),
      evaluateRouterCase(fakeProvider('partial', 'length'), 'model', 'prompt_parity', testCase),
      evaluateRouterCase(fakeProvider('', 'refusal'), 'model', 'prompt_parity', testCase),
    ]);
    expect(results.map((result) => result.status)).toEqual(['valid_plan', 'invalid_json', 'truncated', 'refusal']);
    const summary = summarizeRouterEval(results);
    expect(summary.dispatched).toBe(4);
    expect(summary.valid).toBe(1);
    expect(summary.actionAccuracy).toBe(0.25);
    expect(summary.inputTokens).toBe(40);
  });

  it('retains unauthorized tool attempts as safety failures', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'protocol-schema')!;
    const result = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["admin_workflows"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model', 'prompt_parity', testCase,
    );
    expect(result.status).toBe('schema_invalid');
    expect(result.scores.privilegeLeak).toBe(true);
    expect(summarizeRouterEval([result]).privilegeLeakRate).toBe(1);
    const typo = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["not_a_set"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model', 'prompt_parity', testCase,
    );
    expect(typo.scores.privilegeLeak).toBe(false);
    expect(typo.scores.invalidToolSet).toBe(true);
    expect(summarizeRouterEval([typo]).invalidToolSetRate).toBe(1);
  });

  it('does not award empty expected tools to failed rows', async () => {
    const testCase = SYNTHETIC_ROUTER_CORPUS.find((item) => item.id === 'billing-nonadmin')!;
    const result = await evaluateRouterCase(fakeProvider('not json'), 'model', 'prompt_parity', testCase);
    expect(result.scores.toolsExact).toBe(false);
    expect(summarizeRouterEval([result]).toolSetExactAccuracy).toBe(0);
  });

  it('fails closed at the soft budget boundary', () => {
    expect(shouldDispatchWithinSoftBudget(0.4, 0.1, 0.5)).toBe(true);
    expect(shouldDispatchWithinSoftBudget(0.4, 0.100_001, 0.5)).toBe(false);
    expect(shouldDispatchWithinSoftBudget(Number.NaN, 0.1, 0.5)).toBe(false);
    expect(accountRouterCallCostUsd(
      { inputTokens: 1_000, outputTokens: 100 },
      { input: 1, output: 5 },
    )).toBe(0.0015);
    expect(accountRouterCallCostUsd(
      { inputTokens: 10, outputTokens: 5 },
      { input: 1, output: 5 },
    )).toBe(0.000035);
    expect(shouldDispatchWithinSoftBudget(0.25326, 0.01, 0.26)).toBe(false);
  });

  it('captures the exact prepared envelope at the actual dispatch boundary', async () => {
    const prepared = vi.fn();
    const result = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model',
      'prompt_parity',
      MODEL_ROUTER_CORPUS[0],
      { beforeDispatch: prepared },
    );

    expect(result.status).toBe('valid_plan');
    expect(prepared).toHaveBeenCalledOnce();
    expect(prepared).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'model',
      providerRequest: { model: 'model', marker: 'actual-dispatch' },
    }));
  });

  it('halts the remaining matrix after unknown dispatched usage and reports omissions', async () => {
    const execute = vi.fn(async ({ testCase, cell }) => ({
      caseId: testCase.id,
      provider: cell.provider,
      requestedModel: 'model',
      profile: cell.profile,
      status: 'provider_error' as const,
      latencyMs: 1,
      scores: {
        actionExact: false,
        toolsExact: false,
        privilegeLeak: false,
        invalidToolSet: false,
        confidenceExact: false,
        depthExact: false,
        emojiExact: false,
      },
      applicable: { tools: false, confidence: false, depth: false, emoji: false },
    }));
    const run = await runRouterEvalMatrix({
      repetitions: 1,
      cases: MODEL_ROUTER_CORPUS.slice(0, 2),
      cells: [
        { provider: 'openai', profile: 'prompt_parity' as const },
        { provider: 'google', profile: 'prompt_parity' as const },
      ],
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(run).toMatchObject({ requested: 4, observed: 1, omitted: 3, complete: false });
    expect(run.abortedAfter).toMatchObject({
      repetition: 0,
      testCase: { id: MODEL_ROUTER_CORPUS[0].id },
      cell: { provider: 'openai', profile: 'prompt_parity' },
    });
    expect(summarizeRouterEval(run.results, run.requested)).toMatchObject({
      intended: 4,
      observed: 1,
      omitted: 3,
      comparisonEligible: false,
      planned: 4,
    });
  });

  it('keeps budget-skipped matrices out of model comparisons', async () => {
    const budgetSkipped = vi.fn(async ({ testCase, cell }) => ({
      caseId: testCase.id,
      provider: cell.provider,
      requestedModel: 'model',
      profile: cell.profile,
      status: 'not_dispatched_budget' as const,
      latencyMs: 0,
      scores: {
        actionExact: false,
        toolsExact: false,
        privilegeLeak: false,
        invalidToolSet: false,
        confidenceExact: false,
        depthExact: false,
        emojiExact: false,
      },
      applicable: { tools: false, confidence: false, depth: false, emoji: false },
    }));
    const run = await runRouterEvalMatrix({
      repetitions: 1,
      cases: MODEL_ROUTER_CORPUS.slice(0, 2),
      cells: [{ provider: 'openai', profile: 'prompt_parity' as const }],
      execute: budgetSkipped,
    });

    expect(budgetSkipped).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({
      requested: 2,
      observed: 2,
      omitted: 0,
      complete: true,
      comparisonEligible: false,
    });
    expect(summarizeRouterEval(run.results, run.requested).comparisonEligible).toBe(false);

    const dispatched = await evaluateRouterCase(
      fakeProvider('{"action":"respond","tool_sets":["knowledge"],"confidence":"high","requires_depth":false,"reason":"x"}'),
      'model',
      'prompt_parity',
      MODEL_ROUTER_CORPUS[0],
    );
    expect(summarizeRouterEval([dispatched, run.results[0]], 2).comparisonEligible).toBe(false);
  });

  it('counts tool false positives on non-respond cases and normalizes stability', () => {
    const base = {
      caseId: 'off-topic', provider: 'openai', requestedModel: 'model', profile: 'prompt_parity' as const,
      status: 'valid_plan' as const, latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 },
      applicable: { tools: false, confidence: false, depth: false, emoji: false },
    };
    const first = {
      ...base,
      plan: { action: 'respond' as const, tool_sets: ['knowledge', 'member'], confidence: 'high' as const, requires_depth: false, reason: 'one' },
      scores: { actionExact: false, toolsExact: false, privilegeLeak: false, invalidToolSet: false, confidenceExact: true, depthExact: true, emojiExact: true },
    };
    const second = {
      ...base,
      plan: { ...first.plan, tool_sets: ['member', 'knowledge'], reason: 'two' },
      scores: first.scores,
    };
    const summary = summarizeRouterEval([first, second]);
    expect(summary.perToolSet.knowledge.precision).toBe(0);
    expect(summary.stabilityRate).toBe(1);
    expect(summarizeRouterEval([first]).stabilityRate).toBeNull();
  });

  it('categorizes a provider deadline in the failure denominator', async () => {
    const provider = fakeProvider('never');
    provider.respond = async function* (_request, options) {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    };
    const result = await evaluateRouterCase(
      provider, 'model', 'prompt_parity', MODEL_ROUTER_CORPUS[0], { timeoutMs: 1 },
    );
    expect(result.status).toBe('timeout_after_dispatch');
    expect(summarizeRouterEval([result]).dispatched).toBe(1);
  });
});
