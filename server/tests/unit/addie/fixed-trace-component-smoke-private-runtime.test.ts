import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixedTraceComponentSmokeAdmission } from '../../../src/addie/eval/fixed-trace-component-smoke-admission.js';
import {
  FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM,
  FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION,
  fixedTraceComponentSmokeSignedGrantBytes,
  type FixedTraceComponentSmokeSignedGrantPayload,
} from '../../../src/addie/eval/fixed-trace-component-smoke-private-authorization.js';
import { fixedTraceComponentSmokePrivateLedgerPlan, type FixedTraceComponentSmokeReservation } from '../../../src/addie/eval/fixed-trace-component-smoke-private-ledger.js';
import { createFixedTraceComponentSmokePrivateRuntime, type FixedTraceComponentSmokeFakeProviderRequest } from '../../../src/addie/eval/fixed-trace-component-smoke-private-runtime.js';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const root = Object.freeze({ kid: 'component-smoke-runtime-test', spki: (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url') });
const rootPin = createHash('sha256').update(JSON.stringify(root), 'utf8').digest('hex');
const plan = fixedTraceComponentSmokePrivateLedgerPlan()!;

function signedGrant(overrides: Partial<FixedTraceComponentSmokeSignedGrantPayload> = {}) {
  const admission = fixedTraceComponentSmokeAdmission();
  const payload: FixedTraceComponentSmokeSignedGrantPayload = {
    grantVersion: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_VERSION, kid: root.kid,
    issuedAt: '2026-09-06T11:55:00.000Z', expiresAt: '2026-09-06T12:05:00.000Z', stageId: 'stage_1_smoke',
    admissionVersion: admission.version, aggregateAdmissionFingerprint: admission.fingerprints.aggregateAdmission,
    cardinality: admission.cardinality, reservationMicrodollars: 2_819_484, providerCeilingMicrodollars: 5_000_000,
    pricingCohortDigest: admission.pricing.cohortDigest!, nonceCommitment: 'a'.repeat(64), ...overrides,
  };
  return { algorithm: FIXED_TRACE_COMPONENT_SMOKE_SIGNED_GRANT_ALGORITHM, payload, signature: sign(null, fixedTraceComponentSmokeSignedGrantBytes(payload), keys.privateKey).toString('base64url') };
}

function reservationFor(authorizationDigest: string): FixedTraceComponentSmokeReservation {
  return Object.freeze({ authorizationDigest,
    reservationId: `reservation_${createHash('sha256').update(JSON.stringify({ authorizationDigest, domain: 'adcp:addie:fixed-trace-component-smoke:reservation:v1\0' }), 'utf8').digest('hex').slice(0, 32)}`,
    entryCount: 168, providerDispatchEntryCount: 126, reservationMicrodollars: 2_819_484 });
}

class FakeLedger {
  readonly calls: string[] = [];
  readonly intents: Array<Record<string, unknown>> = [];
  readonly terminals: Array<Record<string, unknown>> = [];
  readonly assignmentTerminals: Array<Record<string, unknown>> = [];
  readonly nonDispatch: Array<Record<string, unknown>> = [];
  readonly omitted: Array<Record<string, unknown>> = [];
  reserveCalls = 0;
  failIntent = false;
  failTerminal = false;
  terminalRefusal: string | null = null;
  async reserveAndConsume(grant: object) { this.reserveCalls += 1; return this.reserveCalls === 1 ? { status: 'reserved', reservation: reservationFor((grant as { grantDigest: string }).grantDigest) } : { status: 'refused', reason: 'grant_already_consumed' }; }
  async recordProviderIntent(value: object) { this.calls.push('intent'); this.intents.push(value as Record<string, unknown>); return this.failIntent ? { status: 'refused', reason: 'persistence_uncertain' } : { status: 'recorded' }; }
  async recordTerminal(value: object) { this.calls.push('terminal'); this.terminals.push(value as Record<string, unknown>); return this.failTerminal || this.terminalRefusal ? { status: 'refused', reason: this.terminalRefusal ?? 'persistence_uncertain' } : { status: 'recorded' }; }
  async recordProviderAssignmentTerminal(value: object) { this.calls.push('assignment'); this.assignmentTerminals.push(value as Record<string, unknown>); return { status: 'recorded' }; }
  async recordNonDispatchTerminal(value: object) { this.calls.push('local'); this.nonDispatch.push(value as Record<string, unknown>); return { status: 'recorded' }; }
  async recordNotExecutedAfterHalt(value: object) { this.calls.push('omitted'); this.omitted.push(value as Record<string, unknown>); return { status: 'recorded' }; }
  async recordUnknownExposure() { this.calls.push('unknown'); return { status: 'recorded' }; }
}

function runtime(ledger: FakeLedger, fakeProvider: { invoke(request: Readonly<FixedTraceComponentSmokeFakeProviderRequest>): Promise<unknown> }, grant = signedGrant(), pin = rootPin) {
  return createFixedTraceComponentSmokePrivateRuntime({ trustRoot: root, trustRootPin: pin, signedGrant: grant, evidenceHmacKey: Buffer.alloc(32, 7), trustedNow: () => NOW, ledger, fakeProvider: { fakeOnly: true, automaticRetries: 0, ...fakeProvider } });
}
function receipt(request: FixedTraceComponentSmokeFakeProviderRequest, disposition: 'final_response' | 'tool_continuation_required' = 'final_response') {
  return { status: 'succeeded', disposition, identity: { provider: request.provider, model: request.model, effort: request.effort }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 0 } };
}

describe('private fake-only component smoke runtime', () => {
  it('runs only the frozen 8-by-21 plan, commits intent before each fake call, and reaches the exact maximum', async () => {
    const ledger = new FakeLedger(); const seen: FixedTraceComponentSmokeFakeProviderRequest[] = [];
    const subject = runtime(ledger, { async invoke(request) { seen.push(request); return receipt(request, request.invocationOrdinal === 1 && plan.find((entry) => entry.assignmentId === request.assignmentId)!.maximumProviderInvocations === 2 ? 'tool_continuation_required' : 'final_response'); } });
    const result = await subject!.run();
    expect(result).toEqual({ status: 'completed', assignmentDispositions: 168, providerInvocations: 192 });
    expect(seen).toHaveLength(192); expect(ledger.intents).toHaveLength(192); expect(ledger.terminals).toHaveLength(192);
    expect(ledger.assignmentTerminals).toHaveLength(126); expect(ledger.nonDispatch).toHaveLength(42);
    expect(ledger.calls.every((call, index) => call !== 'terminal' || ledger.calls[index - 1] === 'intent')).toBe(true);
    expect(new Set(ledger.intents.map((entry) => entry.preparedRequestHmac))).toHaveLength(192);
    expect(new Set(ledger.terminals.map((entry) => entry.responseHmac))).toHaveLength(192);
    expect(seen.every((request) => request.sdkAutomaticRetries === 0)).toBe(true);
  });

  it('requires an exact operator root/pin and consumes a verified grant through the ledger once', async () => {
    const ledger = new FakeLedger();
    expect(runtime(ledger, { async invoke(request) { return receipt(request); } }, signedGrant(), '0'.repeat(64))).toBeNull();
    const invalid = runtime(ledger, { async invoke(request) { return receipt(request); } }, { ...signedGrant(), signature: 'A'.repeat(86) });
    await expect(invalid!.run()).resolves.toMatchObject({ status: 'refused', reason: 'invalid_grant', providerInvocations: 0 });
    const oneShot = runtime(ledger, { async invoke(request) { return receipt(request); } })!;
    await oneShot.run();
    await expect(oneShot.run()).resolves.toMatchObject({ status: 'refused', reason: 'grant_already_consumed', providerInvocations: 0 });
    expect(ledger.reserveCalls).toBe(2);
  });

  it.each([
    ['provider throw', async () => { throw new Error('private fake failure'); }, 'timeout_after_dispatch'],
    ['malformed response', async () => ({ wrong: true }), 'malformed_response'],
    ['missing usage', async (request: FixedTraceComponentSmokeFakeProviderRequest) => ({ ...receipt(request), usage: null }), 'missing_usage'],
    ['identity mismatch', async (request: FixedTraceComponentSmokeFakeProviderRequest) => ({ ...receipt(request), identity: { provider: 'other', model: request.model, effort: request.effort } }), 'identity_mismatch'],
    ['provider failure', async (request: FixedTraceComponentSmokeFakeProviderRequest) => ({ ...receipt(request), status: 'provider_failed', disposition: 'final_response' }), 'provider_failed'],
  ])('halts and terminalizes the denominator after %s without another provider call', async (_name, invoke, expectedStatus) => {
    const ledger = new FakeLedger(); let calls = 0;
    const subject = runtime(ledger, { async invoke(request) { calls += 1; return invoke(request); } })!;
    await expect(subject.run()).resolves.toEqual({ status: 'halted', assignmentDispositions: 168, providerInvocations: 1 });
    expect(calls).toBe(1); expect(ledger.terminals[0]?.status).toBe(expectedStatus);
    expect(ledger.assignmentTerminals).toHaveLength(1);
    expect(ledger.assignmentTerminals.length + ledger.nonDispatch.length + ledger.omitted.length).toBe(168);
  });

  it('does not call a fake provider after an uncertain intent or terminal write', async () => {
    for (const field of ['failIntent', 'failTerminal'] as const) {
      const ledger = new FakeLedger(); ledger[field] = true; let calls = 0;
      const subject = runtime(ledger, { async invoke(request) { calls += 1; return receipt(request); } })!;
      await expect(subject.run()).resolves.toEqual({ status: 'halted', assignmentDispositions: 168, providerInvocations: field === 'failIntent' ? 0 : 1 });
      expect(calls).toBe(field === 'failIntent' ? 0 : 1); expect(ledger.calls).toContain('unknown');
    }
  });

  it.each(['plan_mismatch', 'cost_exhausted'])('stops after a ledger %s settlement refusal', async (reason) => {
    const ledger = new FakeLedger(); ledger.terminalRefusal = reason; let calls = 0;
    const subject = runtime(ledger, { async invoke(request) { calls += 1; return receipt(request); } })!;
    await expect(subject.run()).resolves.toEqual({ status: 'halted', assignmentDispositions: 168, providerInvocations: 1 });
    expect(calls).toBe(1); expect(ledger.calls).toContain('unknown');
  });

  it('never advances past a duplicate/final continuation ordinal', async () => {
    const ledger = new FakeLedger(); let calls = 0;
    const subject = runtime(ledger, { async invoke(request) { calls += 1; return receipt(request, 'tool_continuation_required'); } })!;
    await expect(subject.run()).resolves.toEqual({ status: 'halted', assignmentDispositions: 168, providerInvocations: 1 });
    expect(calls).toBe(1); expect(ledger.calls).toContain('unknown');
  });

  it('has no ambient wiring, no caller execution controls, and no raw secret or provider data persistence/logging surface', () => {
    const source = readFileSync(new URL('../../../src/addie/eval/fixed-trace-component-smoke-private-runtime.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('process.env'); expect(source).not.toContain('fetch('); expect(source).not.toContain('console.');
    expect(source).not.toContain('from \'../../db/client'); expect(source).not.toContain('prompt:'); expect(source).not.toContain('apiKey');
    expect(createFixedTraceComponentSmokePrivateRuntime({} as never)).toBeNull();
    expect(createFixedTraceComponentSmokePrivateRuntime).toBeTypeOf('function');
  });
});
