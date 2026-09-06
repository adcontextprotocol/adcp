import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY,
  fixedTraceComponentSmokePrivateAuthorityPlan,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-authority.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_DEFAULT_OFF,
  FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_SDK_RETRIES,
  createFixedTraceComponentSmokeInertAdapterFixturesForTest,
  createFixedTraceComponentSmokePrivateLiveCoordinator,
  createFixedTraceComponentSmokePrivateLiveCoordinatorForTest,
  type FixedTraceComponentSmokeInertProviderReceipt,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-live.js';

const plan = fixedTraceComponentSmokePrivateAuthorityPlan();
const one = (provider: 'anthropic' | 'openai' | 'google') => plan.find((entry) => entry.disposition === 'provider_dispatch' && entry.provider === provider)!;
const fixtureKey = (entry: typeof plan[number]) => `${FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint}:${entry.model}:${entry.effort}`;

function receipt(entry = one('anthropic'), overrides: Partial<FixedTraceComponentSmokeInertProviderReceipt> = {}): FixedTraceComponentSmokeInertProviderReceipt {
  return {
    status: 'succeeded', responseDisposition: 'final_response', responseHmac: 'a'.repeat(64),
    returnedIdentity: { provider: entry.provider, model: entry.model, effort: entry.effort },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 1 },
    ...overrides,
  };
}
function fixtures(overrides: Record<string, FixedTraceComponentSmokeInertProviderReceipt> = {}) {
  return Object.fromEntries(['anthropic', 'openai', 'google'].map((provider) => {
    const entry = one(provider as 'anthropic' | 'openai' | 'google');
    const key = fixtureKey(entry);
    return [key, overrides[key] ?? receipt(entry)];
  }));
}
function allFixtures() {
  return Object.fromEntries(plan.filter((entry) => entry.disposition === 'provider_dispatch').map((entry) => [
    fixtureKey(entry),
    receipt(entry),
  ]));
}
function coordinatorLedger() {
  const calls: string[] = [];
  let consumed = false;
  const reservation = { reservationId: `reservation_${'b'.repeat(32)}`, authorizationDigest: 'c'.repeat(64), entryCount: 168, providerDispatchEntryCount: 126, reservationMicrodollars: 2_819_484 } as const;
  return {
    calls,
    ledger: {
      reserveAndConsume: async () => {
        calls.push('reserve');
        if (consumed) return { status: 'refused' as const, reason: 'grant_already_consumed' as const };
        consumed = true;
        return { status: 'reserved' as const, reservation };
      },
      recordProviderIntent: async (value: { attemptId: string }) => { calls.push(`intent:${value.attemptId}`); return { status: 'recorded' as const }; },
      recordTerminal: async (value: { attemptId: string }) => { calls.push(`terminal:${value.attemptId}`); return { status: 'recorded' as const }; },
      recordUnknownExposure: async () => { calls.push('unknown'); return { status: 'recorded' as const }; },
      recordNonDispatchTerminal: async () => { calls.push('non-dispatch'); return { status: 'recorded' as const }; },
      recordProviderAssignmentTerminal: async () => { calls.push('assignment'); return { status: 'recorded' as const }; },
    },
  };
}
function testGrant() {
  return { grantDigest: 'd'.repeat(64), signedPayloadDigest: 'e'.repeat(64), payload: {} } as never;
}

