/**
 * Unit tests for compliance assertion modules (adcontextprotocol/adcp#2639).
 * Each assertion ships as a TS module that registers itself against
 * `@adcp/client/testing` at import time AND exports its `spec` so the hooks
 * can be driven directly with crafted step results here — no storyboard
 * runner plumbing needed.
 *
 * `context.no_secret_echo` and `idempotency.conflict_no_payload_leak` are
 * now shipped by `@adcp/client` as built-in default invariants (removed
 * locally in the 5.8 upgrade); the SDK owns the tests for those. Only the
 * repo-local `governance.denial_blocks_mutation` remains here.
 */

import { describe, it, expect } from 'vitest';
import type { AssertionContext, StoryboardStepResult } from '@adcp/client/testing';
import { spec as governanceSpec } from '../../src/compliance/assertions/governance-denial-blocks-mutation.js';

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

describe('governance.denial_blocks_mutation', () => {
  const denialStep = (planId: string, code = 'GOVERNANCE_DENIED') =>
    makeStep({
      step_id: 'deny',
      task: 'check_governance',
      expect_error: true,
      response: { code, message: 'denied', plan_id: planId },
    });

  const checkGovDeniedStep = (planId: string) =>
    makeStep({
      step_id: 'check_denied',
      task: 'check_governance',
      expect_error: false,
      response: { status: 'denied', plan_id: planId, explanation: 'over threshold', findings: [] },
    });

  /**
   * Build a write-task step whose response carries `media_buy_id` plus
   * optionally a `plan_id` in the RESPONSE (matching what a linked-plan
   * media-buy response actually looks like) or a `plan_id` in the
   * recorded outgoing request (for tasks whose response body omits it).
   */
  const mutateStep = (
    task: string,
    opts: { planId?: string; requestPlanId?: string; response?: Record<string, unknown> } = {}
  ): StoryboardStepResult => {
    const base: Record<string, unknown> = opts.response ?? { media_buy_id: 'mb-999', status: 'active' };
    if (opts.planId) base.plan_id = opts.planId;
    const step = makeStep({
      step_id: 'mutate',
      task,
      passed: true,
      expect_error: false,
      response: base,
    });
    if (opts.requestPlanId) {
      (step as { request?: { transport: string; operation: string; payload: unknown } }).request = {
        transport: 'mcp',
        operation: task,
        payload: { plan_id: opts.requestPlanId },
      };
    }
    return step;
  };

  function runSequence(steps: StoryboardStepResult[]) {
    const ctx = makeCtx();
    governanceSpec.onStart?.(ctx);
    const results: Array<{ step: string; output: Array<{ passed: boolean; error?: string; description: string }> }> = [];
    for (const s of steps) {
      const r = governanceSpec.onStep!(ctx, s) as Array<{ passed: boolean; error?: string; description: string }>;
      results.push({ step: s.step_id, output: r });
    }
    return results;
  }

  it('silent on runs with no denial signal', () => {
    const results = runSequence([
      makeStep({ step_id: 'ok', task: 'create_media_buy', response: { media_buy_id: 'mb-1', status: 'active', plan_id: 'plan-a' } }),
    ]);
    expect(results.every(r => (r.output as unknown[]).length === 0)).toBe(true);
  });

  it('silent when denial is observed but no mutation follows', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({ step_id: 'lookup', task: 'get_media_buys', response: { media_buys: [] } }),
    ]);
    expect(results.every(r => r.output.length === 0)).toBe(true);
  });

  it('fires when create_media_buy acquires a resource after GOVERNANCE_DENIED on same plan', () => {
    const results = runSequence([
      denialStep('plan-a'),
      mutateStep('create_media_buy', { planId: 'plan-a' }),
    ]);
    const violation = results[1].output[0];
    expect(violation.passed).toBe(false);
    expect(violation.error).toMatch(/GOVERNANCE_DENIED/);
    expect(violation.error).toMatch(/plan_id=plan-a/);
    expect(violation.error).toMatch(/media_buy_id=mb-999/);
  });

  it('reads plan_id from the runner-recorded request payload when the response omits it', () => {
    const results = runSequence([
      denialStep('plan-a'),
      mutateStep('create_media_buy', {
        requestPlanId: 'plan-a',
        response: { media_buy_id: 'mb-req-linked', status: 'active' },
      }),
    ]);
    const violation = results[1].output[0];
    expect(violation.passed).toBe(false);
    expect(violation.error).toMatch(/plan_id=plan-a/);
  });

  it('does NOT bind plan_id from stale step context (false-positive guard)', () => {
    // Prior-step context carries an unrelated plan-a; the mutation itself
    // targets a different plan and its response/request carry no plan_id.
    // The assertion must treat this as unlinked, not bind to plan-a.
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'unlinked_mutate',
        task: 'create_media_buy',
        response: { media_buy_id: 'mb-new', status: 'active' },
        context: { plan_id: 'plan-a' },
      }),
    ]);
    // Unlinked mutation + plan-scoped denial (no run-wide anchor) → silent.
    expect(results[1].output).toHaveLength(0);
  });

  it('fires on check_governance status=denied (non-error denial shape)', () => {
    const results = runSequence([
      checkGovDeniedStep('plan-b'),
      mutateStep('create_media_buy', { planId: 'plan-b' }),
    ]);
    const violation = results[1].output[0];
    expect(violation.passed).toBe(false);
    expect(violation.error).toMatch(/CHECK_GOVERNANCE_DENIED/);
  });

  it('is plan-scoped — denial on plan A does not block mutation on plan B', () => {
    const results = runSequence([
      denialStep('plan-a'),
      mutateStep('create_media_buy', {
        planId: 'plan-b',
        response: { media_buy_id: 'mb-b', status: 'active' },
      }),
    ]);
    expect(results[1].output).toHaveLength(0);
  });

  it.each([
    ['GOVERNANCE_DENIED'],
    ['CAMPAIGN_SUSPENDED'],
    ['PERMISSION_DENIED'],
    ['POLICY_VIOLATION'],
    ['TERMS_REJECTED'],
    ['COMPLIANCE_UNSATISFIED'],
  ])('triggers on error code %s', (code) => {
    const results = runSequence([
      denialStep('plan-a', code),
      mutateStep('create_media_buy', { planId: 'plan-a' }),
    ]);
    expect(results[1].output[0].passed).toBe(false);
    expect(results[1].output[0].error).toMatch(new RegExp(code));
  });

  it.each([
    ['GOVERNANCE_UNAVAILABLE'],
    ['ACCOUNT_SUSPENDED'],
    ['CONFLICT'],
    ['IDEMPOTENCY_CONFLICT'],
  ])('stays silent on non-denial error code %s', (code) => {
    const results = runSequence([
      makeStep({
        step_id: 'not_denial',
        task: 'check_governance',
        expect_error: true,
        response: { code, message: 'x', plan_id: 'plan-a' },
      }),
      mutateStep('create_media_buy', { planId: 'plan-a' }),
    ]);
    expect(results[1].output).toHaveLength(0);
  });

  it('falls back to run-scoped for denial signals with no plan linkage', () => {
    const results = runSequence([
      makeStep({ step_id: 'deny', task: 'get_products', expect_error: true, response: { code: 'POLICY_VIOLATION', message: 'refused' } }),
      mutateStep('create_media_buy'),
    ]);
    const violation = results[1].output[0];
    expect(violation.passed).toBe(false);
    expect(violation.error).toMatch(/run-wide/);
  });

  it('treats rejected media_buy status as NOT acquired', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'mutate',
        task: 'create_media_buy',
        response: { media_buy_id: 'mb-rej', status: 'rejected', plan_id: 'plan-a' },
      }),
    ]);
    expect(results[1].output).toHaveLength(0);
  });

  it('ignores read tasks even if they echo back resource ids', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'read',
        task: 'get_media_buys',
        response: { media_buys: [{ media_buy_id: 'mb-existing', plan_id: 'plan-a' }] },
      }),
    ]);
    expect(results[1].output).toHaveLength(0);
  });

  it('denial state is sticky — a later passing check_governance does not clear it', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'recheck',
        task: 'check_governance',
        response: { status: 'approved', plan_id: 'plan-a' },
      }),
      mutateStep('create_media_buy', { planId: 'plan-a' }),
    ]);
    const violation = results[2].output[0];
    expect(violation.passed).toBe(false);
    expect(violation.error).toMatch(/GOVERNANCE_DENIED/);
  });

  it('records only the first anchor on a plan (subsequent denials do not shift it)', () => {
    const results = runSequence([
      denialStep('plan-a', 'GOVERNANCE_DENIED'),
      denialStep('plan-a', 'CAMPAIGN_SUSPENDED'),
      mutateStep('create_media_buy', { planId: 'plan-a' }),
    ]);
    const violation = results[2].output[0];
    expect(violation.error).toMatch(/GOVERNANCE_DENIED/);
    expect(violation.error).not.toMatch(/CAMPAIGN_SUSPENDED/);
  });

  it('counts acquire_rights as a mutation', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'acq',
        task: 'acquire_rights',
        response: { acquisition_id: 'acq-1', plan_id: 'plan-a' },
      }),
    ]);
    expect(results[1].output[0].passed).toBe(false);
  });

  it('counts activate_signal as a mutation', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'act',
        task: 'activate_signal',
        response: { activation_id: 'act-1', plan_id: 'plan-a' },
      }),
    ]);
    expect(results[1].output[0].passed).toBe(false);
  });

  it('accepts failed steps as non-mutations even when the task is write-class', () => {
    const results = runSequence([
      denialStep('plan-a'),
      makeStep({
        step_id: 'failed_mutate',
        task: 'create_media_buy',
        passed: false,
        response: { code: 'VALIDATION_ERROR', message: 'bad input', plan_id: 'plan-a' },
      }),
    ]);
    expect(results[1].output).toHaveLength(0);
  });

  it('extracts denial codes from nested error.code shapes', () => {
    const results = runSequence([
      makeStep({
        step_id: 'nested_deny',
        task: 'check_governance',
        expect_error: true,
        response: { error: { code: 'GOVERNANCE_DENIED', message: 'denied' }, plan_id: 'plan-a' },
      }),
      mutateStep('create_media_buy', { planId: 'plan-a' }),
    ]);
    expect(results[1].output[0].passed).toBe(false);
    expect(results[1].output[0].error).toMatch(/GOVERNANCE_DENIED/);
  });

  it('onStart resets runDenial so stale state does not bleed across runs', () => {
    const ctx = makeCtx();
    // Seed stale state as if from a prior run.
    ctx.state.runDenial = { stepId: 'stale', signal: 'STALE' };
    governanceSpec.onStart?.(ctx);
    const out = governanceSpec.onStep!(ctx, mutateStep('create_media_buy'));
    expect(out).toHaveLength(0);
  });
});
