import { describe, expect, it, vi } from 'vitest';
import type {
  RouterCanaryAdmission,
  RouterCanaryOutcome,
} from '../../../src/addie/router-canary.js';
import { ROUTER_CANARY_MAX_REQUEST_BYTES } from '../../../src/addie/router-canary.js';
import { routeWithRouterCanary } from '../../../src/addie/router-canary-runtime.js';
import type {
  AddieRouter,
  ExecutionPlan,
  RouterModelObservation,
  RouterRouteOptions,
  RoutingContext,
} from '../../../src/addie/router.js';

type RouterRoute = AddieRouter['route'];

const context: RoutingContext = {
  message: 'How does AdCP work?',
  source: 'channel',
  isAAOAdmin: false,
};
const cohort = {
  channelId: 'C0123456789',
  opportunityId: '1724688000.000001',
  channelIsPublic: true,
  channelIsShared: false,
  routingContext: context,
};
const candidatePlan: ExecutionPlan = {
  action: 'respond',
  tool_sets: ['knowledge'],
  confidence: 'high',
  reason: 'candidate',
  decision_method: 'llm',
  latency_ms: 50,
  tokens_input: 100,
  tokens_output: 20,
  model: 'gpt-5.6-luna',
};
const fallbackPlan: ExecutionPlan = {
  action: 'ignore',
  reason: 'fallback',
  decision_method: 'llm',
  latency_ms: 75,
  tokens_input: 120,
  tokens_output: 25,
  model: 'claude-haiku-4-5',
};

function admission(): RouterCanaryAdmission {
  return {
    status: 'admitted',
    admissionDate: '2026-08-29',
    deadlineMs: 10_000,
    policyVersion: 'addie-router-luna-canary:v1',
    pricingVersion: 'openai-gpt-5.6-luna-2026-08-26',
    hashKeyVersion: 'test-v1',
    requestedModel: 'gpt-5.6-luna',
  };
}

function observation(
  provider: 'openai' | 'anthropic',
  error: RouterModelObservation['primaryErrorCategory'] = null,
): RouterModelObservation {
  const model = provider === 'openai' ? 'gpt-5.6-luna' : 'claude-haiku-4-5';
  return {
    canonicalRequest: {
      model,
      system: [{ text: 'router' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'question' }] }],
      tools: [],
      maxOutputTokens: 300,
    },
    primaryInvocation: null,
    isAdmin: false,
    productionPlan: provider === 'openai' ? candidatePlan : fallbackPlan,
    rawResponseText: error ? null : '{"action":"ignore","reason":"done"}',
    responseContent: [],
    finishReason: error ? null : 'stop',
    primaryErrorCategory: error,
    requestedProvider: provider,
    requestedModel: model,
    returnedProvider: error ? null : provider,
    returnedModel: error ? null : model,
    inputTokens: error ? null : 100,
    outputTokens: error ? null : 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    latencyMs: provider === 'openai' ? 50 : 75,
  };
}

function routeReturning(
  plan: ExecutionPlan,
  seenObservation: RouterModelObservation,
): RouterRoute {
  return async (_routingContext: RoutingContext, options: RouterRouteOptions = {}) => {
    options.observer?.(seenObservation);
    return plan;
  };
}