describe('private live component-smoke composition', () => {
  it('leaves the production coordinator hard-null and uses no ambient enablement', () => {
    expect(FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_DEFAULT_OFF).toBe(true);
    expect(FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_SDK_RETRIES).toBe(0);
    expect(createFixedTraceComponentSmokePrivateLiveCoordinator()).toBeNull();
    expect((createFixedTraceComponentSmokePrivateLiveCoordinator as (...args: unknown[]) => unknown)({}, {}, {}, {})).toBeNull();
  });

  it.each(['anthropic', 'openai', 'google'] as const)('builds a frozen admitted %s request only from the immutable plan', (provider) => {
    const entry = one(provider);
    const harness = createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures());
    const request = harness.requestForTest(entry.assignmentId);
    expect(request).toMatchObject({ model: entry.model, maxOutputTokens: entry.maxOutputTokens, reasoning: { effort: entry.effort } });
    expect(request.requestMetadata).toEqual({ fixedTraceAdmissionFingerprint: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_AUTHORITY.aggregateAdmissionFingerprint });
    expect(Object.isFrozen(request)).toBe(true);
    expect(request.tools.map((tool) => tool.name)).toEqual(
      expect.any(Array),
    );
  });

  it.each(['anthropic', 'openai', 'google'] as const)('accepts a pure inert %s response fixture with exact identity and usage shape', async (provider) => {
    const entry = one(provider);
    const harness = createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures());
    await expect(harness.invokeForTest(entry.assignmentId)).resolves.toEqual(receipt(entry));
  });

  it('categorizes timeout and identity-drift receipts without recording a raw provider error or response', async () => {
    const entry = one('openai');
    const key = fixtureKey(entry);
    const timeout = receipt(entry, { status: 'timeout_after_dispatch', responseDisposition: null, responseHmac: null, returnedIdentity: null, usage: null });
    await expect(createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures({ [key]: timeout })).invokeForTest(entry.assignmentId)).resolves.toEqual(timeout);
    const mismatchedIdentity = receipt(entry, { returnedIdentity: { provider: 'other', model: entry.model, effort: entry.effort } });
    await expect(createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures({ [key]: mismatchedIdentity })).invokeForTest(entry.assignmentId)).resolves.toEqual(mismatchedIdentity);
  });

  it('refuses absent, malformed, and missing-usage fixture receipts before a transport exists', async () => {
    const entry = one('openai');
    const key = fixtureKey(entry);
    expect(() => createFixedTraceComponentSmokeInertAdapterFixturesForTest({ [key]: { bad: true } } as never)).toThrow('invalid inert provider fixture');
    expect(() => createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures({ [key]: receipt(entry, { usage: null }) }))).toThrow('invalid inert provider fixture');
    const absent = createFixedTraceComponentSmokeInertAdapterFixturesForTest({});
    await expect(absent.invokeForTest(entry.assignmentId)).rejects.toThrow('missing inert provider fixture');
  });

  it('has no production provider construction, generic dispatch, root, credential, persistence, or raw-output surface', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-live.ts', import.meta.url), 'utf8');
    for (const forbidden of ['process.env', 'fetch(', 'console.', 'new OpenAI', 'new Anthropic', 'new GoogleGenAI', 'apiKey', 'trustRoot', 'privateKey', 'from "../config/models', 'from \'../config/models']) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain('WeakSet');
    expect(source).toContain('recordProviderIntent');
    expect(source).toContain('recordUnknownExposure');
    expect(source).toContain('maxRetries: FIXED_TRACE_COMPONENT_SMOKE_PRIVATE_LIVE_SDK_RETRIES');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('fixedTraceComponentSmokePrivateAuthorityMatchesAdmission');
  });

  it('cannot mutate the authority plan through the composition request path', () => {
    const entry = one('google');
    const before = JSON.stringify(fixedTraceComponentSmokePrivateAuthorityPlan());
    const harness = createFixedTraceComponentSmokeInertAdapterFixturesForTest(fixtures());
    const request = harness.requestForTest(entry.assignmentId);
    expect(() => { (request as { model: string }).model = 'other'; }).toThrow();
    expect(JSON.stringify(fixedTraceComponentSmokePrivateAuthorityPlan())).toBe(before);
    expect(() => harness.requestForTest('0'.repeat(64))).toThrow('unadmitted provider assignment');
  });

  it('commits every intent before its inert response, closes the 168-entry plan, and is one-shot', async () => {
    const { ledger, calls } = coordinatorLedger();
    const harness = createFixedTraceComponentSmokePrivateLiveCoordinatorForTest({ ledger, grant: testGrant(), fixtures: allFixtures() });
    await expect(harness.runForTest()).resolves.toEqual({ status: 'completed', providerInvocations: 126 });
    expect(calls.filter((call) => call.startsWith('intent:'))).toHaveLength(126);
    expect(calls.filter((call) => call.startsWith('terminal:'))).toHaveLength(126);
    expect(calls.filter((call) => call === 'assignment')).toHaveLength(126);
    expect(calls.filter((call) => call === 'non-dispatch')).toHaveLength(42);
    for (const [index, call] of calls.entries()) if (call.startsWith('terminal:')) {
      expect(calls.slice(0, index)).toContain(`intent:${call.slice('terminal:'.length)}`);
    }
    await expect(harness.runForTest()).resolves.toEqual({ status: 'halted', providerInvocations: 0 });
  });

  it('halts after a post-intent fixture fault and atomically requests ambiguity closure instead of retrying', async () => {
    const { ledger, calls } = coordinatorLedger();
    const first = plan.find((entry) => entry.disposition === 'provider_dispatch')!;
    const harness = createFixedTraceComponentSmokePrivateLiveCoordinatorForTest({ ledger, grant: testGrant(), fixtures: {
      [fixtureKey(first)]: receipt(first),
    } });
    await expect(harness.runForTest()).resolves.toEqual({ status: 'halted', providerInvocations: 1 });
    expect(calls.filter((call) => call.startsWith('intent:'))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('terminal:'))).toHaveLength(1);
    expect(calls.filter((call) => call === 'unknown')).toHaveLength(1);
  });
});
