import { describe, expect, it } from 'vitest';
import {
  MODEL_FALLBACK_DISCLOSURE_POLICY,
  selectSiblingModelFallback,
  type SiblingModelFallbackContext,
} from '../../../src/addie/model-providers/model-fallback.js';

const retryableError = Object.assign(new Error('overloaded_error'), { status: 529 });

function context(
  overrides: Partial<SiblingModelFallbackContext> = {},
): SiblingModelFallbackContext {
  return {
    provider: 'anthropic',
    model: 'claude-specialist',
    executionMode: 'production',
    iteration: 1,
    retriesExhausted: true,
    isRecoveryInvocation: false,
    hasExecutedCustomTool: false,
    hasProviderContinuation: false,
    receivedDeltaCount: 0,
    error: retryableError,
    configuredModels: {
      primary: 'claude-primary',
      siblings: ['claude-specialist'],
    },
    ...overrides,
  };
}

describe('sibling model fallback policy', () => {
  it('selects the configured primary once for a safe specialist outage', () => {
    expect(selectSiblingModelFallback(context())).toEqual({
      model: 'claude-primary',
      reason: 'primary_unavailable',
      disclosure: MODEL_FALLBACK_DISCLOSURE_POLICY,
    });
    expect(MODEL_FALLBACK_DISCLOSURE_POLICY).toBe('server_metadata_only');
  });

  it.each([
    [Object.assign(new Error('rate limit'), { status: 429 }), 'primary_rate_limited'],
    [Object.assign(new Error('request timeout'), { code: 'timeout' }), 'primary_timeout'],
    [Object.assign(new Error('service unavailable'), { status: 503 }), 'primary_unavailable'],
  ] as const)('maps safe failure classes to persisted reasons', (error, reason) => {
    expect(selectSiblingModelFallback(context({ error }))).toMatchObject({ reason });
  });

  it.each([
    ['billing exhaustion', Object.assign(new Error('credit balance is too low; Plans & Billing'), { status: 400 })],
    ['authentication', Object.assign(new Error('unauthorized'), { status: 401 })],
    ['invalid request', Object.assign(new Error('invalid request'), { status: 400 })],
    ['unknown failure', new Error('unexpected')],
  ])('rejects unsafe %s failures', (_label, error) => {
    expect(selectSiblingModelFallback(context({ error }))).toBeNull();
  });

  it.each([
    ['non-production execution', { executionMode: 'replay' as const }],
    ['later iteration', { iteration: 2 }],
    ['unexhausted retries', { retriesExhausted: false }],
    ['empty-response recovery', { isRecoveryInvocation: true }],
    ['completed custom tool', { hasExecutedCustomTool: true }],
    ['provider continuation', { hasProviderContinuation: true }],
    ['received stream delta', { receivedDeltaCount: 1 }],
    ['different provider', { provider: 'google' as const }],
    ['primary model', { model: 'claude-primary' }],
    ['unconfigured model', { model: 'claude-other' }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(selectSiblingModelFallback(context(overrides))).toBeNull();
  });
});
