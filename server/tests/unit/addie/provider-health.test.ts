import { describe, expect, it } from 'vitest';
import {
  formatProviderUnavailableMessage,
  ProviderHealthController,
} from '../../../src/addie/model-providers/provider-health.js';

function transientError(status = 529): Error & { status: number } {
  return Object.assign(new Error('provider failure'), { status });
}

describe('ProviderHealthController', () => {
  it('opens after bounded consecutive transient failures and isolates services', () => {
    let now = 1_000;
    const health = new ProviderHealthController({ failureThreshold: 3 }, () => now);

    expect(health.recordFailure('anthropic', 'router', transientError()).status).toBe('degraded');
    now += 1_000;
    expect(health.recordFailure('anthropic', 'router', transientError()).status).toBe('degraded');
    now += 1_000;
    expect(health.recordFailure('anthropic', 'router', transientError()).status).toBe('open');

    expect(health.acquire('anthropic', 'router').allowed).toBe(false);
    expect(health.acquire('anthropic', 'chat')).toEqual(expect.objectContaining({
      allowed: true,
      status: 'healthy',
    }));
  });

  it('opens billing exhaustion across services immediately', () => {
    const health = new ProviderHealthController({}, () => 10_000);
    const billingError = Object.assign(new Error(
      'Your credit balance is too low to access the Anthropic API. Go to Plans & Billing.',
    ), { status: 400 });

    const failed = health.recordFailure('anthropic', 'router', billingError);

    expect(failed).toEqual(expect.objectContaining({
      allowed: false,
      status: 'open',
      category: 'billing_exhausted',
      retryAfterSeconds: 300,
    }));
    expect(health.acquire('anthropic', 'chat')).toEqual(expect.objectContaining({
      allowed: false,
      category: 'billing_exhausted',
    }));
  });

  it('uses Retry-After as the minimum rate-limit cooldown', () => {
    const health = new ProviderHealthController({ transientCooldownMs: 1_000 }, () => 0);
    const error = { status: 429, headers: { 'retry-after': '45' } };

    expect(health.recordFailure('anthropic', 'chat', error).retryAfterSeconds).toBe(45);
    expect(health.acquire('anthropic', 'chat').retryAfterSeconds).toBe(45);
  });

  it('admits only one half-open probe and closes after success', () => {
    let now = 0;
    const health = new ProviderHealthController({
      failureThreshold: 1,
      transientCooldownMs: 2_000,
      probeLeaseMs: 500,
    }, () => now);
    health.recordFailure('anthropic', 'chat', transientError());

    now = 2_001;
    expect(health.acquire('anthropic', 'chat')).toEqual(expect.objectContaining({
      allowed: true,
      status: 'half_open',
    }));
    expect(health.acquire('anthropic', 'chat')).toEqual(expect.objectContaining({
      allowed: false,
      status: 'half_open',
    }));

    health.recordSuccess('anthropic', 'chat');
    expect(health.acquire('anthropic', 'chat')).toEqual(expect.objectContaining({
      allowed: true,
      status: 'healthy',
    }));
  });

  it('reopens immediately when a delayed half-open probe fails', () => {
    let now = 0;
    const health = new ProviderHealthController({
      failureThreshold: 1,
      failureWindowMs: 1_000,
      transientCooldownMs: 2_000,
    }, () => now);
    health.recordFailure('anthropic', 'chat', transientError());

    // Recover well after the original failure window has expired. The probe
    // itself is the only request that should be admitted.
    now = 10_000;
    expect(health.acquire('anthropic', 'chat').status).toBe('half_open');
    expect(health.recordFailure('anthropic', 'chat', transientError())).toEqual(expect.objectContaining({
      allowed: false,
      status: 'open',
    }));
    expect(health.acquire('anthropic', 'chat').allowed).toBe(false);
  });

  it('resets degraded streaks after a successful request', () => {
    const health = new ProviderHealthController({ failureThreshold: 2 });
    expect(health.recordFailure('anthropic', 'chat', transientError()).status).toBe('degraded');
    health.recordSuccess('anthropic', 'chat');
    expect(health.recordFailure('anthropic', 'chat', transientError()).status).toBe('degraded');
  });
});

describe('provider recovery copy', () => {
  it('keeps billing details private while providing a bounded retry time', () => {
    const text = formatProviderUnavailableMessage({
      allowed: false,
      provider: 'anthropic',
      service: 'chat',
      status: 'open',
      category: 'billing_exhausted',
      retryAfterSeconds: 300,
    });

    expect(text).toBe('The AI service is temporarily unavailable. Please try again in about 5 minutes.');
    expect(text).not.toMatch(/billing|credit/i);
  });
});