function baseDependencies(overrides: Partial<Parameters<typeof routeWithRouterCanary>[1]> = {}) {
  return {
    candidateRoute: vi.fn(routeReturning(candidatePlan, observation('openai'))),
    fallbackRoute: vi.fn(routeReturning(fallbackPlan, observation('anthropic'))),
    admit: vi.fn().mockResolvedValue(admission()),
    record: vi.fn().mockResolvedValue({
      recorded: true, rolledBack: false, rollbackReason: null,
    }),
    yieldForObserver: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Luna router canary runtime', () => {
  it('uses an admitted strict candidate and records its bounded outcome', async () => {
    const candidateRoute = vi.fn(routeReturning(candidatePlan, observation('openai')));
    const record = vi.fn().mockResolvedValue({
      recorded: true, rolledBack: false, rollbackReason: null,
    });
    const dependencies = baseDependencies({ candidateRoute, record });

    await expect(routeWithRouterCanary(cohort, dependencies)).resolves.toEqual({
      plan: candidatePlan,
      provider: 'luna',
      reason: 'candidate_succeeded',
    });
    const routeOptions = candidateRoute.mock.calls[0][1];
    expect(routeOptions.failureMode).toBe('throw');
    expect(routeOptions.signal).toBeInstanceOf(AbortSignal);
    expect(record).toHaveBeenCalledWith(admission(), {
      status: 'candidate_succeeded',
      candidateLatencyMs: 50,
      candidateCostMicros: 44,
    });
  });

  it('uses Anthropic without calling the candidate when admission is closed', async () => {
    const candidateRoute = vi.fn(routeReturning(candidatePlan, observation('openai')));
    const fallbackRoute = vi.fn(routeReturning(fallbackPlan, observation('anthropic')));
    const dependencies = baseDependencies({
      candidateRoute,
      fallbackRoute,
      admit: vi.fn().mockResolvedValue({
        status: 'not_admitted', reason: 'rolled_back',
      }),
    });

    await expect(routeWithRouterCanary(cohort, dependencies)).resolves.toEqual({
      plan: fallbackPlan,
      provider: 'anthropic_fallback',
      reason: 'rolled_back',
    });
    expect(candidateRoute).not.toHaveBeenCalled();
    expect(fallbackRoute).toHaveBeenCalledOnce();
    expect(dependencies.record).not.toHaveBeenCalled();
  });

  it('falls back and accounts for strict candidate output failure', async () => {
    const failedObservation = observation('openai', 'schema_invalid');
    const candidateRoute: RouterRoute = async (_ctx, options = {}) => {
      options.observer?.(failedObservation);
      throw new Error('invalid output');
    };
    const record = vi.fn().mockResolvedValue({
      recorded: true, rolledBack: false, rollbackReason: null,
    });

    await expect(routeWithRouterCanary(cohort, baseDependencies({
      candidateRoute,
      record,
    }))).resolves.toMatchObject({
      plan: fallbackPlan,
      provider: 'anthropic_fallback',
      reason: 'candidate_failed',
    });
    expect(record.mock.calls[0][1]).toMatchObject({
      status: 'fallback_succeeded',
      failureReason: 'invalid_output',
      candidateLatencyMs: 50,
      candidateCostMicros: 0,
      fallbackLatencyMs: 75,
    } satisfies RouterCanaryOutcome);
  });

  it('records a fallback safe-default so the ledger can roll back immediately', async () => {
    const candidateRoute: RouterRoute = async () => {
      throw new Error('provider failed');
    };
    const fallbackRoute = routeReturning(
      fallbackPlan,
      observation('anthropic', 'provider_error'),
    );
    const record = vi.fn().mockResolvedValue({
      recorded: true, rolledBack: true, rollbackReason: 'fallback_safe_default',
    });

    await routeWithRouterCanary(cohort, baseDependencies({
      candidateRoute,
      fallbackRoute,
      record,
    }));

    expect(record.mock.calls[0][1]).toMatchObject({
      status: 'fallback_safe_default',
      failureReason: 'provider_error',
    });
  });

  it('aborts a slow candidate at the admitted deadline and falls back', async () => {
    let observedSignal: AbortSignal | undefined;
    const candidateRoute: RouterRoute = async (_ctx, options = {}) => {
      observedSignal = options.signal;
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    };
    const record = vi.fn().mockResolvedValue({
      recorded: true, rolledBack: false, rollbackReason: null,
    });
    const scheduleTimeout = (callback: () => void) => setTimeout(callback, 0);

    const result = await routeWithRouterCanary(cohort, baseDependencies({
      candidateRoute,
      record,
      scheduleTimeout,
    }));

    expect(observedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      plan: fallbackPlan,
      provider: 'anthropic_fallback',
      reason: 'candidate_failed',
    });
    expect(record.mock.calls[0][1]).toMatchObject({ failureReason: 'timeout' });
  });

  it('does not use a candidate decision when success accounting fails', async () => {
    const fallbackRoute = vi.fn(routeReturning(fallbackPlan, observation('anthropic')));
    const result = await routeWithRouterCanary(cohort, baseDependencies({
      fallbackRoute,
      record: vi.fn().mockResolvedValue({
        recorded: false, rolledBack: false, rollbackReason: null,
      }),
    }));
    expect(result).toEqual({
      plan: fallbackPlan,
      provider: 'anthropic_fallback',
      reason: 'outcome_not_recorded',
    });
    expect(fallbackRoute).toHaveBeenCalledOnce();
  });

  it('rejects oversized requests before admission or candidate dispatch', async () => {
    const dependencies = baseDependencies();
    const oversized = {
      ...cohort,
      routingContext: {
        ...context,
        message: 'x'.repeat(ROUTER_CANARY_MAX_REQUEST_BYTES + 1),
      },
    };
    await expect(routeWithRouterCanary(oversized, dependencies)).resolves.toMatchObject({
      plan: fallbackPlan,
      provider: 'anthropic_fallback',
      reason: 'request_too_large',
    });
    expect(dependencies.admit).not.toHaveBeenCalled();
    expect(dependencies.candidateRoute).not.toHaveBeenCalled();
  });
});
