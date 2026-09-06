import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY, fixedTraceComponentSmokePrivateAuthorityPlan } from '../../../src/addie/eval/fixed-trace-component-smoke-private-authority.js';
import {
  createFixedTraceComponentSmokePrivateRuntime,
  simulateFixedTraceComponentSmokePrivateRuntime,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-runtime.js';

const plan = fixedTraceComponentSmokePrivateAuthorityPlan();
const dispatch = plan.find((entry) => entry.disposition === 'provider_dispatch')!;
const generation = plan.find((entry) => entry.disposition === 'provider_dispatch' && entry.maximumProviderInvocations === 2)!;

function receipt(entry = dispatch, overrides: Record<string, unknown> = {}) {
  return {
    status: 'succeeded', disposition: 'final_response',
    identity: { provider: entry.provider, model: entry.model, effort: entry.effort },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 },
    ...overrides,
  };
}
function scriptFor(key: string, value: unknown) { return JSON.stringify({ responses: { [key]: value } }); }

describe('private fake-only component smoke runtime', () => {
  it('has no production construction path or runtime dependency injection', () => {
    expect(createFixedTraceComponentSmokePrivateRuntime()).toBeNull();
    expect((createFixedTraceComponentSmokePrivateRuntime as (...value: unknown[]) => unknown)({}, {}, {}, {})).toBeNull();
  });

  it('simulates only the frozen 8-by-21 plan and exact 192 maximum without dispatch', () => {
    expect(simulateFixedTraceComponentSmokePrivateRuntime()).toEqual({ status: 'completed', assignmentDispositions: 168, providerInvocations: 192 });
  });

  it('models the frozen second ordinal only after its scripted first continuation', () => {
    const first = `${generation.assignmentId}:1`;
    expect(simulateFixedTraceComponentSmokePrivateRuntime(scriptFor(first, receipt(generation, { disposition: 'final_response' })))).toEqual({ status: 'halted', assignmentDispositions: 168, providerInvocations: 191 });
    expect(simulateFixedTraceComponentSmokePrivateRuntime(scriptFor(first, receipt(generation, { disposition: 'tool_continuation_required' })))).toEqual({ status: 'completed', assignmentDispositions: 168, providerInvocations: 192 });
  });

  it.each([
    ['identity mismatch', receipt(dispatch, { identity: { provider: 'other', model: dispatch.model, effort: dispatch.effort } })],
    ['provider failure', receipt(dispatch, { status: 'provider_failed' })],
    ['final continuation ordinal', receipt(dispatch, { disposition: 'tool_continuation_required' })],
  ])('halts the simulated denominator after %s', (_name, value) => {
    expect(simulateFixedTraceComponentSmokePrivateRuntime(scriptFor(`${dispatch.assignmentId}:1`, value))).toEqual({ status: 'halted', assignmentDispositions: 168, providerInvocations: 1 });
  });

  it('deep-copies and rejects executable, malformed, or unadmitted simulation data without running it', () => {
    let invoked = false;
    const executable = { responses: { [`${dispatch.assignmentId}:1`]: () => { invoked = true; return receipt(); } } };
    for (const script of [
      executable,
      { responses: { [`${dispatch.assignmentId}:3`]: receipt() } },
      { responses: { [`${dispatch.assignmentId}:1`]: { wrong: true } } },
      { trustRoot: 'caller-selected' },
      '{not-json',
      JSON.stringify({ responses: { [`${dispatch.assignmentId}:3`]: receipt() } }),
      JSON.stringify({ responses: { [`${dispatch.assignmentId}:1`]: { wrong: true } } }),
    ]) expect(simulateFixedTraceComponentSmokePrivateRuntime(script as never)).toEqual({ status: 'refused', reason: 'invalid_simulation_script', assignmentDispositions: 0, providerInvocations: 0 });
    expect(invoked).toBe(false);
  });

  it('contains no dispatch, persistence, authorization input, provider callback, or ambient configuration surface', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-runtime.ts', import.meta.url), 'utf8');
    for (const forbidden of ['process.env', 'fetch(', 'console.', 'fakeProvider', '.invoke(', 'trustRoot', 'signedGrant', 'evidenceHmacKey', 'recordProviderIntent', 'recordTerminal']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/from ['"][^'"]*(?:dated-pricing-cohort|fixed-trace-component-smoke-admission|config\/models|model-providers|storyboard)[^'"]*['"]/);
  });

  it('imports the complete private runtime graph in fresh processes without model/provider env authority or side effects', () => {
    const runtimeUrl = new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-runtime.ts', import.meta.url).href;
    const authorityUrl = new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-authority.ts', import.meta.url).href;
    const source = `import { simulateFixedTraceComponentSmokePrivateRuntime } from '${runtimeUrl}'; import { FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY } from '${authorityUrl}'; process.stdout.write(JSON.stringify({ fingerprint: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint, reservation: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.reservationMicrodollars, result: simulateFixedTraceComponentSmokePrivateRuntime() }));`;
    const run = (environment: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...environment },
    });
    const baseline = run({});
    const overridden = run({
      CLAUDE_MODEL_FAST: 'unreviewed-fast', CLAUDE_MODEL_PRIMARY: 'unreviewed-primary', OPENAI_API_KEY: 'not-a-real-key',
      ANTHROPIC_API_KEY: 'not-a-real-key', GEMINI_API_KEY: 'not-a-real-key', OPENAI_MODEL: 'unreviewed-openai', GEMINI_MODEL_FAST: 'unreviewed-google',
    });
    for (const child of [baseline, overridden]) {
      expect(child.status, child.stderr).toBe(0); expect(child.stderr).toBe(''); expect(child.stdout).not.toContain('Loaded test kit'); expect(child.stdout).not.toContain('\n');
    }
    expect(overridden.stdout).toBe(baseline.stdout);
    expect(JSON.parse(baseline.stdout)).toEqual({
      fingerprint: '731930c18475672a0ec6b44c9ff91fa89d30c441e34af32b536a28258271077d', reservation: 2_819_484,
      result: { status: 'completed', assignmentDispositions: 168, providerInvocations: 192 },
    });
  });
});
