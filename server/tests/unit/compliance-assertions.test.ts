/**
 * Unit tests for compliance assertion modules (adcontextprotocol/adcp#2639).
 * Each assertion ships as a TS module that registers itself against
 * `@adcp/client/testing` at import time AND exports its `spec` so the hooks
 * can be driven directly with crafted step results here — no storyboard
 * runner plumbing needed.
 */

import { describe, it, expect } from 'vitest';
import type { AssertionContext, StoryboardStepResult } from '@adcp/client/testing';
import { spec as contextSpec } from '../../src/compliance/assertions/context-no-secret-echo.js';
import { spec as conflictSpec } from '../../src/compliance/assertions/idempotency-conflict-no-payload-leak.js';

function makeCtx(options: Record<string, unknown> = {}): AssertionContext {
  return {
    storyboard: { id: 't', version: '1.0.0', title: 't', category: 'c', summary: '', narrative: '', agent: { interaction_model: '*', capabilities: [] }, caller: { role: 'buyer_agent' }, phases: [] },
    agentUrl: 'https://agent.example/mcp',
    options: { ...options },
    state: {},
  } as AssertionContext;
}

function makeStep(overrides: Partial<StoryboardStepResult>): StoryboardStepResult {
  return {
    step_id: overrides.step_id ?? 's1',
    phase_id: 'p',
    title: 't',
    task: 'create_media_buy',
    passed: true,
    duration_ms: 0,
    validations: [],
    context: {},
    extraction: { path: 'none' },
    ...overrides,
  } as StoryboardStepResult;
}

describe('context.no_secret_echo', () => {
  it('passes when the response has no suspect keys or bearer literals', () => {
    const ctx = makeCtx();
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({ response: { media_buy_id: 'mb-1', replayed: false } }));
    expect(out).toEqual([]);
  });

  it('fails when the response body echoes a bearer token literal', () => {
    const ctx = makeCtx();
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({
      response: { debug: 'request had Authorization: Bearer abcdef123456xyz' },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(false);
    expect(out[0].error).toMatch(/bearer token literal/);
  });

  it('fails when the response contains the test-kit api_key value', () => {
    const ctx = makeCtx({ test_kit: { auth: { api_key: 'sk-live-123456789secret' } } });
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({
      response: { echoed: { received_auth: 'sk-live-123456789secret' } },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(false);
    expect(out[0].error).toMatch(/api_key value/);
  });

  it('ignores short api_key values to avoid false positives on placeholders', () => {
    const ctx = makeCtx({ test_kit: { auth: { api_key: 'sk' } } });
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({ response: { ok: 'sk' } }));
    expect(out).toEqual([]);
  });

  it('fails when the response has a suspect property name like "authorization"', () => {
    const ctx = makeCtx();
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({
      response: { nested: { Authorization: 'anything here' } },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].error).toMatch(/suspect field "Authorization"/);
  });

  it('no-ops on steps with no response', () => {
    const ctx = makeCtx();
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({ response: undefined }));
    expect(out).toEqual([]);
  });

  it('walks arrays when hunting for leaks', () => {
    const ctx = makeCtx();
    contextSpec.onStart?.(ctx);
    const out = contextSpec.onStep!(ctx, makeStep({
      response: { items: [{ ok: 1 }, { description: 'Bearer aaaaaaaaaaaaaa' }] },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(false);
  });
});

describe('idempotency.conflict_no_payload_leak', () => {
  it('skips non-error steps', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: false,
      response: { media_buy_id: 'mb-1' },
    }));
    expect(out).toEqual([]);
  });

  it('skips error steps with unrelated error codes', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: true,
      response: { code: 'INVALID_REQUEST', message: 'missing field' },
    }));
    expect(out).toEqual([]);
  });

  it('passes when IDEMPOTENCY_CONFLICT body has only allowed fields', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: true,
      response: { code: 'IDEMPOTENCY_CONFLICT', message: 'key reused with different payload' },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(true);
  });

  it('also passes on the CONFLICT fallback code', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: true,
      response: { code: 'CONFLICT', message: 'x', correlation_id: 'abc' },
    }));
    expect(out[0].passed).toBe(true);
  });

  it('fails when the conflict body leaks cached payload fields', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: true,
      response: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'conflict',
        budget: 5000,
        start_time: '2026-06-01T00:00:00Z',
      },
    }));
    expect(out).toHaveLength(1);
    expect(out[0].passed).toBe(false);
    expect(out[0].error).toMatch(/budget/);
    expect(out[0].error).toMatch(/start_time/);
  });

  it('flags deeply-nested leaked fields', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: true,
      response: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'conflict',
        cached_payload: { packages: [{ product_id: 'p-1' }] },
      },
    }));
    expect(out[0].passed).toBe(false);
    // The outer 'cached_payload' key itself is a leak.
    expect(out[0].error).toMatch(/cached_payload/);
  });

  it('extracts error code from nested error object', () => {
    const ctx = makeCtx();
    const out = conflictSpec.onStep!(ctx, makeStep({
      expect_error: true,
      response: { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'x' } },
    }));
    // The outer `error` key wrapping the code/message IS a leak under the
    // allowlist — we want handlers to return flat {code, message}, not
    // nested shapes that give room for payload echoes. This also proves
    // the extractor reaches into the nested shape.
    expect(out[0].passed).toBe(false);
    expect(out[0].error).toMatch(/error/);
  });
});
